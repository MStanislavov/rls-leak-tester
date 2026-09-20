/**
 * Renders `rls-isolation.test.sql` from cell plans. Plain SQL: no pgTAP, no psql meta-command, so
 * the same file runs with `psql -v ON_ERROR_STOP=1 -f` and through PGlite's `exec`.
 *
 * Layout: header, session (the runner's `RESET_SESSION`), the runtime functions, a preflight
 * (roles, tables, seed), one `DO` block per cell, the verdict. A cell that cannot be probed is a
 * comment with its reason. Byte-identical for the same input.
 *
 * The preflight is what makes a green run mean something on a database that is not the exported
 * one: a table the exported run did not have fails the run (the file has no cell for it), and a
 * table whose rows are not the exported ones fails the run WITHOUT running its cells (literal
 * keys compared with other rows would print leaks that do not exist).
 */
import { RESET_SESSION, parseKey } from "@/lib/runner";
import { quoteLiteral } from "@/lib/scenario";
import type { CellPlan, RowStatement, UpdateCellPlan } from "./cell-plan";
import {
  EMPTY_REPORT,
  REPORT_SETTING,
  dropRuntimeSql,
  runtimeName,
  runtimeSql,
  type RuntimeFunction,
} from "./runtime";
import {
  commentLine,
  dollarQuote,
  jsonbLiteral,
  keysLiteral,
  statementArray,
  textArray,
} from "./sql-text";

export const CORE_PRINCIPLE =
  "Every pass, leak and verdict in this file comes from executing SQL and comparing row sets. No language model decides anything here.";

/** A seeded table whose keys the preflight compares with the keys this file was exported for. */
export interface SeedCheck {
  /** `schema.table`, for the message. */
  readonly table: string;
  readonly keyColumns: number;
  /** As the superuser: every key of the table. */
  readonly readKeys: string;
  readonly truthKeys: readonly string[];
  /**
   * What the generator knows about keys that no second load reproduces (a volatile default the
   * seed relies on), as a sentence for the failure message; `null` when it knows nothing.
   */
  readonly volatile: string | null;
}

export interface TestSqlInput {
  readonly toolName: string;
  readonly scenarioTitle: string;
  readonly scenarioId: string;
  /** One line: the mode and, in supabase mode, the grants regime. */
  readonly regime: string;
  readonly plans: readonly CellPlan[];
  readonly roles: readonly string[];
  /** The exposed schemas of the scenario: a table in one of them must be a table of `tables`. */
  readonly exposedSchemas: readonly string[];
  /** Every table of the exported run, probed or not: `[schema, table]`. */
  readonly tables: readonly (readonly [schema: string, table: string])[];
  readonly seedChecks: readonly SeedCheck[];
  readonly maxParams: number;
  readonly inconclusive: "fail" | "warn";
}

const INDENT = "    ";

type Argument = readonly [name: string, value: string];

/** `do $rls$ ... $rls$;`: an anonymous block around `body`, which starts at `declare` or `begin`. */
function anonymousBlock(body: string): string {
  const quoted = dollarQuote(`\n${body}\n`, "rls");
  return `do ${quoted};`;
}

/**
 * A `DO` block that calls the runtime with named arguments. `guard`, for a cell: the block ends
 * before the call when the preflight found other rows in the cell's table than the exported ones.
 */
function doBlock(
  name: RuntimeFunction,
  args: readonly Argument[],
  guard?: { readonly table: string; readonly cell: string },
): string {
  const lines = args.map(([argument, value]) => `${INDENT}${argument} => ${value}`);
  const ready =
    guard === undefined
      ? ""
      : `  if not ${runtimeName("ready")}(${quoteLiteral(guard.table)}, ${quoteLiteral(guard.cell)}) then\n    return;\n  end if;\n`;
  return anonymousBlock(
    `begin\n${ready}  perform ${runtimeName(name)}(\n${lines.join(",\n")}\n  );\nend`,
  );
}

const text = (value: string): string => quoteLiteral(value);
const statement = (value: string): string => dollarQuote(value);
const statements = (values: readonly string[]): string => statementArray(values, INDENT);

function rowArguments(name: string, rows: readonly RowStatement[]): Argument[] {
  return [
    [`p_${name}_statements`, statements(rows.map((row) => row.sql))],
    [`p_${name}_values`, jsonbLiteral(rows.map((row) => row.values))],
  ];
}

function headerArguments(plan: Exclude<CellPlan, { kind: "skipped" }>): Argument[] {
  return [
    ["p_cell", text(plan.id)],
    ["p_label", text(plan.label)],
    ["p_identity", statements(plan.identity)],
    ["p_role", text(plan.role)],
  ];
}

function keyArguments(plan: Exclude<CellPlan, { kind: "skipped" | "insert" }>): Argument[] {
  return [
    ["p_key_columns", String(plan.keyColumns)],
    ["p_expected", keysLiteral(plan.expectedKeys)],
    ["p_truth", keysLiteral(plan.truthKeys)],
    ["p_reach", statement(plan.reach)],
  ];
}

