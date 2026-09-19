/** RLS007 and RLS008: functions and views, the two objects that run with their owner's rights. */
import type { Catalog, CatalogTable, CatalogView } from "@/lib/runner/introspect";
import { qualifiedName } from "@/lib/scenario";
import { evidence, finding, functionObject, viewObject } from "./finding";
import { DOCS } from "./rules";
import { PUBLIC_GRANTEE, applicationRoles, bypassesRls, privilegesOf } from "./roles";
import type { Finding, StaticCheckContext } from "./types";

/** The Supabase shim's own functions (src/lib/engine/supabase-shim.ts): not the user's code. */
const SHIM_SCHEMA = "auth";
const SHIM_FUNCTIONS: readonly string[] = ["uid", "role", "email", "jwt"];

/** RLS007: SECURITY DEFINER and no `search_path` entry in `proconfig`. */
export function checkSecurityDefinerSearchPath(
  catalog: Catalog,
  context: StaticCheckContext,
): Finding[] {
  return catalog.functions
    .filter((fn) => fn.securityDefiner && fn.searchPath === null)
    .filter(
      (fn) =>
        !(
          context.mode === "supabase" &&
          fn.schema === SHIM_SCHEMA &&
          SHIM_FUNCTIONS.includes(fn.name)
        ),
    )
    .map((fn) =>
      finding("RLS007", functionObject(fn), {
        explanation: `This ${fn.kind} is SECURITY DEFINER, so it runs with the privileges of its owner, and it does not pin search_path. Unqualified table, function and operator names inside it are then resolved through the caller's search_path: a caller who can create objects in any schema on that path, or in their temporary schema, can make the ${fn.kind} run their object with the owner's rights. Add SET search_path = '' and schema-qualify the names, or list only trusted schemas with pg_temp last.`,
        evidence: [
          evidence("security definer", "yes"),
          evidence("search_path", "not set"),
          evidence("owner", fn.owner),
          evidence("language", fn.language),
        ],
      }),
    );
}

const VIEW_PRIVILEGES: readonly string[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/**
 * Who can reach the view. Introspection lists the privileges of views beside those of tables (the
 * owner's implicit ones included), and they decide. A catalog without any row for the view, which
 * only a hand-built one can be, makes no claim: the view then counts as reachable because it sits
 * in an exposed schema, and the evidence says that this was assumed.
 */
function reachability(
  catalog: Catalog,
  view: CatalogView,
  roles: readonly string[],
): { reachable: boolean; text: string } {
  const entries = catalog.tablePrivileges.filter(
    (entry) => entry.schema === view.schema && entry.table === view.name,
  );
  if (entries.length === 0) {
    return {
      reachable: true,
      text: "assumed: the view is in an exposed schema (its privileges are not part of the catalog snapshot)",
    };
  }
  const grantees = [PUBLIC_GRANTEE, ...roles].filter((role) =>
    entries.some((entry) => entry.grantee === role && VIEW_PRIVILEGES.includes(entry.privilege)),
  );
  return { reachable: grantees.length > 0, text: grantees.join(", ") };
}

/** How the view owner stands towards the row level security of one table. */
function ownerStanding(catalog: Catalog, view: CatalogView, table: CatalogTable): string {
  const name = qualifiedName(table.schema, table.name);
  if (bypassesRls(catalog, view.owner)) {
    return `${name}: skipped entirely, the view owner is a superuser or has BYPASSRLS`;
  }
  if (!table.rlsForced && privilegesOf(catalog, view.owner).has(table.owner)) {
    return `${name}: skipped entirely, the view owner owns the table and FORCE is not set`;
  }
  return `${name}: the policies that apply to the view owner are used, not the caller's`;
}

/** RLS008: a view over a table with RLS enabled, without `security_invoker = true`. */
export function checkViewsBypassingRls(catalog: Catalog, context: StaticCheckContext): Finding[] {
  const roles = applicationRoles(catalog, context);
  const findings: Finding[] = [];
  for (const view of catalog.views) {
    if (view.securityInvoker) {
      continue;
    }
    const protectedTables = view.references
      .filter((reference) => reference.kind === "table")
      .map((reference) =>
        catalog.tables.find(
          (table) => table.schema === reference.schema && table.name === reference.name,
        ),
      )
      .filter((table): table is CatalogTable => table !== undefined && table.rlsEnabled);
    const reach = reachability(catalog, view, roles);
    if (protectedTables.length === 0 || !reach.reachable) {
      continue;
    }
    const remedy = view.materialized
      ? "A materialized view stores the rows its owner saw when it was last refreshed, it cannot have policies and security_invoker does not exist for it: keep it out of the exposed schemas, or revoke it from the application roles and serve it through a function or a view that filters."
      : "Recreate it WITH (security_invoker = true), or ALTER VIEW ... SET (security_invoker = true), so that the caller's privileges and policies apply, and check that the caller has the grants the view then needs.";
    findings.push(
      finding("RLS008", viewObject(view), {
        explanation: `This ${
          view.materialized ? "materialized view" : "view"
        } selects from a table with row level security enabled and is not a security invoker view. By default a view reads its tables with the permissions of the view owner, and the row level security policies of the view owner are applied, not those of the role that queries the view. The owner is usually the role that ran the migration, which bypasses row level security, so the view returns rows the caller's policies would hide. ${remedy}`,
        evidence: [
          evidence(
            "security_invoker",
            view.materialized ? "not available for a materialized view" : "not set",
          ),
          evidence("view owner", view.owner),
          ...protectedTables.map((table) =>
            evidence("row level security of", ownerStanding(catalog, view, table)),
          ),
          evidence("reachable by", reach.text),
        ],
        docsUrl: view.materialized ? DOCS.createMaterializedView : DOCS.createView,
      }),
    );
  }
  return findings;
}
