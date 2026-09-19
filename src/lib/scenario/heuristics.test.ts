import { describe, expect, it } from "vitest";

import {
  OWNER_COLUMN_NAMES,
  TENANT_COLUMN_NAMES,
  compareText,
  resolveTableConfigs,
  suggestTableConfig,
} from "./heuristics";

describe("suggestTableConfig", () => {
  it("carries the name lists of the brief, in priority order", () => {
    expect(OWNER_COLUMN_NAMES).toEqual(["user_id", "owner_id", "created_by"]);
    expect(TENANT_COLUMN_NAMES).toEqual([
      "tenant_id",
      "org_id",
      "organization_id",
      "team_id",
      "workspace_id",
    ]);
  });

  it.each(OWNER_COLUMN_NAMES.map((name) => [name] as const))("suggests %s as owner", (name) => {
    expect(suggestTableConfig(["id", name, "title"])).toEqual({ ownerColumn: name });
  });

  it.each(TENANT_COLUMN_NAMES.map((name) => [name] as const))("suggests %s as tenant", (name) => {
    expect(suggestTableConfig(["id", name, "title"])).toEqual({ tenantColumn: name });
  });

  it("suggests both when both are present", () => {
    expect(suggestTableConfig(["id", "team_id", "created_by"])).toEqual({
      ownerColumn: "created_by",
      tenantColumn: "team_id",
    });
  });

  it("suggests nothing for unrelated columns and leaves the keys out", () => {
    const suggestion = suggestTableConfig([
      "id",
      "title",
      "user",
      "userid",
      "tenant",
      "user_id_old",
    ]);
    expect(suggestion).toEqual({});
    expect(Object.keys(suggestion)).toEqual([]);
    expect(suggestTableConfig([])).toEqual({});
  });

  it("follows the priority of the list, not the order of the columns", () => {
    expect(suggestTableConfig(["created_by", "owner_id", "user_id"]).ownerColumn).toBe("user_id");
    expect(suggestTableConfig(["created_by", "owner_id"]).ownerColumn).toBe("owner_id");
    expect(suggestTableConfig(["workspace_id", "team_id", "org_id"]).tenantColumn).toBe("org_id");
  });

  it("ignores case and returns the column as the catalog spells it", () => {
    expect(suggestTableConfig(["ID", "User_Id", "TENANT_ID"])).toEqual({
      ownerColumn: "User_Id",
      tenantColumn: "TENANT_ID",
    });
  });

  it("prefers the lower-case spelling, then code-unit order, whatever the input order", () => {
    expect(suggestTableConfig(["USER_ID", "user_id", "User_Id"]).ownerColumn).toBe("user_id");
    expect(suggestTableConfig(["User_Id", "user_id", "USER_ID"]).ownerColumn).toBe("user_id");
    expect(suggestTableConfig(["User_Id", "USER_ID"]).ownerColumn).toBe("USER_ID");
    expect(suggestTableConfig(["USER_ID", "User_Id"]).ownerColumn).toBe("USER_ID");
  });

  it("does not change its input", () => {
    const columns = ["User_Id", "USER_ID"];
    suggestTableConfig(columns);
    expect(columns).toEqual(["User_Id", "USER_ID"]);
  });
});

describe("compareText", () => {
  it("orders by code unit, not by locale", () => {
    expect(compareText("a", "a")).toBe(0);
    expect(compareText("B", "a")).toBe(-1);
    expect(compareText("a", "B")).toBe(1);
    expect(["b", "a", "B", "ä", "A"].sort(compareText)).toEqual(["A", "B", "a", "b", "ä"]);
  });
});

describe("resolveTableConfigs", () => {
  const introspected = [
    { schema: "public", name: "todos", columns: ["id", "user_id"] },
    { schema: "public", name: "audit_log", columns: ["id", "message"] },
    { schema: "api", name: "projects", columns: ["id", "org_id", "created_by"] },
  ];

  it("suggests a config for every introspected table, sorted by schema and name", () => {
    expect(resolveTableConfigs([], introspected)).toEqual([
      { schema: "api", name: "projects", ownerColumn: "created_by", tenantColumn: "org_id" },
      { schema: "public", name: "audit_log" },
      { schema: "public", name: "todos", ownerColumn: "user_id" },
    ]);
  });

  it("keeps the user's config exactly, also when it removes a suggested column", () => {
    const configured = [
      { schema: "public", name: "todos" },
      { schema: "api", name: "projects", tenantColumn: "created_by" },
    ];
    const resolved = resolveTableConfigs(configured, introspected);
    expect(resolved).toEqual([
      { schema: "api", name: "projects", tenantColumn: "created_by" },
      { schema: "public", name: "audit_log" },
      { schema: "public", name: "todos" },
    ]);
    expect(resolved[2]).not.toBe(configured[0]);
  });

  it("drops configs of tables that do not exist and matches on schema and name", () => {
    const configured = [
      { schema: "public", name: "gone", ownerColumn: "user_id" },
      { schema: "other", name: "todos", ownerColumn: "nobody" },
    ];
    expect(resolveTableConfigs(configured, introspected.slice(0, 1))).toEqual([
      { schema: "public", name: "todos", ownerColumn: "user_id" },
    ]);
  });

  it("does not reorder its input", () => {
    const input = [...introspected];
    resolveTableConfigs([], input);
    expect(input).toEqual(introspected);
  });
});
