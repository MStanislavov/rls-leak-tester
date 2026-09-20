/**
 * Planning: everything a cell needs to know before SQL runs, computed from the scenario, the
 * catalog and the ground truth. Pure; no engine.
 *
 * EXPECTED KEYS by scope (brief 3.4, 3.5), always from the ground truth:
 *
 *   none    no row
 *   own     rows whose owner column equals the persona's `sub` claim (no `sub`: no row)
 *   tenant  rows whose tenant column equals the claim at `tenantClaimPath` (no claim: no row)
 *   all     every row
 *   custom  the rows `expectedRowsSql` returns, see `expectedRowsProbe`
 *
 * "Equals" is decided by Postgres in the column's type (`ScopeMembership`, read by the matrix
 * runner as the superuser), never by comparing text here: `AAAA...` and `aaaa...` are one uuid,
 * `1` and `1.0` one numeric. `textMembership` is the fallback for a column type without `=`.
 *
 * `own` / `tenant` on a table without the configured column cannot be decided: skipped. So is
 * `tenant` for a signed-in persona (it has a `sub`) WITHOUT a `tenantClaimPath`: its tenant is
 * unknown, not absent, and "expect no row" would call a correct tenant policy a leak.
 *
 * INSERT. For each scope class present in the ground truth one seeded row is cloned under a fresh
 * primary key and inserted as the persona. The classes are `own` (owner = sub, and not in another
 * tenant), `same-tenant` (the persona's tenant, another owner), `other` (the rest); for scope
 * `custom` they are `in-scope` and `out-of-scope` of the expected rows. A class can hold rows
 * inside AND outside the expected keys (scope `own`: the persona's own row in another tenant is
 * `other`, and so is a stranger's row), so a class gets one representative for each side: the
 * first row in key order. Without that the out-of-scope insert would never be attempted. One
 * rule decides what is expected, for every scope:
 *
 *   the insert must be ALLOWED when the cloned row is inside the persona's expected keys for the
 *   insert cell (a row like one it may reach), and BLOCKED otherwise.
 *
 * So `none` expects every class blocked, `all` every class allowed, `own` only clones of own
 * rows, `tenant` only clones of rows of the own tenant, `custom` only clones of rows the query
 * returns. An out-of-scope insert that goes through is an `escape`; an in-scope one that is
 * blocked is an `overblock`.
 *
 * FRESH KEYS are deterministic, so the recorded SQL is identical across runs. Exactly one primary
 * key column is replaced, the first one in key order that is not the owner or tenant column
 * (those define the class and stay as cloned) and for which a value can be made:
 *
 *   identity ALWAYS / generated  the column is left out (it cannot be written)
 *   uuid                         a fixed literal that no seeded row uses
 *   smallint, integer, bigint    max + 1000, or max + 1 when that leaves the type's range
 *   any other type with default  the column is left out and takes its default
 *   otherwise                    the class is skipped, with the reason
 *
 * An explicit value is preferred over a default on purpose (a deviation from the brief, see the
 * runner ADR): a default backed by a sequence also needs USAGE on that sequence, so an insert
 * could look blocked although a client that names the key gets through.
 *
 * SCOPE ESCAPE. The column that is moved is the one that defines the scope: the owner column for
 * `own`, the tenant column for `tenant`, the tenant column (else the owner column) for `custom`.
 * Scope `own` on a table that also has a tenant column, for a persona with a tenant claim, moves
 * the tenant column as well (brief 3.5: "the tenant (or owner) column"): the default scope is
 * `own` whenever an owner column exists, and moving an own row into a foreign tenant is the
 * headline leak of a multi-tenant schema. The row is the first one the persona is expected to
 * reach AND can really update; the foreign value is the first value of that column, in code-unit
 * order, that occurs only on rows outside the persona's expected keys (and, for the tenant move
 * under `own`, outside the persona's tenant). Nothing to move, or nowhere to move it: skipped
 * with the reason.
 *
 * TAKEOVER ("pull"). The escape in the other direction: make a foreign row one's own by setting
 * its owner and tenant columns to the persona's values. `pullMoves` lists the variants to try.
 */
import {
  compareText,
  personaSub,
  personaTenant,
  stableStringify,
  type Mode,
  type Persona,
  type Scope,
} from "@/lib/scenario";
import type { GroundTruthRow, GroundTruthSnapshot } from "./ground-truth";
import type { CatalogColumn, CatalogTable } from "./introspect";
import { parseKey, type ColumnValue } from "./probes";
import type { SubProbeKind } from "./result";