function updateArguments(plan: UpdateCellPlan): Argument[] {
  const blind = plan.blind;
  return [
    ["p_row_statement", statement(plan.row.sql)],
    ...rowArguments("pull", plan.pulls),
    ["p_blind_source", statements(blind?.source ?? [])],
    ["p_blind_versions", blind === null ? "null" : statement(blind.versions)],
    ["p_blind_constants", statements(blind?.constants ?? [])],
    ["p_blind_pulls", statements(blind?.pulls ?? [])],
    [
      "p_escapes",
      jsonbLiteral(
        plan.escapes.map((escape) => ({
          label: escape.label,
          values: escape.targeted.values,
          before: escape.before.map((key) => parseKey(key)),
        })),
      ),
    ],
    ["p_escape_targeted", statements(plan.escapes.map((escape) => escape.targeted.sql))],
    ["p_escape_bulk", statements(plan.escapes.map((escape) => escape.bulk))],
    ["p_escape_read", statements(plan.escapes.map((escape) => escape.read))],
  ];
}

function cellBlock(plan: Exclude<CellPlan, { kind: "skipped" }>): string {
  const guard = { table: plan.table, cell: plan.id };
  switch (plan.kind) {
    case "select":
      return doBlock(
        "select_cell",
        [...headerArguments(plan), ...keyArguments(plan), ["p_count", statement(plan.count)]],
        guard,
      );
    case "delete":
      return doBlock(
        "delete_cell",
        [
          ...headerArguments(plan),
          ...keyArguments(plan),
          ["p_row_statement", statement(plan.row.sql)],
          ["p_blind", statement(plan.blind)],
          ["p_read_keys", statement(plan.readKeys)],
        ],
        guard,
      );
    case "update":
      return doBlock(
        "update_cell",
        [...headerArguments(plan), ...keyArguments(plan), ...updateArguments(plan)],
        guard,
      );
    case "insert":
      return doBlock(
        "insert_cell",
        [
          ...headerArguments(plan),
          [
            "p_clones",
            jsonbLiteral(
              plan.clones.map((clone) => ({
                kind: clone.kind,
                expected: clone.expected,
                source: parseKey(clone.sourceKey),
              })),
            ),
          ],
          ["p_sources", statements(plan.clones.map((clone) => clone.source))],
          ["p_grant", statement(plan.grant)],
          ["p_inserts", statements(plan.clones.map((clone) => clone.insert))],
        ],
        guard,
      );
  }
}

function cellSection(plan: CellPlan, position: number, total: number): string {
  const title = `-- [${position}/${total}] ${commentLine(plan.id)}: ${commentLine(plan.label)}`;
  if (plan.kind === "skipped") {
    return `${title}\n-- NOT CHECKED: ${commentLine(plan.reason)}`;
  }
  const notes =
    plan.kind === "update"
      ? plan.skippedEscapes.map((reason) => `-- No scope escape: ${commentLine(reason)}`)
      : [];
  return [title, ...notes, cellBlock(plan)].join("\n");
}

function headerSection(input: TestSqlInput, checked: number): string {
  const lines = [
    `${input.toolName}: CI isolation proof (rls-isolation.test.sql)`,
    `Scenario: ${input.scenarioTitle} [${input.scenarioId}]`,
    input.regime,
    "",
    `Core principle: ${CORE_PRINCIPLE}`,
    "",
    `${checked} of ${input.plans.length} cells (persona x table x operation) are checked below; the others are`,
    "comments that say why they cannot be. Every cell switches to the persona's role and claims,",
    "runs the probe statements of the matrix runner, compares the reached keys with the expected",
    "keys, and rolls everything back: rows, roles and settings are as before. What a rollback does",
    "not take back is a sequence: a probe INSERT that draws its key from one (serial, a nextval()",
    "default, GENERATED ALWAYS AS IDENTITY) advances it, so later keys have gaps. A cell that fails",
    "is reported as a WARNING at once; the last statement raises one exception that lists them all.",
    `An inconclusive cell (a probe failed for a reason that is not authorization) ${input.inconclusive === "fail" ? "fails the run" : "is a warning"}.`,
    "",
    "Run it as a superuser, after the schema and the seed of the scenario have been loaded:",
    "  psql -v ON_ERROR_STOP=1 -f rls-isolation.test.sql",
    "",
    "What this file covers, and what it refuses to judge (the preflight fails the run instead):",
    `- The tables of the exported run in the exposed schemas (${input.exposedSchemas.join(", ")}). A table added to one of`,
    "  them later has no cell here: the run fails until the check is exported again.",
    "- The expected keys are literal. When the rows of a table are not the exported ones, its cells",
    "  are not run. After changing the seed, export the check again; a seed whose keys come from a",
    "  volatile default (gen_random_uuid(), now()) differs on every load and needs explicit keys.",
    "- New personas, roles and expectations are not known here either: export again after adding them.",
  ];
  const rule = `-- ${"=".repeat(96)}`;
  return [rule, ...lines.map((line) => `-- ${commentLine(line)}`.trimEnd()), rule].join("\n");
}

