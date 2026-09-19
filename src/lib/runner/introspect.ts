/**
 * Catalog introspection (brief 3.5 step 5): everything the runner, the static checks RLS001 to
 * RLS009 and the exporter need to know about the database, read as the superuser through the
 * `SqlEngine` port. Pure: no engine import, no I/O of its own.
 *
 * Determinism: every list is ordered in SQL with `collate "C"` (byte order, independent of the
 * database locale) by schema, name and, where needed, position. Same database in, identical
 * `Catalog` out.
 *
 * No identifier is ever interpolated: the exposed schemas travel as one JSON text parameter.
 * Nested lists (key columns, policy roles, view references) are fetched as flat rows and grouped
 * here, so nothing has to be parsed back from JSON. A view depends on a table once per column it
 * uses, hence the GROUP BY there (`select distinct ... order by 1 collate "C"` is rejected:
 * an ordinal with COLLATE is an integer expression).
 *
 * Every query was checked against PostgreSQL 18.3 in PGlite 0.5.8 (draft ADR
 * engine-setup-introspection): `attgenerated` is `s` or `v` (virtual columns are new in 18) and
 * `pg_attrdef` holds the generation expression for both; `polroles = {0}` means PUBLIC and
 * Postgres collapses `to app, public` to it; a NULL `relacl` means the built-in default, which
 * `acldefault` spells out; `proconfig` is a `text[]` with elements like `search_path=public, pg_temp`.
 */
import type { SqlEngine, SqlExecutor, SqlRow } from "./types";

/** The pseudo-role every role belongs to, as the catalogs and `GRANT ... TO PUBLIC` mean it. */
export const PUBLIC_ROLE = "PUBLIC";

export interface CatalogColumn {
  readonly name: string;
  /** 1-based position in the table (`attnum`). */
  readonly position: number;
  /** `format_type`: `integer`, `uuid`, `character varying(255)`, `text[]`. */
  readonly type: string;
  readonly notNull: boolean;
  /** The default expression, `null` without one. Never the expression of a generated column. */
  readonly default: string | null;
  /** `stored` or `virtual` for `GENERATED ALWAYS AS (...)`, else `null`. Cannot be written. */
  readonly generated: "stored" | "virtual" | null;
  readonly generationExpression: string | null;
  /** `always` or `by default` for an identity column, else `null`. */
  readonly identity: "always" | "by default" | null;
}

export interface CatalogTable {
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  /** `pg_class.relrowsecurity`: RLS is enabled. */
  readonly rlsEnabled: boolean;
  /** `pg_class.relforcerowsecurity`: RLS applies to the owner too. */
  readonly rlsForced: boolean;
  /** `true` for a partitioned table (`relkind = 'p'`). */
  readonly partitioned: boolean;
  readonly columns: readonly CatalogColumn[];
  /** Primary key columns in key order. Empty: no primary key, the table cannot be tracked. */
  readonly primaryKey: readonly string[];
}

export type PolicyCommand = "all" | "select" | "insert" | "update" | "delete";

export interface CatalogPolicy {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly command: PolicyCommand;
  /** `false` for `AS RESTRICTIVE`. */
  readonly permissive: boolean;
  /** Sorted role names; `PUBLIC` when the policy applies to every role. */
  readonly roles: readonly string[];
  /** The `USING` expression as Postgres prints it, `null` without one. */
  readonly using: string | null;
  /** The `WITH CHECK` expression, `null` when omitted (then `USING` covers the new row). */
  readonly withCheck: string | null;
}

/**
 * A privilege on a table, a view or a materialized view of an exposed schema. Views are listed
 * because a view is reached through its own grants, never through those of its tables (RLS008).
 */
export interface CatalogTablePrivilege {
  readonly schema: string;
  /** The relation's name: a table of `Catalog.tables` or a view of `Catalog.views`. */
  readonly table: string;
  /** A role name, or `PUBLIC`. The owner's implicit privileges are listed too. */
  readonly grantee: string;
  /** Upper case, as Postgres names it: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, ... */
  readonly privilege: string;
  readonly grantable: boolean;
}

