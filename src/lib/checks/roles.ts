/**
 * Which roles matter to the checks. An application role is a role a request can run as: the API
 * roles in `supabase` mode, the personas' roles in both modes. Roles that bypass row level
 * security anyway (`service_role`, a superuser, BYPASSRLS) are never application roles here: a
 * policy, an owner or FORCE changes nothing for them.
 */
import type { Catalog } from "@/lib/runner/introspect";
import { compareText } from "@/lib/scenario";
import type { StaticCheckContext } from "./types";

export const PUBLIC_GRANTEE = "PUBLIC";
export const ANON_ROLE = "anon";
export const SERVICE_ROLE = "service_role";
const SUPABASE_REQUEST_ROLES = [ANON_ROLE, "authenticated"] as const;

/** `service_role` by name (brief 3.6), and any role the catalog marks superuser or BYPASSRLS. */
export function bypassesRls(catalog: Pick<Catalog, "roles">, role: string): boolean {
  if (role === SERVICE_ROLE) {
    return true;
  }
  const entry = catalog.roles.find((candidate) => candidate.name === role);
  return entry !== undefined && (entry.superuser || entry.bypassRls);
}

/** Sorted, unique. */
export function applicationRoles(
  catalog: Pick<Catalog, "roles">,
  context: StaticCheckContext,
): string[] {
  const names = new Set<string>(context.personas.map((persona) => persona.dbRole));
  if (context.mode === "supabase") {
    for (const role of SUPABASE_REQUEST_ROLES) {
      names.add(role);
    }
  }
  return [...names].filter((role) => !bypassesRls(catalog, role)).sort(compareText);
}

/**
 * `role` and every role whose privileges it holds through membership. Ownership is such a
 * privilege, so a member of the owning role bypasses row level security like the owner does. A
 * role with NOINHERIT gets them only after SET ROLE and is not followed. (Since PostgreSQL 16
 * inheritance is recorded per membership; the catalog model carries the role's default, which is
 * what every `GRANT role TO role` without an INHERIT option uses.)
 */
export function privilegesOf(catalog: Pick<Catalog, "roles">, role: string): Set<string> {
  const seen = new Set<string>([role]);
  const queue = [role];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const entry = catalog.roles.find((candidate) => candidate.name === next);
    if (!entry?.inherit) {
      continue;
    }
    for (const group of entry.memberOf) {
      if (!seen.has(group)) {
        seen.add(group);
        queue.push(group);
      }
    }
  }
  return seen;
}