export interface PersonaFacts {
  readonly sub: string | undefined;
  readonly tenant: string | undefined;
  /** `false`: the persona has no `tenantClaimPath`, so its tenant is unknown rather than absent. */
  readonly tenantClaimConfigured: boolean;
}

export function personaFacts(persona: Pick<Persona, "claims" | "tenantClaimPath">): PersonaFacts {
  return {
    sub: personaSub(persona),
    tenant: personaTenant(persona),
    tenantClaimConfigured: persona.tenantClaimPath !== undefined,
  };
}

/**
 * Which seeded rows of ONE table belong to the persona: `own` by the owner column and `sub`,
 * `tenant` by the tenant column and the tenant claim. The matrix runner asks Postgres
 * (`rowsEqualToProbe`), so the comparison happens in the column's type.
 */
export interface ScopeMembership {
  readonly own: ReadonlySet<string>;
  readonly tenant: ReadonlySet<string>;
}

/** Membership by comparing text: exact for text columns, the fallback for a type without `=`. */
export function textMembership(
  truth: Pick<GroundTruthSnapshot, "rows">,
  persona: Pick<PersonaFacts, "sub" | "tenant">,
): ScopeMembership {
  const keysWhere = (test: (row: GroundTruthRow) => boolean): Set<string> =>
    new Set(truth.rows.filter(test).map((row) => row.key));
  return {
    own: keysWhere((row) => persona.sub !== undefined && row.owner === persona.sub),
    tenant: keysWhere((row) => persona.tenant !== undefined && row.tenant === persona.tenant),
  };
}

/**
 * The claims a probe runs with. In `supabase` mode a JWT always carries `role` (it is how the API
 * picks the database role), so it is added when the persona leaves it out; `auth.role()` reads it.
 */
export function effectiveClaims(
  persona: Pick<Persona, "claims" | "dbRole">,
  mode: Mode,
): Record<string, unknown> {
  if (mode === "supabase" && persona.claims.role === undefined) {
    return { ...persona.claims, role: persona.dbRole };
  }
  return persona.claims;
}

/** The exact `request.jwt.claims` text: keys sorted, so it is the same in every run. */
export function claimsJsonOf(persona: Pick<Persona, "claims" | "dbRole">, mode: Mode): string {
  return stableStringify(effectiveClaims(persona, mode));
}

export type Planned<T> =
  ({ readonly status: "ok" } & T) | { readonly status: "skipped"; readonly reason: string };

const skipped = (reason: string): { status: "skipped"; reason: string } => ({
  status: "skipped",
  reason,
});

// ---------------------------------------------------------------------------------------------
// Expected keys
// ---------------------------------------------------------------------------------------------

export function expectedKeysForScope(
  scope: Exclude<Scope, "custom">,
  table: GroundTruthSnapshot,
  persona: PersonaFacts,
  membership: ScopeMembership,
): Planned<{ keys: string[] }> {
  const keysWhere = (test: (row: GroundTruthRow) => boolean): string[] =>
    table.rows.filter(test).map((row) => row.key);
  switch (scope) {
    case "none":
      return { status: "ok", keys: [] };
    case "all":
      return { status: "ok", keys: keysWhere(() => true) };
    case "own":
      if (table.ownerColumn === null) {
        return skipped(
          'Scope "own" needs an owner column, and none is configured or suggested for this table.',
        );
      }
      return { status: "ok", keys: keysWhere((row) => membership.own.has(row.key)) };
    case "tenant":
      if (table.tenantColumn === null) {
        return skipped(
          'Scope "tenant" needs a tenant column, and none is configured or suggested for this table.',
        );
      }
      if (persona.sub !== undefined && !persona.tenantClaimConfigured) {
        return skipped(
          'Scope "tenant" needs to know the persona\'s tenant, and this persona has no tenantClaimPath. Set it to the claim that carries the tenant (for example tenant_id or app_metadata.tenant_id).',
        );
      }
      return { status: "ok", keys: keysWhere((row) => membership.tenant.has(row.key)) };
  }
}

// ---------------------------------------------------------------------------------------------
// UPDATE: which column the no-op update touches
// ---------------------------------------------------------------------------------------------

/** A column an UPDATE may name: not generated, not identity ALWAYS. */
export function isWritable(column: Pick<CatalogColumn, "generated" | "identity">): boolean {
  return column.generated === null && column.identity !== "always";
}

