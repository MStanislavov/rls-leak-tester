import { describe, expect, it } from "vitest";

import { getClaimPath, isUuid, personaSub, personaTenant } from "./claims";

describe("isUuid", () => {
  it.each([
    ["00000000-0000-0000-0000-000000000001"],
    ["3F2504E0-4F89-41D3-9A0C-0305E82C3301"],
    ["ffffffff-ffff-ffff-ffff-ffffffffffff"],
  ])("accepts %s", (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    [""],
    ["alice"],
    ["00000000000000000000000000000001"],
    ["{00000000-0000-0000-0000-000000000001}"],
    ["00000000-0000-0000-0000-00000000000g"],
    [" 00000000-0000-0000-0000-000000000001"],
    ["00000000-0000-0000-0000-000000000001\n"],
    [1],
    [null],
    [undefined],
  ])("refuses %j", (value) => {
    expect(isUuid(value)).toBe(false);
  });
});

describe("getClaimPath", () => {
  const claims = {
    sub: "u1",
    tenant_id: "t1",
    app_metadata: { tenant_id: "t2", roles: ["admin", { name: "owner" }], nothing: null },
    "": "empty key",
  };

  it("reads a top-level claim", () => {
    expect(getClaimPath(claims, "tenant_id")).toBe("t1");
  });

  it("follows a dot path through objects", () => {
    expect(getClaimPath(claims, "app_metadata.tenant_id")).toBe("t2");
  });

  it("indexes arrays with whole numbers only", () => {
    expect(getClaimPath(claims, "app_metadata.roles.0")).toBe("admin");
    expect(getClaimPath(claims, "app_metadata.roles.1.name")).toBe("owner");
    expect(getClaimPath(claims, "app_metadata.roles.2")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata.roles.01")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata.roles.length")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata.roles.-1")).toBeUndefined();
  });

  it("returns undefined for a missing key, a scalar on the way and null on the way", () => {
    expect(getClaimPath(claims, "missing")).toBeUndefined();
    expect(getClaimPath(claims, "sub.length")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata.nothing.x")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata.nothing")).toBeNull();
  });

  it("returns undefined for an empty path or an empty segment", () => {
    expect(getClaimPath(claims, "")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata..tenant_id")).toBeUndefined();
    expect(getClaimPath(claims, ".sub")).toBeUndefined();
    expect(getClaimPath(claims, "sub.")).toBeUndefined();
  });

  it("never reaches the prototype", () => {
    expect(getClaimPath(claims, "constructor")).toBeUndefined();
    expect(getClaimPath(claims, "__proto__")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata.toString")).toBeUndefined();
    expect(getClaimPath(claims, "app_metadata.constructor.name")).toBeUndefined();
  });

  it("reads an own __proto__ key that came from JSON", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"tenant_id":"t9"}}');
    expect(getClaimPath(parsed as Record<string, unknown>, "__proto__.tenant_id")).toBe("t9");
  });
});

describe("personaSub", () => {
  it("returns the sub claim as text", () => {
    expect(personaSub({ claims: { sub: "00000000-0000-0000-0000-000000000001" } })).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(personaSub({ claims: { sub: 42 } })).toBe("42");
  });

  it.each([[undefined], [null], [""], [true], [{ id: 1 }], [["a"]], [Number.NaN], [Infinity]])(
    "returns undefined for the sub %j",
    (sub) => {
      expect(personaSub({ claims: { sub } })).toBeUndefined();
    },
  );

  it("returns undefined without a sub claim", () => {
    expect(personaSub({ claims: {} })).toBeUndefined();
  });
});

describe("personaTenant", () => {
  const claims = { tenant_id: "t1", app_metadata: { tenant_id: 7 }, flags: { tenant: true } };

  it("reads the tenant at the persona's claim path", () => {
    expect(personaTenant({ claims, tenantClaimPath: "tenant_id" })).toBe("t1");
    expect(personaTenant({ claims, tenantClaimPath: "app_metadata.tenant_id" })).toBe("7");
  });

  it("returns undefined without a path, for a missing claim and for a non-scalar", () => {
    expect(personaTenant({ claims })).toBeUndefined();
    expect(personaTenant({ claims, tenantClaimPath: "org_id" })).toBeUndefined();
    expect(personaTenant({ claims, tenantClaimPath: "app_metadata" })).toBeUndefined();
    expect(personaTenant({ claims, tenantClaimPath: "flags.tenant" })).toBeUndefined();
  });
});
