/** RLS001, RLS002, RLS006 and RLS009: what the tables, their grants and their owners say. */
import type { Catalog, CatalogTable, CatalogTablePrivilege } from "@/lib/runner/introspect";
import { resolveOptions } from "@/lib/scenario";
import { evidence, finding, tableObject, yesNo } from "./finding";
import { DOCS } from "./rules";
import { ANON_ROLE, PUBLIC_GRANTEE, applicationRoles, privilegesOf } from "./roles";
import type { Finding, FindingEvidence, StaticCheckContext } from "./types";

const ROW_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;
const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;

function privilegesOn(
  catalog: Catalog,
  table: Pick<CatalogTable, "schema" | "name">,
): readonly CatalogTablePrivilege[] {
  return catalog.tablePrivileges.filter(
    (entry) => entry.schema === table.schema && entry.table === table.name,
  );
}

/** `grantee: PRIV, PRIV` lines in the order of `grantees` and of `wanted`. */
function privilegeEvidence(
  privileges: readonly CatalogTablePrivilege[],
  grantees: readonly string[],
  wanted: readonly string[],
): FindingEvidence[] {
  const lines: FindingEvidence[] = [];
  for (const grantee of grantees) {
    const held = wanted.filter((privilege) =>
      privileges.some((entry) => entry.grantee === grantee && entry.privilege === privilege),
    );
    if (held.length > 0) {
      lines.push(evidence(`granted to ${grantee}`, held.join(", ")));
    }
  }
  return lines;
}

/** RLS001: a table in an exposed schema with row level security not enabled. */
export function checkRlsDisabled(catalog: Catalog, context: StaticCheckContext): Finding[] {
  const grantees = [PUBLIC_GRANTEE, ...applicationRoles(catalog, context)];
  return catalog.tables
    .filter((table) => !table.rlsEnabled)
    .map((table) => {
      const grants = privilegeEvidence(privilegesOn(catalog, table), grantees, ROW_PRIVILEGES);
      const reach =
        grants.length > 0
          ? "The grants below are therefore the only barrier: each of these roles reaches every row of the table with them."
          : "No application role holds a privilege on it right now, so a single GRANT would expose every row.";
      return finding("RLS001", tableObject(table), {
        explanation: `Row level security is not enabled on this table, which is in an exposed schema. Without it Postgres only checks the SQL privileges, and a role with a privilege gets all rows, not some. ${reach} Enable it with ALTER TABLE ... ENABLE ROW LEVEL SECURITY and add policies.`,
        evidence: [
          evidence("row level security", "not enabled"),
          evidence("owner", table.owner),
          ...grants,
        ],
        docsUrl: context.mode === "supabase" ? DOCS.supabaseApi : DOCS.rowSecurity,
      });
    });
}

/** RLS002: row level security enabled, no policy at all (default deny). */
export function checkNoPolicies(catalog: Catalog): Finding[] {
  return catalog.tables
    .filter(
      (table) =>
        table.rlsEnabled &&
        !catalog.policies.some(
          (policy) => policy.schema === table.schema && policy.table === table.name,
        ),
    )
    .map((table) =>
      finding("RLS002", tableObject(table), {
        explanation:
          "Row level security is enabled and the table has no policy, so Postgres applies a default-deny policy: no row is visible and none can be inserted, updated or deleted, except by the owner (unless FORCE ROW LEVEL SECURITY is set), superusers and roles with BYPASSRLS. That is safe. It is reported because a table the application cannot use is usually unfinished work, and the matrix will show it as overblocking.",
        evidence: [
          evidence("row level security", "enabled"),
          evidence("policies", "0"),
          evidence("force row level security", yesNo(table.rlsForced)),
        ],
      }),
    );
}

/**
 * Which privileges of `anon` are the user's own doing. In `supabase` mode the tool applies the
 * platform's default grants itself, and the catalog cannot tell them from a GRANT in the user's
 * SQL, so they are not reported: under `legacy` that is everything (anon holds ALL on every
 * table, by design; row level security is the barrier and RLS001 and the matrix cover it), under
 * `explicit` it is TRUNCATE, which is what the platform's revoke leaves behind. PUBLIC is never
 * granted anything by the tool.
 */
function reportableAnonPrivileges(context: StaticCheckContext): readonly string[] {
  if (context.mode !== "supabase") {
    return WRITE_PRIVILEGES;
  }
  return resolveOptions(context).supabaseGrants === "legacy" ? [] : ["INSERT", "UPDATE", "DELETE"];
}

/** RLS006: INSERT, UPDATE, DELETE or TRUNCATE granted to PUBLIC or anon. One finding per table. */
export function checkPublicWriteGrants(catalog: Catalog, context: StaticCheckContext): Finding[] {
  const anonPrivileges = reportableAnonPrivileges(context);
  const findings: Finding[] = [];
  for (const table of catalog.tables) {
    const privileges = privilegesOn(catalog, table);
    const lines = [
      ...privilegeEvidence(privileges, [PUBLIC_GRANTEE], WRITE_PRIVILEGES),
      ...privilegeEvidence(privileges, [ANON_ROLE], anonPrivileges),
    ];
    if (lines.length === 0) {
      continue;
    }
    const truncate = lines.some((line) => line.value.includes("TRUNCATE"));
    findings.push(
      finding("RLS006", tableObject(table), {
        explanation: `Write privileges on this table are granted to PUBLIC or anon. PUBLIC is every role, including roles created later, and anon is every unauthenticated request. ${
          table.rlsEnabled
            ? "Row level security is enabled, so the policies decide which rows such a write reaches; one permissive policy that applies to these roles is enough to open it."
            : "Row level security is not enabled, so nothing restricts these writes to particular rows."
        }${
          truncate
            ? " TRUNCATE is not subject to row level security at all: whoever holds it can empty the table."
            : ""
        } Grant write privileges only to the roles that need them.`,
        evidence: [...lines, evidence("row level security", yesNo(table.rlsEnabled))],
        docsUrl: context.mode === "supabase" ? DOCS.supabaseApi : DOCS.grant,
      }),
    );
  }
  return findings;
}

/** RLS009: the owner is an application role (or one is a member of it) and FORCE is not set. */
export function checkOwnerIsApplicationRole(
  catalog: Catalog,
  context: StaticCheckContext,
): Finding[] {
  const roles = applicationRoles(catalog, context);
  const findings: Finding[] = [];
  for (const table of catalog.tables) {
    if (!table.rlsEnabled || table.rlsForced) {
      continue;
    }
    const owning = roles.filter((role) => privilegesOf(catalog, role).has(table.owner));
    if (owning.length === 0) {
      continue;
    }
    const described = owning.map((role) =>
      role === table.owner ? role : `${role} (member of ${table.owner})`,
    );
    findings.push(
      finding("RLS009", tableObject(table), {
        explanation:
          "The table is owned by a role the application runs as, or by a role it is a member of, and FORCE ROW LEVEL SECURITY is not set. Table owners bypass row level security, so every policy on this table is skipped for that role, and a matrix probe under it proves nothing. Set ALTER TABLE ... FORCE ROW LEVEL SECURITY, or give the table to a role that no request runs as.",
        evidence: [
          evidence("owner", table.owner),
          evidence("application roles with the owner's rights", described.join(", ")),
          evidence("force row level security", "no"),
        ],
      }),
    );
  }
  return findings;
}
