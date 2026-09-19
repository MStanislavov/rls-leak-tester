/**
 * The nine rules as data. The semantics of each were confirmed in the official documentation on
 * 2026-09-19 (draft ADR static-checks quotes the sentences); `docsUrl` is that page.
 */
import type { CheckId, StaticCheckRule } from "./types";

const PG = "https://www.postgresql.org/docs/current";
const SUPABASE = "https://supabase.com/docs/guides";

export const DOCS = {
  rowSecurity: `${PG}/ddl-rowsecurity.html`,
  createPolicy: `${PG}/sql-createpolicy.html`,
  createView: `${PG}/sql-createview.html`,
  createMaterializedView: `${PG}/sql-creatematerializedview.html`,
  securityDefiner: `${PG}/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY`,
  grant: `${PG}/sql-grant.html`,
  supabaseRls: `${SUPABASE}/database/postgres/row-level-security`,
  supabaseApi: `${SUPABASE}/api/securing-your-api`,
} as const;

export const STATIC_CHECK_RULES: readonly StaticCheckRule[] = [
  {
    id: "RLS001",
    severity: "critical",
    title: "Row level security is not enabled",
    summary:
      "A table in an exposed schema has row level security switched off. Without it the SQL privilege system is the only barrier, and every role with a grant reaches every row.",
    docsUrl: DOCS.rowSecurity,
    modes: "all",
  },
  {
    id: "RLS002",
    severity: "info",
    title: "Row level security is enabled but there is no policy",
    summary:
      "With no policy Postgres uses a default-deny policy: no row is visible or can be modified by a role that does not bypass row level security. Safe, but usually not what the application needs.",
    docsUrl: DOCS.rowSecurity,
    modes: "all",
  },
  {
    id: "RLS003",
    severity: "high",
    title: "A policy admits every row",
    summary:
      "A permissive policy whose USING or WITH CHECK is the constant true, for a role other than service_role (no TO clause means PUBLIC, every role). Permissive policies are OR-ed, so this one opens the command whatever the other policies say. A restrictive policy with true restricts nothing and is not flagged; a tautology such as (1 = 1) is not evaluated.",
    docsUrl: DOCS.createPolicy,
    modes: "all",
  },
  {
    id: "RLS004",
    severity: "high",
    title: "WITH CHECK is looser than USING",
    summary:
      "An UPDATE or ALL policy whose explicit WITH CHECK accepts new rows that its USING would not show: a user can move a row out of their own scope. A missing WITH CHECK is not flagged, Postgres then applies USING to the new row. Decided only for WITH CHECK (true), for a WITH CHECK that drops AND-ed conditions of USING, and for one that adds OR alternatives; two different conditions are never compared.",
    docsUrl: DOCS.createPolicy,
    modes: "all",
  },
  {
    id: "RLS005",
    severity: "high",
    title: "A policy trusts user_metadata",
    summary:
      "The policy reads user_metadata from the JWT (or raw_user_meta_data from auth.users). The signed-in user can change that data, so it must not decide access; app_metadata cannot be changed by the user and is the place for authorization data. A helper function that reads user_metadata inside its body is not seen.",
    docsUrl: DOCS.supabaseRls,
    modes: "supabase",
  },
  {
    id: "RLS006",
    severity: "medium",
    title: "Write privileges for PUBLIC or anon",
    summary:
      "INSERT, UPDATE, DELETE or TRUNCATE is granted to PUBLIC (every role, also future ones) or to anon. TRUNCATE is not subject to row level security at all. In Supabase mode the grants the platform makes by itself are not reported: the legacy blanket grants to anon, and the TRUNCATE that remains under explicit grants.",
    docsUrl: DOCS.grant,
    modes: "all",
  },
  {
    id: "RLS007",
    severity: "medium",
    title: "SECURITY DEFINER function without a pinned search_path",
    summary:
      "The function runs with its owner's privileges and resolves unqualified names through the caller's search_path, so a caller can point a name at an object of their own. Pin it with SET search_path.",
    docsUrl: DOCS.securityDefiner,
    modes: "all",
  },
  {
    id: "RLS008",
    severity: "high",
    title: "A view bypasses the row level security of its tables",
    summary:
      "A view without security_invoker = true reads its tables with the view owner's permissions and policies, not the caller's. Flagged when the view selects from a table with row level security enabled and an application role can reach the view. A materialized view stores the owner's result and cannot be a security invoker at all.",
    docsUrl: DOCS.createView,
    modes: "all",
  },
  {
    id: "RLS009",
    severity: "info",
    title: "An application role owns the table without FORCE ROW LEVEL SECURITY",
    summary:
      "Table owners bypass row level security unless the table has FORCE ROW LEVEL SECURITY. When the owner is a role the application connects as, its queries skip every policy.",
    docsUrl: DOCS.rowSecurity,
    modes: "all",
  },
];

const RULES_BY_ID = new Map<CheckId, StaticCheckRule>(
  STATIC_CHECK_RULES.map((rule) => [rule.id, rule]),
);

/** The rule behind an id. Throws for an id without a rule, which a test rules out. */
export function ruleById(id: CheckId): StaticCheckRule {
  const rule = RULES_BY_ID.get(id);
  if (rule === undefined) {
    throw new RangeError(`No static check rule ${id}`);
  }
  return rule;
}