/**
 * The column of `SET col = col`. Preference: a writable column the role may use that is neither a
 * key column nor the owner or tenant column (those are the ones a trigger or a column grant most
 * likely guards, and the no-op should measure the policies, nothing else); then any non-key
 * column it may use; then a key column it may use; then (the role may use nothing) the first
 * writable column, so that the probe still runs and records the 42501. `null`: no column can be
 * written.
 *
 * `usable` are the columns the role holds UPDATE **and SELECT** on, table-level or column-level
 * (`has_column_privilege`): `set col = col` reads the column. With UPDATE alone the statement
 * raises "permission denied for table", which says nothing about the rows (a column-level SELECT
 * grant that leaves out one column is enough for that). `scopeColumns` are the configured owner
 * and tenant columns.
 */
export function chooseUpdateColumn(
  table: Pick<CatalogTable, "columns" | "primaryKey">,
  usable: ReadonlySet<string>,
  scopeColumns: ReadonlySet<string | null> = new Set(),
): string | null {
  const writable = table.columns.filter(isWritable);
  const isKey = (column: CatalogColumn): boolean => table.primaryKey.includes(column.name);
  const granted = writable.filter((column) => usable.has(column.name));
  const choice =
    granted.find((column) => !isKey(column) && !scopeColumns.has(column.name)) ??
    granted.find((column) => !isKey(column)) ??
    granted[0] ??
    writable.find((column) => !isKey(column)) ??
    writable[0];
  return choice?.name ?? null;
}

/** How many columns the blind UPDATE tries before it gives up on constraint errors. */
export const BLIND_UPDATE_CANDIDATES = 3;

/**
 * The columns the blind UPDATE (`set col = <the source row's value>`) tries, in order. It needs
 * UPDATE only. The same preference as above; key columns come last, because one value for every
 * reachable row collides (23505) as soon as two rows are reachable. A column whose constant
 * breaks a constraint is followed by the next one.
 *
 * `alsoUngranted` is for the CI export, which must still measure after a later migration granted
 * UPDATE: the writable columns the role holds NO update privilege on follow the granted ones, in
 * the same preference, within the same cap. Today they answer 42501, which is no finding.
 */
export function blindUpdateColumns(
  table: Pick<CatalogTable, "columns" | "primaryKey">,
  updatable: ReadonlySet<string>,
  scopeColumns: ReadonlySet<string | null> = new Set(),
  alsoUngranted = false,
): string[] {
  const writable = table.columns.filter(isWritable);
  const rank = (column: CatalogColumn): number => {
    if (table.primaryKey.includes(column.name)) {
      return 2;
    }
    return scopeColumns.has(column.name) ? 1 : 0;
  };
  const ranked = (columns: readonly CatalogColumn[]): CatalogColumn[] =>
    [0, 1, 2].flatMap((wanted) => columns.filter((column) => rank(column) === wanted));
  const granted = ranked(writable.filter((column) => updatable.has(column.name)));
  const ungranted = alsoUngranted
    ? ranked(writable.filter((column) => !updatable.has(column.name)))
    : [];
  return [...granted, ...ungranted].slice(0, BLIND_UPDATE_CANDIDATES).map((column) => column.name);
}

/**
 * The takeover variants for a row the persona must not reach: owner and tenant column set to the
 * persona's own values, both at once first (a WITH CHECK may ask for both), then each alone (a
 * column grant may allow only one). Empty without a claim or a writable column to set.
 */
