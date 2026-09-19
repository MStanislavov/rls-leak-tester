/**
 * Builds the body of `POST /api/explain` in the browser (brief 3.7): the minimum the model needs
 * to explain ONE failing cell. Pure, deterministic, and it never reads `seedSql` or `schemaSql`:
 * the table's DDL is rendered from the catalog, and of the rows only capped samples of primary
 * keys leave the tab. Sub-probe statements stay behind too, because an insert probe inlines the
 * values of a cloned row.
 */
import type { Finding } from "@/lib/checks";
import { findTable, PUBLIC_ROLE, type Catalog, type CatalogColumn } from "@/lib/runner/introspect";
import { claimsJsonOf } from "@/lib/runner/plan";
import type { CellResult } from "@/lib/runner/result";
import { privilegeRolesOf } from "@/lib/runner/roles";
import {
  compareText,
  qualifiedName,
  quoteIdent,
  resolveTableConfigs,
  type Scenario,
} from "@/lib/scenario";
import {
  EXPLAIN_PAYLOAD_MAX_BYTES,
  EXPLAIN_REQUEST_VERSION,
  FAILING_STATUSES,
  MAX_FINDINGS,
  MAX_FINDING_EVIDENCE,
  MAX_GRANTS,
  MAX_KEY_SAMPLE,
  MAX_POLICIES,
  MAX_SUB_PROBES,
  explainRequestSchema,
  utf8ByteLength,
  type ExplainFinding,
  type ExplainKeyList,
  type ExplainRequest,
  type FailingStatus,
} from "./schema";

export type BuildExplainRequestResult =
  | { readonly ok: true; readonly request: ExplainRequest; readonly bytes: number }
  | {
      readonly ok: false;
      /**
       * `not-failing`: Explain is offered on leak, escape and overblock only. `unknown-table` and
       * `unknown-persona`: the cell does not belong to this catalog or scenario. `too-large`: the
       * table's own DDL and policies exceed the payload cap or a field limit.
       */
      readonly reason: "not-failing" | "unknown-table" | "unknown-persona" | "too-large";
    };

function isFailing(status: CellResult["status"]): status is FailingStatus {
  return (FAILING_STATUSES as readonly string[]).includes(status);
}

function renderColumn(column: CatalogColumn): string {
  const parts = [quoteIdent(column.name), column.type];
  if (column.generated !== null) {
    parts.push(`generated always as (${column.generationExpression ?? ""}) ${column.generated}`);
  } else if (column.identity !== null) {
    parts.push(`generated ${column.identity} as identity`);
  } else if (column.default !== null) {
    parts.push(`default ${column.default}`);
  }
  if (column.notNull) {
    parts.push("not null");
  }
  return `  ${parts.join(" ")}`;
}

/** Pure: a `create table` that describes the catalog entry. Not the user's text, and no rows. */
export function renderTableDdl(table: NonNullable<ReturnType<typeof findTable>>): string {
  const target = qualifiedName(table.schema, table.name);
  const lines = [...table.columns]
    .sort((a, b) => a.position - b.position)
    .map((column) => renderColumn(column));
  if (table.primaryKey.length > 0) {
    lines.push(
      `  primary key (${table.primaryKey.map((column) => quoteIdent(column)).join(", ")})`,
    );
  }
  const statements = [
    `create table ${target} (\n${lines.join(",\n")}\n)${table.partitioned ? " /* partitioned */" : ""};`,
    `alter table ${target} owner to ${quoteIdent(table.owner)};`,
  ];
  if (table.rlsEnabled) {
    statements.push(`alter table ${target} enable row level security;`);
  }
  if (table.rlsForced) {
    statements.push(`alter table ${target} force row level security;`);
  }
  return statements.join("\n");
}

function keyList(keys: readonly string[], sampleSize: number): ExplainKeyList {
  return { total: keys.length, sample: keys.slice(0, sampleSize) };
}

function grantsFor(catalog: Catalog, cell: CellResult, dbRole: string): string[] {
  const grantees = new Set([...privilegeRolesOf(catalog, dbRole), PUBLIC_ROLE]);
  const privileges = catalog.tablePrivileges
    .filter(
      (grant) =>
        grant.schema === cell.schema && grant.table === cell.table && grantees.has(grant.grantee),
    )
    .map((grant) => grant.privilege);
  return [...new Set(privileges)].sort(compareText).slice(0, MAX_GRANTS);
}

/**
 * Every policy on the table, not only the ones that applied: a policy written for another role or
 * command is often the explanation of an overblock. `appliesAs` says how the engine used it.
 */
function tablePolicies(catalog: Catalog, cell: CellResult): ExplainRequest["policies"] {
  const applied = new Map(cell.policies.map((policy) => [policy.name, policy.appliesAs]));
  return catalog.policies
    .filter((policy) => policy.schema === cell.schema && policy.table === cell.table)
    .slice(0, MAX_POLICIES)
    .map((policy) => ({
      name: policy.name,
      command: policy.command,
      permissive: policy.permissive,
      roles: [...policy.roles],
      using: policy.using,
      withCheck: policy.withCheck,
      appliesAs: applied.get(policy.name) ?? "none",
    }));
}