function sessionSection(): string {
  const report = JSON.stringify(EMPTY_REPORT);
  return [
    "-- The session as the matrix runner pins it, and English messages: a 42501 is read by its text.",
    ...RESET_SESSION.map((line) => `${line};`),
    "set lc_messages = 'C';",
    anonymousBlock(
      `begin\n  perform set_config(${quoteLiteral(REPORT_SETTING)}, ${quoteLiteral(report)}, false);\nend`,
    ),
  ].join("\n");
}

function preflightSection(input: TestSqlInput): string {
  const cellsOf = (table: string): number =>
    input.plans.filter((plan) => plan.kind !== "skipped" && plan.table === table).length;
  const blocks = [
    doBlock("check_roles", [["p_roles", textArray(input.roles)]]),
    doBlock("check_tables", [
      ["p_schemas", textArray(input.exposedSchemas)],
      ["p_tables", jsonbLiteral(input.tables)],
    ]),
    ...input.seedChecks.map((check) =>
      doBlock("check_seed", [
        ["p_table", text(check.table)],
        ["p_key_columns", String(check.keyColumns)],
        ["p_read_keys", statement(check.readKeys)],
        ["p_truth", keysLiteral(check.truthKeys)],
        ["p_cells", String(cellsOf(check.table))],
        ["p_volatile", check.volatile === null ? "null" : text(check.volatile)],
      ]),
    ),
  ];
  return [
    "-- Preflight: the roles of the personas exist, every table of the exposed schemas is a table of",
    "-- the exported run, and the seeded rows are the exported ones.",
    ...blocks,
  ].join("\n");
}

function verdictSection(input: TestSqlInput, checked: number): string {
  const body = String.raw`declare
  v_tool constant text := ${quoteLiteral(input.toolName)};
  v_checked constant integer := ${checked};
  v_report jsonb := current_setting(${quoteLiteral(REPORT_SETTING)})::jsonb;
  v_failed integer := jsonb_array_length(v_report -> 'failed');
  v_warned integer := jsonb_array_length(v_report -> 'warned');
  v_setup integer := jsonb_array_length(v_report -> 'setup');
  v_passed integer := (v_report ->> 'passed')::integer;
  v_not_run integer := (v_report ->> 'not_run')::integer;
  v_leaking integer;
  v_overblock integer;
  v_inconclusive integer;
  v_unproven integer;
  v_lines text;
begin
  select string_agg(line, E'\n' order by position) into v_lines
    from jsonb_array_elements_text((v_report -> 'setup') || (v_report -> 'failed') || (v_report -> 'warned')) with ordinality as listed(line, position);
  -- Every line of a cell starts with its status. Only a leak or an escape is called LEAKING; an
  -- overblock, an inconclusive cell and a setup problem fail the run under their own names.
  select count(*) filter (where line like '[leak] %' or line like '[escape] %'),
         count(*) filter (where line like '[overblock] %'),
         count(*) filter (where line like '[inconclusive] %')
    into v_leaking, v_overblock, v_inconclusive
    from jsonb_array_elements_text((v_report -> 'failed') || (v_report -> 'warned')) as listed(line);
  select count(*) into v_unproven
    from jsonb_array_elements_text(v_report -> 'failed') as listed(line)
   where line like '[inconclusive] %';
  if v_failed > 0 or v_setup > 0 then
    raise exception using message = format(
      E'%s: %s. Of %s checked cells: %s leaked or escaped, %s overblocked, %s inconclusive, %s passed; %s warnings.%s\n%s',
      v_tool,
      case
        when v_leaking > 0 then 'LEAKING'
        when v_setup > 0 or v_unproven > 0 then 'NOT PROVEN, no leak or escape was measured'
        else 'OVERBLOCKING, no leak or escape was measured'
      end,
      v_checked, v_leaking, v_overblock, v_inconclusive, v_passed, v_warned,
      case when v_setup > 0 then format(' Setup problems: %s; cells not run because of them: %s.', v_setup, v_not_run) else '' end,
      v_lines);
  end if;
  if v_passed = 0 then
    raise exception using message = format(
      '%s: NOT PROVEN. No cell was measured, so nothing is known about isolation.%s',
      v_tool, coalesce(E'\n' || v_lines, ''));
  end if;
  raise notice '%', format(
    '%s: ISOLATED. %s of %s checked cells passed, %s warnings.%s',
    v_tool, v_passed, v_checked, v_warned, coalesce(E'\n' || v_lines, ''));
end`;
  return [
    "-- Verdict. The runtime goes first, so that nothing of this file is left in the session.",
    dropRuntimeSql(),
    anonymousBlock(body),
  ].join("\n");
}

/** The whole test file. */
export function renderTestSql(input: TestSqlInput): string {
  const total = input.plans.length;
  const checked = input.plans.filter((plan) => plan.kind !== "skipped").length;
  const sections = [
    headerSection(input, checked),
    sessionSection(),
    "-- Runtime: what the matrix runner does in TypeScript, in PL/pgSQL. Temporary: gone with the session.",
    runtimeSql(input.maxParams, input.inconclusive),
    preflightSection(input),
    ...input.plans.map((plan, index) => cellSection(plan, index + 1, total)),
    verdictSection(input, checked),
  ];
  return `${sections.join("\n\n")}\n`;
}