export function pullMoves(
  table: Pick<CatalogTable, "columns">,
  truth: Pick<GroundTruthSnapshot, "ownerColumn" | "tenantColumn">,
  persona: Pick<PersonaFacts, "sub" | "tenant">,
): ColumnValue[][] {
  const moveOf = (name: string | null, value: string | undefined): ColumnValue[] => {
    const column = table.columns.find((candidate) => candidate.name === name);
    return column === undefined || value === undefined || !isWritable(column)
      ? []
      : [{ column: column.name, type: column.type, value }];
  };
  const owner = moveOf(truth.ownerColumn, persona.sub);
  const tenant =
    truth.tenantColumn === truth.ownerColumn ? [] : moveOf(truth.tenantColumn, persona.tenant);
  const both = owner.length > 0 && tenant.length > 0 ? [[...owner, ...tenant]] : [];
  return [...both, owner, tenant].filter((moves) => moves.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Scope escape
// ---------------------------------------------------------------------------------------------

export interface EscapePlan {
  readonly sourceKey: string;
  readonly move: ColumnValue & { readonly value: string };
}

function escapeColumn(scope: Scope, truth: GroundTruthSnapshot): Planned<{ column: string }> {
  if (scope === "all") {
    return skipped('Every row is inside scope "all": there is nowhere to escape to.');
  }
  if (scope === "none") {
    return skipped('No row is inside scope "none": there is nothing to move.');
  }
  let column = truth.tenantColumn ?? truth.ownerColumn;
  if (scope === "own") {
    column = truth.ownerColumn;
  } else if (scope === "tenant") {
    column = truth.tenantColumn;
  }
  return column === null
    ? skipped("The table has no owner or tenant column to move a row with.")
    : { status: "ok", column };
}

const valueOf = (row: GroundTruthRow, truth: GroundTruthSnapshot, column: string): string | null =>
  column === truth.tenantColumn ? row.tenant : row.owner;

export interface EscapeInput {
  readonly scope: Scope;
  readonly table: Pick<CatalogTable, "columns">;
  readonly truth: GroundTruthSnapshot;
  readonly expectedKeys: readonly string[];
  /** The rows the UPDATE reach probe really reached. */
  readonly reachableKeys: readonly string[];
}

function planMove(
  input: EscapeInput,
  column: string,
  ownTenant: ReadonlySet<string>,
): Planned<EscapePlan> {
  const { table, truth, expectedKeys } = input;
  const catalogColumn = table.columns.find((candidate) => candidate.name === column);
  if (catalogColumn === undefined || !isWritable(catalogColumn)) {
    return skipped(`The column "${column}" is generated and cannot be updated.`);
  }
  const reachable = new Set(input.reachableKeys);
  const sourceKey = [...expectedKeys].sort(compareText).find((key) => reachable.has(key));
  if (sourceKey === undefined) {
    return skipped("The persona can update no row inside its scope, so there is nothing to move.");
  }
  const expected = new Set(expectedKeys);
  const inside = new Set(
    truth.rows
      .filter((row) => expected.has(row.key) || ownTenant.has(row.key))
      .map((row) => valueOf(row, truth, column)),
  );
  const foreign = truth.rows
    .filter((row) => !expected.has(row.key) && !ownTenant.has(row.key))
    .map((row) => valueOf(row, truth, column))
    .filter((value): value is string => value !== null && !inside.has(value))
    .sort(compareText)[0];
  if (foreign === undefined) {
    return skipped(
      `No value of "${column}" in the seed data belongs to someone else, so there is nowhere to move a row.`,
    );
  }
  return {
    status: "ok",
    sourceKey,
    move: { column, type: catalogColumn.type, value: foreign },
  };
}

/** The move of the column that defines the scope. */
export function planEscape(input: EscapeInput): Planned<EscapePlan> {
  const chosen = escapeColumn(input.scope, input.truth);
  return chosen.status === "skipped" ? chosen : planMove(input, chosen.column, new Set());
}

/**
 * Scope `own` only: the additional move of the TENANT column into a foreign tenant. `null` when
 * it does not apply (another scope, no tenant column, or a persona without a tenant claim, whose
 * rows may legitimately live in any tenant). `ownTenant` are the rows of the persona's tenant:
 * their value is not foreign even when someone else owns them.
 */
export function planTenantEscape(
  input: EscapeInput,
  persona: Pick<PersonaFacts, "tenant">,
  ownTenant: ReadonlySet<string>,
): Planned<EscapePlan> | null {
  const { scope, truth } = input;
  const applies =
    scope === "own" &&
    truth.tenantColumn !== null &&
    truth.tenantColumn !== truth.ownerColumn &&
    persona.tenant !== undefined;
  return applies ? planMove(input, truth.tenantColumn, ownTenant) : null;
}

// ---------------------------------------------------------------------------------------------
// INSERT: scope classes and fresh keys
// ---------------------------------------------------------------------------------------------

export type InsertClassKind = Extract<SubProbeKind, `insert-${string}`>;

export interface InsertClassPlan {
  readonly kind: InsertClassKind;
  /** The seeded row that is cloned. */
  readonly sourceKey: string;
  readonly expected: "allowed" | "blocked";
}

const INSERT_CLASS_ORDER: readonly InsertClassKind[] = [
  "insert-own",
  "insert-same-tenant",
  "insert-other",
  "insert-in-scope",
  "insert-out-of-scope",
];

function classOf(
  row: GroundTruthRow,
  scope: Scope,
  truth: GroundTruthSnapshot,
  persona: PersonaFacts,
  membership: ScopeMembership,
  expected: ReadonlySet<string>,
): InsertClassKind {
  if (scope === "custom") {
    return expected.has(row.key) ? "insert-in-scope" : "insert-out-of-scope";
  }
  const tenantKnown = truth.tenantColumn !== null && persona.tenant !== undefined;
  const inTenant = tenantKnown && membership.tenant.has(row.key);
  const isOwn = truth.ownerColumn !== null && membership.own.has(row.key);
  if (isOwn && (inTenant || !tenantKnown)) {
    return "insert-own";
  }
  return !isOwn && inTenant ? "insert-same-tenant" : "insert-other";
}

/**
 * One plan per class that occurs in the ground truth and per side of the expected keys, in the
 * fixed class order, the allowed side first.
 */
export function planInsertClasses(
  scope: Scope,
  truth: GroundTruthSnapshot,
  persona: PersonaFacts,
  membership: ScopeMembership,
  expectedKeys: readonly string[],
): InsertClassPlan[] {
  const expected = new Set(expectedKeys);
  const sideOf = (key: string): InsertClassPlan["expected"] =>
    expected.has(key) ? "allowed" : "blocked";
  const representatives = new Map<string, string>();
  for (const row of truth.rows) {
    const slot = `${classOf(row, scope, truth, persona, membership, expected)}|${sideOf(row.key)}`;
    if (!representatives.has(slot)) {
      representatives.set(slot, row.key);
    }
  }
  const plans: InsertClassPlan[] = [];
  for (const kind of INSERT_CLASS_ORDER) {
    for (const side of ["allowed", "blocked"] as const) {
      const sourceKey = representatives.get(`${kind}|${side}`);
      if (sourceKey !== undefined) {
        plans.push({ kind, sourceKey, expected: side });
      }
    }
  }
  return plans;
}

const INTEGER_MAX: Readonly<Record<string, bigint>> = {
  smallint: 32767n,
  integer: 2147483647n,
  bigint: 9223372036854775807n,
};

const FRESH_UUID_PREFIX = "00000000-0000-4000-8000-";

function freshUuid(existing: ReadonlySet<string>): string {
  for (let counter = 1; ; counter += 1) {
    const candidate = `${FRESH_UUID_PREFIX}${counter.toString(16).padStart(12, "0")}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function freshInteger(existing: readonly string[], limit: bigint): string | undefined {
  let max = 0n;
  for (const value of existing) {
    if (/^-?\d+$/.test(value) && BigInt(value) > max) {
      max = BigInt(value);
    }
  }
  return [max + 1000n, max + 1n].find((candidate) => candidate <= limit)?.toString();
}

/** How one primary key column gets its fresh value: a literal, or `null` = leave it to the default. */
function freshValue(
  column: CatalogColumn,
  existing: readonly string[],
): { readonly value: string | null } | undefined {
  if (!isWritable(column)) {
    return { value: null };
  }
  if (column.type === "uuid") {
    return { value: freshUuid(new Set(existing.map((value) => value.toLowerCase()))) };
  }
  const limit = INTEGER_MAX[column.type];
  const integer = limit === undefined ? undefined : freshInteger(existing, limit);
  if (integer !== undefined) {
    return { value: integer };
  }
  return column.default !== null || column.identity !== null ? { value: null } : undefined;
}

export interface FreshKeyPlan {
  /** The primary key column that gets a new value. */
  readonly column: string;
  /** The explicit value, or `null` when the column is left out and takes its default. */
  readonly value: ColumnValue | null;
}

export function planFreshKey(
  table: Pick<CatalogTable, "columns" | "primaryKey">,
  truth: GroundTruthSnapshot,
): Planned<FreshKeyPlan> {
  const scopeColumns = new Set([truth.ownerColumn, truth.tenantColumn]);
  const candidates = table.primaryKey.filter((name) => !scopeColumns.has(name));
  if (candidates.length === 0) {
    return skipped(
      "Every primary key column is the owner or tenant column, so a clone with a fresh key would be a row of another scope class.",
    );
  }
  for (const name of candidates) {
    const column = table.columns.find((candidate) => candidate.name === name);
    const index = table.primaryKey.indexOf(name);
    const existing = truth.rows.map((row) => parseKey(row.key)[index] ?? "");
    const fresh = column === undefined ? undefined : freshValue(column, existing);
    if (column !== undefined && fresh !== undefined) {
      return {
        status: "ok",
        column: name,
        value:
          fresh.value === null ? null : { column: name, type: column.type, value: fresh.value },
      };
    }
  }
  return skipped(
    `No fresh value can be made for the primary key (${candidates.map((name) => `"${name}"`).join(", ")}): it is neither uuid nor integer and has no default.`,
  );
}

/**
 * The columns an insert clone names, in table order: every writable column, minus the key column
 * that takes its default. `insertCloneProbe` puts the fresh key value in place of the cloned one.
 */
export function cloneColumns(
  table: Pick<CatalogTable, "columns">,
  freshKey: FreshKeyPlan,
): CatalogColumn[] {
  return table.columns.filter(
    (column) => isWritable(column) && !(column.name === freshKey.column && freshKey.value === null),
  );
}
