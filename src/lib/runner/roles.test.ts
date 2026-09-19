import { describe, expect, it } from "vitest";
import type { Catalog, CatalogPolicy, CatalogRole } from "./introspect";
import { findRole, policiesFor, privilegeRolesOf, rlsBypassFor, roleWideBypass } from "./roles";

const role = (name: string, parts: Partial<CatalogRole> = {}): CatalogRole => ({
  name,
  superuser: false,
  bypassRls: false,
  inherit: true,
  canLogin: false,
  memberOf: [],
  ...parts,
});

const policy = (name: string, parts: Partial<CatalogPolicy> = {}): CatalogPolicy => ({
  schema: "public",
  table: "docs",
  name,
  command: "all",
  permissive: true,
  roles: ["PUBLIC"],
  using: "true",
  withCheck: null,
  ...parts,
});

const roles: CatalogRole[] = [
  role("postgres", { superuser: true, bypassRls: true }),
  role("service_role", { bypassRls: true }),
  role("app_owner"),
  role("app_user"),
  role("deputy", { memberOf: ["app_owner"] }),
  role("deputy_of_deputy", { memberOf: ["deputy"] }),
  role("noinherit_member", { inherit: false, memberOf: ["app_owner"] }),
  role("looped", { memberOf: ["looped", "app_user"] }),
];
const catalog: Pick<Catalog, "roles" | "policies"> = { roles, policies: [] };
const table = { owner: "app_owner", rlsEnabled: true, rlsForced: false };

describe("privilegeRolesOf", () => {
  it("follows memberships transitively while each hop inherits", () => {
    expect(privilegeRolesOf(catalog, "deputy_of_deputy")).toEqual([
      "app_owner",
      "deputy",
      "deputy_of_deputy",
    ]);
    expect(privilegeRolesOf(catalog, "noinherit_member")).toEqual(["noinherit_member"]);
    expect(privilegeRolesOf(catalog, "looped")).toEqual(["app_user", "looped"]);
    expect(privilegeRolesOf(catalog, "unknown")).toEqual(["unknown"]);
  });
});

describe("rlsBypassFor", () => {
  it("names the three bypasses", () => {
    expect(rlsBypassFor(catalog, "postgres", table)).toBe("superuser");
    expect(rlsBypassFor(catalog, "service_role", table)).toBe("bypassrls");
    expect(rlsBypassFor(catalog, "app_owner", table)).toBe("table-owner");
  });

  it("a member of the owner is the owner too, unless it does not inherit", () => {
    expect(rlsBypassFor(catalog, "deputy_of_deputy", table)).toBe("table-owner");
    expect(rlsBypassFor(catalog, "noinherit_member", table)).toBeNull();
  });

  it("FORCE puts the owner under the policies, not a BYPASSRLS role", () => {
    const forced = { ...table, rlsForced: true };
    expect(rlsBypassFor(catalog, "app_owner", forced)).toBeNull();
    expect(rlsBypassFor(catalog, "service_role", forced)).toBe("bypassrls");
  });

  it("says when RLS is simply off, and nothing for a plain role", () => {
    expect(rlsBypassFor(catalog, "app_user", { ...table, rlsEnabled: false })).toBe("rls-disabled");
    expect(rlsBypassFor(catalog, "app_user", table)).toBeNull();
    expect(rlsBypassFor(catalog, "unknown", table)).toBeNull();
  });

  it("role attributes are not inherited", () => {
    const withMember = { roles: [...roles, role("admin_member", { memberOf: ["service_role"] })] };
    expect(rlsBypassFor(withMember, "admin_member", table)).toBeNull();
    expect(roleWideBypass(role("x"))).toBeNull();
    expect(findRole(catalog, "app_user")?.name).toBe("app_user");
  });
});

describe("policiesFor", () => {
  const withPolicies: Pick<Catalog, "roles" | "policies"> = {
    roles,
    policies: [
      policy("all_public"),
      policy("select_owner_role", { command: "select", roles: ["app_owner"] }),
      policy("update_user", { command: "update", roles: ["app_user"], permissive: false }),
      policy("insert_other", { command: "insert", roles: ["service_role"] }),
      policy("other_table", { table: "notes" }),
      policy("other_schema", { schema: "private" }),
    ],
  };
  const docs = { schema: "public", name: "docs" };
  const names = (roleName: string, operation: Parameters<typeof policiesFor>[3]): string[] =>
    policiesFor(withPolicies, roleName, docs, operation).map(
      (entry) => `${entry.name}:${entry.appliesAs}`,
    );

  it("matches the command, ALL included, and the role, PUBLIC included", () => {
    expect(names("app_user", "select")).toEqual(["all_public:command"]);
    expect(names("app_user", "insert")).toEqual(["all_public:command"]);
    expect(names("service_role", "insert")).toEqual(["all_public:command", "insert_other:command"]);
  });

  it("matches through role membership", () => {
    expect(names("deputy", "select")).toEqual(["all_public:command", "select_owner_role:command"]);
    expect(names("noinherit_member", "select")).toEqual(["all_public:command"]);
  });

  it("lists SELECT policies as visibility for UPDATE and DELETE", () => {
    expect(names("app_owner", "update")).toEqual([
      "all_public:command",
      "select_owner_role:visibility",
    ]);
    expect(names("app_owner", "delete")).toEqual([
      "all_public:command",
      "select_owner_role:visibility",
    ]);
    expect(names("app_user", "update")).toEqual(["all_public:command", "update_user:command"]);
  });

  it("keeps the policy's text for the details drawer", () => {
    expect(policiesFor(withPolicies, "app_user", docs, "update")[1]).toEqual({
      name: "update_user",
      command: "update",
      permissive: false,
      roles: ["app_user"],
      using: "true",
      withCheck: null,
      appliesAs: "command",
    });
  });
});