function relatedFindings(
  findings: readonly Finding[],
  cell: CellResult,
  withEvidence: boolean,
): ExplainFinding[] {
  return findings
    .filter(
      (finding) =>
        finding.object.schema === cell.schema &&
        (finding.object.table ?? finding.object.name) === cell.table &&
        (finding.object.kind === "table" || finding.object.kind === "policy"),
    )
    .slice(0, MAX_FINDINGS)
    .map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      object: finding.object.qualifiedName,
      explanation: finding.explanation,
      evidence: withEvidence
        ? finding.evidence.slice(0, MAX_FINDING_EVIDENCE).map(({ label, value }) => ({
            label,
            value,
          }))
        : [],
    }));
}

interface Shrink {
  readonly keySample: number;
  readonly findings: "full" | "no-evidence" | "none";
}

/** Tried in order until the body fits. The DDL and the policies are never cut. */
const SHRINK_STEPS: readonly Shrink[] = [
  { keySample: MAX_KEY_SAMPLE, findings: "full" },
  { keySample: MAX_KEY_SAMPLE, findings: "no-evidence" },
  { keySample: 5, findings: "no-evidence" },
  { keySample: 5, findings: "none" },
];

/**
 * `findings` is the whole list of the static checks; the ones on this cell's table are picked
 * here. The result is validated against the request schema and measured against the payload cap,
 * so a body this function returns is one the route accepts.
 */
export function buildExplainRequest(
  cell: CellResult,
  catalog: Catalog,
  scenario: Scenario,
  findings: readonly Finding[],
): BuildExplainRequestResult {
  if (!isFailing(cell.status)) {
    return { ok: false, reason: "not-failing" };
  }
  const table = findTable(catalog, cell.schema, cell.table);
  if (table === undefined) {
    return { ok: false, reason: "unknown-table" };
  }
  const persona = scenario.personas.find((candidate) => candidate.id === cell.personaId);
  if (persona === undefined) {
    return { ok: false, reason: "unknown-persona" };
  }
  const tableConfig = resolveTableConfigs(scenario.tables, [
    { schema: table.schema, name: table.name, columns: table.columns.map(({ name }) => name) },
  ])[0];
  const expectation = scenario.expectations.find(
    (candidate) =>
      candidate.personaId === cell.personaId &&
      candidate.schema === cell.schema &&
      candidate.table === cell.table &&
      candidate.operation === cell.operation,
  );

  for (const step of SHRINK_STEPS) {
    const candidate: ExplainRequest = {
      version: EXPLAIN_REQUEST_VERSION,
      mode: scenario.mode,
      cell: {
        operation: cell.operation,
        status: cell.status,
        scope: cell.scope,
        expectationSource: cell.expectationSource,
        expectedRowsSql: cell.scope === "custom" ? (expectation?.expectedRowsSql ?? null) : null,
        reason: cell.reason,
        statement: cell.statement,
        perRowFallback: cell.perRowFallback,
        error: cell.error,
        rlsBypass: cell.rlsBypass,
        subProbes: cell.subProbes.slice(0, MAX_SUB_PROBES).map((probe) => ({
          kind: probe.kind,
          expected: probe.expected,
          outcome: probe.outcome,
          status: probe.status,
          reason: probe.reason,
          error: probe.error,
        })),
      },
      table: {
        schema: table.schema,
        name: table.name,
        ddl: renderTableDdl(table),
        owner: table.owner,
        rlsEnabled: table.rlsEnabled,
        rlsForced: table.rlsForced,
        ownerColumn: tableConfig?.ownerColumn ?? null,
        tenantColumn: tableConfig?.tenantColumn ?? null,
        grants: grantsFor(catalog, cell, persona.dbRole),
      },
      policies: tablePolicies(catalog, cell),
      persona: {
        dbRole: persona.dbRole,
        claimsJson: claimsJsonOf(persona, scenario.mode),
        tenantClaimPath: persona.tenantClaimPath ?? null,
      },
      keys: {
        expected: keyList(cell.expectedKeys, step.keySample),
        actual: keyList(cell.actualKeys, step.keySample),
        leaked: keyList(cell.leakedKeys, step.keySample),
        missing: keyList(cell.missingKeys, step.keySample),
        blind: keyList(cell.blindKeys, step.keySample),
      },
      findings:
        step.findings === "none" ? [] : relatedFindings(findings, cell, step.findings === "full"),
    };
    const parsed = explainRequestSchema.safeParse(candidate);
    const bytes = utf8ByteLength(JSON.stringify(candidate));
    if (parsed.success && bytes <= EXPLAIN_PAYLOAD_MAX_BYTES) {
      return { ok: true, request: parsed.data, bytes };
    }
  }
  return { ok: false, reason: "too-large" };
}
