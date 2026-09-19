/**
 * What the catalog says about a persona's role: does it exist, does row level security apply to
 * it on a table, and which policies apply to it. Pure functions over `Catalog`.
 *
 * The three bypasses (brief 3.5, RUN-001): a superuser, a role with BYPASSRLS, and the table
 * owner unless the table has FORCE ROW LEVEL SECURITY. A persona may legitimately be such a role
 * (Supabase's `service_role`), so the runner does not refuse it; it probes as that role, reports
 * what the role really reaches, and FLAGS the cell, so that a bypass is never silent.
 *
 * Role attributes (SUPERUSER, BYPASSRLS) are never inherited through membership. Ownership is:
 * Postgres treats a role as the owner when it has the privileges of the owning role, that is the
 * role itself or a member of it, as long as every hop of the membership inherits. The catalog
 * carries the role-level INHERIT flag, which is what a plain `GRANT role TO member` uses.
 */
import { compareText, type Operation } from "@/lib/scenario";
import {
  PUBLIC_ROLE,
  type Catalog,
  type CatalogPolicy,
  type CatalogRole,
  type CatalogTable,
} from "./introspect";
import type { CellPolicy, RlsBypass } from "./result";

export function findRole(catalog: Pick<Catalog, "roles">, name: string): CatalogRole | undefined {
  return catalog.roles.find((role) => role.name === name);
}

/**
 * The role itself plus every role whose privileges it has: memberships followed transitively,
 * each hop only when the member role inherits. Sorted.
 */
export function privilegeRolesOf(catalog: Pick<Catalog, "roles">, name: string): string[] {
  const seen = new Set<string>([name]);
  const queue = [name];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const role = findRole(catalog, next);
    if (role?.inherit !== true) {
      continue;
    }
    for (const parent of role.memberOf) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return [...seen].sort(compareText);
}

/** The bypass that holds on every table, or `null`. */
export function roleWideBypass(
  role: Pick<CatalogRole, "superuser" | "bypassRls">,
): Extract<RlsBypass, "superuser" | "bypassrls"> | null {
  if (role.superuser) {
    return "superuser";
  }
  return role.bypassRls ? "bypassrls" : null;
}

/** Why RLS does not restrict `roleName` on `table`, or `null` when the policies decide. */
export function rlsBypassFor(
  catalog: Pick<Catalog, "roles">,
  roleName: string,
  table: Pick<CatalogTable, "owner" | "rlsEnabled" | "rlsForced">,
): RlsBypass | null {
  const role = findRole(catalog, roleName);
  const roleWide = role === undefined ? null : roleWideBypass(role);
  if (roleWide !== null) {
    return roleWide;
  }
  if (!table.rlsEnabled) {
    return "rls-disabled";
  }
  if (!table.rlsForced && privilegeRolesOf(catalog, roleName).includes(table.owner)) {
    return "table-owner";
  }
  return null;
}

function toCellPolicy(policy: CatalogPolicy, appliesAs: CellPolicy["appliesAs"]): CellPolicy {
  return {
    name: policy.name,
    command: policy.command,
    permissive: policy.permissive,
    roles: policy.roles,
    using: policy.using,
    withCheck: policy.withCheck,
    appliesAs,
  };
}

/**
 * The policies that apply to one cell, in catalog order. A policy applies when it is on the
 * table, its command is the operation or ALL, and its roles contain PUBLIC, the role, or a role
 * whose privileges the role has. For UPDATE and DELETE the SELECT policies are listed too
 * (`appliesAs: "visibility"`): Postgres applies them to any statement that reads the row through
 * WHERE or RETURNING, which is what the reach probes do (ADR 0002 claim 6).
 */
export function policiesFor(
  catalog: Pick<Catalog, "roles" | "policies">,
  roleName: string,
  table: Pick<CatalogTable, "schema" | "name">,
  operation: Operation,
): CellPolicy[] {
  const roles = new Set([PUBLIC_ROLE, ...privilegeRolesOf(catalog, roleName)]);
  const readsRows = operation === "update" || operation === "delete";
  const applicable: CellPolicy[] = [];
  for (const policy of catalog.policies) {
    if (policy.schema !== table.schema || policy.table !== table.name) {
      continue;
    }
    if (!policy.roles.some((role) => roles.has(role))) {
      continue;
    }
    if (policy.command === "all" || policy.command === operation) {
      applicable.push(toCellPolicy(policy, "command"));
    } else if (readsRows && policy.command === "select") {
      applicable.push(toCellPolicy(policy, "visibility"));
    }
  }
  return applicable;
}