export interface CatalogRole {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** `false`: privileges of `memberOf` roles apply only after `SET ROLE`. */
  readonly inherit: boolean;
  readonly canLogin: boolean;
  /** Roles this role is a direct member of, sorted. Ownership is reached through membership. */
  readonly memberOf: readonly string[];
}

export interface CatalogRelationRef {
  readonly schema: string;
  readonly name: string;
  readonly kind: "table" | "view" | "materialized view" | "foreign table" | "other";
}

export interface CatalogView {
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly materialized: boolean;
  readonly definition: string;
  /** `true` only with the reloption `security_invoker=true` (or `on`). */
  readonly securityInvoker: boolean;
  /** Relations the view's rule depends on (`pg_depend`), any schema, sorted. */
  readonly references: readonly CatalogRelationRef[];
}

export interface CatalogFunction {
  readonly schema: string;
  readonly name: string;
  /** `pg_get_function_identity_arguments`: tells overloads apart. */
  readonly identityArguments: string;
  readonly kind: "function" | "procedure" | "aggregate" | "window";
  readonly owner: string;
  readonly language: string;
  readonly securityDefiner: boolean;
  /** The pinned `search_path` from `proconfig`, `null` when the function does not set one. */
  readonly searchPath: string | null;
}

export interface Catalog {
  readonly exposedSchemas: readonly string[];
  /** Exposed schemas that do not exist in the database. */
  readonly missingSchemas: readonly string[];
  readonly tables: readonly CatalogTable[];
  readonly policies: readonly CatalogPolicy[];
  readonly tablePrivileges: readonly CatalogTablePrivilege[];
  /** Every role that is not a built-in `pg_*` role: personas, owners, grantees. */
  readonly roles: readonly CatalogRole[];
  readonly views: readonly CatalogView[];
  readonly functions: readonly CatalogFunction[];
}

/** The catalog answered with a shape this module does not know: an adapter bug, not user error. */
export class IntrospectionError extends Error {
  override readonly name = "IntrospectionError";
}

// ---------------------------------------------------------------------------------------------
// Typed readers: a cell is `string | number | boolean | null`, never trusted blindly.
// ---------------------------------------------------------------------------------------------

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new IntrospectionError(`Expected text in column "${key}", got ${typeof value}`);
  }
  return value;
}

function textOrNull(row: SqlRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key);
}

function flag(row: SqlRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new IntrospectionError(`Expected a boolean in column "${key}", got ${typeof value}`);
  }
  return value;
}

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new IntrospectionError(`Expected an integer in column "${key}", got ${typeof value}`);
  }
  return value;
}

function oneOf<T extends string>(row: SqlRow, key: string, map: Readonly<Record<string, T>>): T {
  const code = text(row, key);
  const value = map[code];
  if (value === undefined) {
    throw new IntrospectionError(`Unknown code "${code}" in column "${key}"`);
  }
  return value;
}

const relationKey = (schema: string, name: string): string => JSON.stringify([schema, name]);

/** Groups rows by relation, keeping the SQL order inside each group. */
function groupByRelation<T>(
  rows: readonly SqlRow[],
  schemaKey: string,
  nameKey: string,
  read: (row: SqlRow) => T,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = relationKey(text(row, schemaKey), text(row, nameKey));
    const group = groups.get(key) ?? [];
    group.push(read(row));
    groups.set(key, group);
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Queries. `$1` is always the JSON text of the exposed schemas.
// ---------------------------------------------------------------------------------------------

const EXPOSED = `(select jsonb_array_elements_text($1::jsonb))`;

const MISSING_SCHEMAS_SQL = `
select s.name::text as name
from jsonb_array_elements_text($1::jsonb) with ordinality as s(name, ord)
where not exists (select 1 from pg_namespace n where n.nspname = s.name)
order by s.ord`;

const TABLES_SQL = `
select n.nspname::text as schema, c.relname::text as name, o.rolname::text as owner,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       (c.relkind = 'p') as partitioned
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_roles o on o.oid = c.relowner
where c.relkind in ('r', 'p') and n.nspname in ${EXPOSED}
order by n.nspname collate "C", c.relname collate "C"`;

const COLUMNS_SQL = `
select n.nspname::text as schema, c.relname::text as table_name, a.attname::text as name,
       a.attnum::int as position, format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as not_null, a.attgenerated::text as generated, a.attidentity::text as identity,
       pg_get_expr(d.adbin, d.adrelid) as expression
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
  and n.nspname in ${EXPOSED}
order by n.nspname collate "C", c.relname collate "C", a.attnum`;

const PRIMARY_KEYS_SQL = `
select n.nspname::text as schema, c.relname::text as table_name, a.attname::text as name
from pg_index i
join pg_class c on c.oid = i.indrelid
join pg_namespace n on n.oid = c.relnamespace
cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
where i.indisprimary and n.nspname in ${EXPOSED}
order by n.nspname collate "C", c.relname collate "C", k.ord`;

const POLICIES_SQL = `
select n.nspname::text as schema, c.relname::text as table_name, p.polname::text as name,
       p.polcmd::text as command, p.polpermissive as permissive,
       pg_get_expr(p.polqual, p.polrelid) as using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ${EXPOSED}
order by n.nspname collate "C", c.relname collate "C", p.polname collate "C"`;

const POLICY_ROLES_SQL = `
select n.nspname::text as schema, c.relname::text as table_name, p.polname::text as name,
       coalesce(r.rolname::text, '${PUBLIC_ROLE}') as role
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
cross join lateral unnest(p.polroles) as m(role_oid)
left join pg_roles r on r.oid = m.role_oid
where n.nspname in ${EXPOSED}
order by n.nspname collate "C", c.relname collate "C", p.polname collate "C",
         coalesce(r.rolname::text, '${PUBLIC_ROLE}') collate "C"`;

const TABLE_PRIVILEGES_SQL = `
select n.nspname::text as schema, c.relname::text as table_name,
       coalesce(r.rolname::text, '${PUBLIC_ROLE}') as grantee,
       x.privilege_type::text as privilege, x.is_grantable as grantable
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as x
left join pg_roles r on r.oid = x.grantee
where c.relkind in ('r', 'p', 'v', 'm') and n.nspname in ${EXPOSED}
order by n.nspname collate "C", c.relname collate "C",
         coalesce(r.rolname::text, '${PUBLIC_ROLE}') collate "C", x.privilege_type collate "C"`;

const ROLES_SQL = `
select r.rolname::text as name, r.rolsuper as superuser, r.rolbypassrls as bypass_rls,
       r.rolinherit as inherit, r.rolcanlogin as can_login
from pg_roles r
where r.rolname !~ '^pg_'
order by r.rolname collate "C"`;

const ROLE_MEMBERSHIPS_SQL = `
select m.rolname::text as member, g.rolname::text as member_of
from pg_auth_members am
join pg_roles m on m.oid = am.member
join pg_roles g on g.oid = am.roleid
where m.rolname !~ '^pg_'
order by m.rolname collate "C", g.rolname collate "C"`;

const VIEWS_SQL = `
select n.nspname::text as schema, c.relname::text as name, o.rolname::text as owner,
       (c.relkind = 'm') as materialized, pg_get_viewdef(c.oid, true) as definition,
       coalesce((
         select lower(split_part(opt, '=', 2)) in ('true', 'on', '1', 'yes')
         from unnest(c.reloptions) as opt
         where opt like 'security\\_invoker=%'
         limit 1
       ), false) as security_invoker
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_roles o on o.oid = c.relowner
where c.relkind in ('v', 'm') and n.nspname in ${EXPOSED}
order by n.nspname collate "C", c.relname collate "C"`;

const VIEW_REFERENCES_SQL = `
select vn.nspname::text as schema, v.relname::text as view_name,
       tn.nspname::text as ref_schema, t.relname::text as ref_name, t.relkind::text as ref_kind
from pg_rewrite w
join pg_class v on v.oid = w.ev_class
join pg_namespace vn on vn.oid = v.relnamespace
join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid
                and d.refclassid = 'pg_class'::regclass
join pg_class t on t.oid = d.refobjid
join pg_namespace tn on tn.oid = t.relnamespace
where v.relkind in ('v', 'm') and t.oid <> v.oid and vn.nspname in ${EXPOSED}
group by vn.nspname, v.relname, tn.nspname, t.relname, t.relkind
order by vn.nspname collate "C", v.relname collate "C",
         tn.nspname collate "C", t.relname collate "C"`;

const FUNCTIONS_SQL = `
select n.nspname::text as schema, p.proname::text as name,
       pg_get_function_identity_arguments(p.oid) as identity_arguments,
       p.prokind::text as kind, o.rolname::text as owner, l.lanname::text as language,
       p.prosecdef as security_definer,
       (select substring(cfg from 13) from unnest(p.proconfig) as cfg
        where cfg like 'search\\_path=%' limit 1) as search_path
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_roles o on o.oid = p.proowner
join pg_language l on l.oid = p.prolang
where n.nspname in ${EXPOSED}
order by n.nspname collate "C", p.proname collate "C",
         pg_get_function_identity_arguments(p.oid) collate "C"`;

const POLICY_COMMANDS: Readonly<Record<string, PolicyCommand>> = {
  "*": "all",
  r: "select",
  a: "insert",
  w: "update",
  d: "delete",
};

const GENERATED: Readonly<Record<string, "stored" | "virtual" | "none">> = {
  "": "none",
  s: "stored",
  v: "virtual",
};

const IDENTITY: Readonly<Record<string, "always" | "by default" | "none">> = {
  "": "none",
  a: "always",
  d: "by default",
};

const RELATION_KINDS: Readonly<Record<string, CatalogRelationRef["kind"]>> = {
  r: "table",
  p: "table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

const FUNCTION_KINDS: Readonly<Record<string, CatalogFunction["kind"]>> = {
  f: "function",
  p: "procedure",
  a: "aggregate",
  w: "window",
};

function readColumn(row: SqlRow): CatalogColumn {
  const generated = oneOf(row, "generated", GENERATED);
  const identity = oneOf(row, "identity", IDENTITY);
  const expression = textOrNull(row, "expression");
  const isGenerated = generated !== "none";
  return {
    name: text(row, "name"),
    position: integer(row, "position"),
    type: text(row, "type"),
    notNull: flag(row, "not_null"),
    default: isGenerated ? null : expression,
    generated: isGenerated ? generated : null,
    generationExpression: isGenerated ? expression : null,
    identity: identity === "none" ? null : identity,
  };
}

/**
 * Reads the catalogs for `exposedSchemas`. Run it on the engine itself or on a `tx` handle, as
 * the superuser: never after a role switch, a persona cannot see every catalog row.
 */
export async function introspect(
  engine: SqlEngine | SqlExecutor,
  exposedSchemas: readonly string[],
): Promise<Catalog> {
  const schemas = [...new Set(exposedSchemas)];
  const params = [JSON.stringify(schemas)];
  const rowsOf = async (sql: string, withSchemas = true): Promise<readonly SqlRow[]> =>
    (await engine.query(sql, withSchemas ? params : [])).rows;

  // Sequential on purpose: one connection, and a stable order of statements in any trace.
  const missing = await rowsOf(MISSING_SCHEMAS_SQL);
  const tableRows = await rowsOf(TABLES_SQL);
  const columnRows = await rowsOf(COLUMNS_SQL);
  const keyRows = await rowsOf(PRIMARY_KEYS_SQL);
  const policyRows = await rowsOf(POLICIES_SQL);
  const policyRoleRows = await rowsOf(POLICY_ROLES_SQL);
  const privilegeRows = await rowsOf(TABLE_PRIVILEGES_SQL);
  const roleRows = await rowsOf(ROLES_SQL, false);
  const membershipRows = await rowsOf(ROLE_MEMBERSHIPS_SQL, false);
  const viewRows = await rowsOf(VIEWS_SQL);
  const viewReferenceRows = await rowsOf(VIEW_REFERENCES_SQL);
  const functionRows = await rowsOf(FUNCTIONS_SQL);

  const columns = groupByRelation(columnRows, "schema", "table_name", readColumn);
  const keys = groupByRelation(keyRows, "schema", "table_name", (row) => text(row, "name"));
  const references = groupByRelation(
    viewReferenceRows,
    "schema",
    "view_name",
    (row): CatalogRelationRef => ({
      schema: text(row, "ref_schema"),
      name: text(row, "ref_name"),
      kind: RELATION_KINDS[text(row, "ref_kind")] ?? "other",
    }),
  );

  const policyRoles = new Map<string, string[]>();
  for (const row of policyRoleRows) {
    const key = JSON.stringify([text(row, "schema"), text(row, "table_name"), text(row, "name")]);
    const roles = policyRoles.get(key) ?? [];
    roles.push(text(row, "role"));
    policyRoles.set(key, roles);
  }

  const memberships = new Map<string, string[]>();
  for (const row of membershipRows) {
    const member = text(row, "member");
    const groups = memberships.get(member) ?? [];
    groups.push(text(row, "member_of"));
    memberships.set(member, groups);
  }

  return {
    exposedSchemas: schemas,
    missingSchemas: missing.map((row) => text(row, "name")),
    tables: tableRows.map((row): CatalogTable => {
      const key = relationKey(text(row, "schema"), text(row, "name"));
      return {
        schema: text(row, "schema"),
        name: text(row, "name"),
        owner: text(row, "owner"),
        rlsEnabled: flag(row, "rls_enabled"),
        rlsForced: flag(row, "rls_forced"),
        partitioned: flag(row, "partitioned"),
        columns: columns.get(key) ?? [],
        primaryKey: keys.get(key) ?? [],
      };
    }),
    policies: policyRows.map((row): CatalogPolicy => {
      const schema = text(row, "schema");
      const table = text(row, "table_name");
      const name = text(row, "name");
      return {
        schema,
        table,
        name,
        command: oneOf(row, "command", POLICY_COMMANDS),
        permissive: flag(row, "permissive"),
        roles: policyRoles.get(JSON.stringify([schema, table, name])) ?? [],
        using: textOrNull(row, "using_expr"),
        withCheck: textOrNull(row, "check_expr"),
      };
    }),
    tablePrivileges: privilegeRows.map((row): CatalogTablePrivilege => ({
      schema: text(row, "schema"),
      table: text(row, "table_name"),
      grantee: text(row, "grantee"),
      privilege: text(row, "privilege"),
      grantable: flag(row, "grantable"),
    })),
    roles: roleRows.map((row): CatalogRole => {
      const name = text(row, "name");
      return {
        name,
        superuser: flag(row, "superuser"),
        bypassRls: flag(row, "bypass_rls"),
        inherit: flag(row, "inherit"),
        canLogin: flag(row, "can_login"),
        memberOf: memberships.get(name) ?? [],
      };
    }),
    views: viewRows.map((row): CatalogView => {
      const schema = text(row, "schema");
      const name = text(row, "name");
      return {
        schema,
        name,
        owner: text(row, "owner"),
        materialized: flag(row, "materialized"),
        definition: text(row, "definition"),
        securityInvoker: flag(row, "security_invoker"),
        references: references.get(relationKey(schema, name)) ?? [],
      };
    }),
    functions: functionRows.map((row): CatalogFunction => ({
      schema: text(row, "schema"),
      name: text(row, "name"),
      identityArguments: text(row, "identity_arguments"),
      kind: oneOf(row, "kind", FUNCTION_KINDS),
      owner: text(row, "owner"),
      language: text(row, "language"),
      securityDefiner: flag(row, "security_definer"),
      searchPath: textOrNull(row, "search_path"),
    })),
  };
}

/** Looks a table up by its exact (case-sensitive) schema and name. */
export function findTable(
  catalog: Catalog,
  schema: string,
  name: string,
): CatalogTable | undefined {
  return catalog.tables.find((table) => table.schema === schema && table.name === name);
}
