import { describe, expect, it } from "vitest";
import type { GroundTruthRow, GroundTruthSnapshot } from "./ground-truth";
import type { CatalogColumn } from "./introspect";
import {
  blindUpdateColumns,
  chooseUpdateColumn,
  claimsJsonOf,
  cloneColumns,
  effectiveClaims,
  expectedKeysForScope,
  isWritable,
  personaFacts,
  planEscape,
  planFreshKey,
  planInsertClasses,
  planTenantEscape,
  pullMoves,
  textMembership,
  type EscapeInput,
} from "./plan";
import type { Scope } from "@/lib/scenario";

const k = (...values: (string | number)[]): string => JSON.stringify(values.map(String));

const column = (name: string, parts: Partial<CatalogColumn> = {}): CatalogColumn => ({
  name,
  position: 1,
  type: "text",
  notNull: false,
  default: null,
  generated: null,
  generationExpression: null,
  identity: null,
  ...parts,
});

const row = (key: string, owner: string | null, tenant: string | null): GroundTruthRow => ({
  key,
  owner,
  tenant,
});

const truthOf = (
  rows: GroundTruthRow[],
  parts: Partial<GroundTruthSnapshot> = {},
): GroundTruthSnapshot => ({
  status: "ok",
  schema: "public",
  name: "docs",
  primaryKey: ["id"],
  ownerColumn: "owner_id",
  tenantColumn: "tenant_id",
  rows,
  ...parts,
});

const rows = [
  row(k(1), "alice", "t1"),
  row(k(2), "bob", "t1"),
  row(k(3), "bob", "t2"),
  row(k(4), null, null),
];
const truth = truthOf(rows);
const alice = { sub: "alice", tenant: "t1", tenantClaimConfigured: true };
const aliceRows = textMembership(truth, alice);

describe("personas", () => {
  it("reads sub and tenant from the claims", () => {
    expect(
      personaFacts({
        claims: { sub: "alice", app_metadata: { tenant_id: 7 } },
        tenantClaimPath: "app_metadata.tenant_id",
      }),
    ).toEqual({ sub: "alice", tenant: "7", tenantClaimConfigured: true });
    expect(personaFacts({ claims: {} })).toEqual({
      sub: undefined,
      tenant: undefined,
      tenantClaimConfigured: false,
    });
  });

  it("textMembership compares the claims with the ground truth as text", () => {
    expect(aliceRows).toEqual({ own: new Set([k(1)]), tenant: new Set([k(1), k(2)]) });
    expect(textMembership(truth, { sub: undefined, tenant: undefined })).toEqual({
      own: new Set(),
      tenant: new Set(),
    });
  });

  it("adds the role claim in supabase mode only, and never overwrites one", () => {
    const persona = { claims: { sub: "a" }, dbRole: "authenticated" };
    expect(effectiveClaims(persona, "supabase")).toEqual({ sub: "a", role: "authenticated" });
    expect(effectiveClaims(persona, "postgres")).toEqual({ sub: "a" });
    expect(effectiveClaims({ claims: { role: "custom" }, dbRole: "anon" }, "supabase")).toEqual({
      role: "custom",
    });
  });

  it("serialises the claims with sorted keys", () => {
    expect(claimsJsonOf({ claims: { z: 1, a: { d: 1, c: 2 } }, dbRole: "app" }, "postgres")).toBe(
      '{"a":{"c":2,"d":1},"z":1}',
    );
  });
});

describe("expectedKeysForScope", () => {
  it("none, own, tenant and all come from the ground truth", () => {
    expect(expectedKeysForScope("none", truth, alice, aliceRows)).toEqual({
      status: "ok",
      keys: [],
    });
    expect(expectedKeysForScope("own", truth, alice, aliceRows)).toEqual({
      status: "ok",
      keys: [k(1)],
    });
    expect(expectedKeysForScope("tenant", truth, alice, aliceRows)).toEqual({
      status: "ok",
      keys: [k(1), k(2)],
    });
    expect(expectedKeysForScope("all", truth, alice, aliceRows)).toEqual({
      status: "ok",
      keys: [k(1), k(2), k(3), k(4)],
    });
  });

  it("membership decides, not the text: the database may know better (uuid case, 1 = 1.0)", () => {
    const decided = { own: new Set([k(3)]), tenant: new Set([k(4)]) };
    expect(expectedKeysForScope("own", truth, alice, decided)).toEqual({
      status: "ok",
      keys: [k(3)],
    });
    expect(expectedKeysForScope("tenant", truth, alice, decided)).toEqual({
      status: "ok",
      keys: [k(4)],
    });
  });

  it("a persona without the claim owns nothing, NULL columns included", () => {
    const nobody = { sub: undefined, tenant: undefined, tenantClaimConfigured: false };
    const none = textMembership(truth, nobody);
    expect(expectedKeysForScope("own", truth, nobody, none)).toEqual({ status: "ok", keys: [] });
    expect(expectedKeysForScope("tenant", truth, nobody, none)).toEqual({
      status: "ok",
      keys: [],
    });
  });

  it("scope tenant for a signed-in persona without tenantClaimPath cannot be decided", () => {
    const signedIn = { sub: "alice", tenant: undefined, tenantClaimConfigured: false };
    expect(
      expectedKeysForScope("tenant", truth, signedIn, textMembership(truth, signedIn)),
    ).toMatchObject({ status: "skipped", reason: expect.stringContaining("tenantClaimPath") });
    // A path that leads to nothing is an answer: this user has no tenant, so it reaches no row.
    const noTenant = { ...signedIn, tenantClaimConfigured: true };
    expect(
      expectedKeysForScope("tenant", truth, noTenant, textMembership(truth, noTenant)),
    ).toEqual({ status: "ok", keys: [] });
  });

  it("own and tenant are skipped without the column", () => {
    const bare = truthOf(rows, { ownerColumn: null, tenantColumn: null });
    expect(expectedKeysForScope("own", bare, alice, aliceRows)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("owner column"),
    });
    expect(expectedKeysForScope("tenant", bare, alice, aliceRows)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("tenant column"),
    });
    expect(expectedKeysForScope("all", bare, alice, aliceRows).status).toBe("ok");
  });
});

describe("chooseUpdateColumn", () => {
  const table = {
    primaryKey: ["id"],
    columns: [
      column("id", { type: "integer" }),
      column("serial_no", { identity: "always" }),
      column("doubled", { generated: "stored" }),
      column("title"),
      column("body"),
    ],
  };

  it("prefers a writable non-key column the role may update", () => {
    expect(chooseUpdateColumn(table, new Set(["id", "title", "body"]))).toBe("title");
    expect(chooseUpdateColumn(table, new Set(["body"]))).toBe("body");
  });

  it("avoids the owner and tenant columns while another column is granted", () => {
    const scope = new Set(["title", null]);
    expect(chooseUpdateColumn(table, new Set(["title", "body"]), scope)).toBe("body");
    expect(chooseUpdateColumn(table, new Set(["id", "title"]), scope)).toBe("title");
  });

  it("takes a key column when that is all the role may update", () => {
    expect(chooseUpdateColumn(table, new Set(["id", "doubled", "serial_no"]))).toBe("id");
  });

  it("still names a column when the role may update nothing, so the 42501 is recorded", () => {
    expect(chooseUpdateColumn(table, new Set())).toBe("title");
    expect(chooseUpdateColumn({ primaryKey: ["id"], columns: [column("id")] }, new Set())).toBe(
      "id",
    );
  });

  it("gives up when nothing can be written", () => {
    expect(
      chooseUpdateColumn(
        { primaryKey: ["id"], columns: [column("id", { identity: "always" })] },
        new Set(["id"]),
      ),
    ).toBeNull();
    expect(isWritable(column("x", { identity: "by default" }))).toBe(true);
    expect(isWritable(column("x", { generated: "virtual" }))).toBe(false);
  });
});

describe("blindUpdateColumns", () => {
  const table = {
    primaryKey: ["id"],
    columns: [
      column("id", { type: "integer" }),
      column("doubled", { generated: "stored" }),
      column("owner_id"),
      column("title"),
      column("body"),
      column("extra"),
    ],
  };
  const scope = new Set(["owner_id", null]);

  it("plain columns first, then scope columns, then key columns, three at most", () => {
    const all = new Set(["id", "doubled", "owner_id", "title", "body", "extra"]);
    expect(blindUpdateColumns(table, all, scope)).toEqual(["title", "body", "extra"]);
    expect(blindUpdateColumns(table, new Set(["id", "owner_id", "body"]), scope)).toEqual([
      "body",
      "owner_id",
      "id",
    ]);
  });

  it("needs the UPDATE privilege and a writable column", () => {
    expect(blindUpdateColumns(table, new Set(["doubled"]), scope)).toEqual([]);
    expect(blindUpdateColumns(table, new Set())).toEqual([]);
  });

  it("for the CI export: ungranted writable columns follow the granted ones, within the cap", () => {
    expect(blindUpdateColumns(table, new Set(), scope, true)).toEqual(["title", "body", "extra"]);
    expect(blindUpdateColumns(table, new Set(["id"]), scope, true)).toEqual([
      "id",
      "title",
      "body",
    ]);
    expect(blindUpdateColumns(table, new Set(["owner_id", "extra"]), scope, true)).toEqual([
      "extra",
      "owner_id",
      "title",
    ]);
    expect(blindUpdateColumns(table, new Set(["doubled"]), scope, true)).not.toContain("doubled");
  });
});

describe("pullMoves", () => {
  const table = {
    columns: [column("owner_id", { type: "uuid" }), column("tenant_id", { type: "integer" })],
  };
  const owner = { column: "owner_id", type: "uuid", value: "alice" };
  const tenant = { column: "tenant_id", type: "integer", value: "t1" };

  it("both columns at once, then each alone", () => {
    expect(pullMoves(table, truth, alice)).toEqual([[owner, tenant], [owner], [tenant]]);
  });

  it("only what the persona has a claim and the table a writable column for", () => {
    expect(pullMoves(table, truth, { sub: "alice", tenant: undefined })).toEqual([[owner]]);
    expect(pullMoves(table, truthOf(rows, { ownerColumn: null }), alice)).toEqual([[tenant]]);
    expect(pullMoves(table, truth, { sub: undefined, tenant: undefined })).toEqual([]);
    const generated = { columns: [column("owner_id", { generated: "stored" })] };
    expect(pullMoves(generated, truthOf(rows, { tenantColumn: null }), alice)).toEqual([]);
  });

  it("one column that is owner and tenant at once is set once", () => {
    const same = truthOf(rows, { tenantColumn: "owner_id" });
    expect(pullMoves(table, same, alice)).toEqual([[owner]]);
  });
});

describe("planEscape", () => {
  const table = {
    columns: [
      column("id", { type: "integer" }),
      column("owner_id"),
      column("tenant_id", { type: "integer" }),
    ],
  };
  const input = (
    scope: Scope,
    expectedKeys: readonly string[],
    reachableKeys: readonly string[],
    parts: Partial<EscapeInput> = {},
  ): EscapeInput => ({ scope, table, truth, expectedKeys, reachableKeys, ...parts });

  it("moves the scope's own column to the first value that only outsiders carry", () => {
    expect(planEscape(input("tenant", [k(1), k(2)], [k(1), k(2)]))).toEqual({
      status: "ok",
      sourceKey: k(1),
      move: { column: "tenant_id", type: "integer", value: "t2" },
    });
    expect(planEscape(input("own", [k(1)], [k(1)]))).toEqual({
      status: "ok",
      sourceKey: k(1),
      move: { column: "owner_id", type: "text", value: "bob" },
    });
  });

  it("custom prefers the tenant column and falls back to the owner column", () => {
    expect(planEscape(input("custom", [k(1), k(2)], [k(2)]))).toMatchObject({
      sourceKey: k(2),
      move: { column: "tenant_id", value: "t2" },
    });
    const ownerOnly = truthOf(rows, { tenantColumn: null });
    expect(planEscape(input("custom", [k(1)], [k(1)], { truth: ownerOnly }))).toMatchObject({
      move: { column: "owner_id", value: "bob" },
    });
  });

  it.each([
    ["all", [k(1)], [k(1)], "nowhere to escape"],
    ["none", [], [k(1)], "nothing to move"],
    ["tenant", [k(1), k(2)], [k(3)], "can update no row inside its scope"],
    ["tenant", [k(1), k(2), k(3)], [k(1)], "belongs to someone else"],
  ] as const)("scope %s is skipped with a reason", (scope, expected, reachable, reason) => {
    expect(planEscape(input(scope, expected, reachable))).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining(reason),
    });
  });

  it("is skipped without a column, or with a generated one", () => {
    const bare = truthOf(rows, { ownerColumn: null, tenantColumn: null });
    expect(planEscape(input("custom", [k(1)], [k(1)], { truth: bare }))).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("no owner or tenant column"),
    });
    expect(
      planEscape(input("own", [k(1)], [k(1)], { truth: truthOf(rows, { ownerColumn: null }) }))
        .status,
    ).toBe("skipped");
    const generated = { columns: [column("tenant_id", { generated: "stored" })] };
    expect(planEscape(input("tenant", [k(1)], [k(1)], { table: generated }))).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("generated"),
    });
  });

  it("never picks a value that a row inside the scope carries too", () => {
    const shared = truthOf([
      row(k(1), "alice", "t1"),
      row(k(2), "bob", "t1"),
      row(k(3), "bob", "t3"),
    ]);
    // Custom scope: alice reaches rows 1 and 2. "t1" is inside; only "t3" is foreign.
    expect(planEscape(input("custom", [k(1), k(2)], [k(1)], { truth: shared }))).toMatchObject({
      move: { value: "t3" },
    });
  });

  describe("planTenantEscape: scope own also tries the tenant column", () => {
    it("moves an own row into a tenant that is not the persona's", () => {
      // Bob's row 2 is in alice's tenant t1: that value is not foreign although bob owns the row.
      expect(planTenantEscape(input("own", [k(1)], [k(1)]), alice, aliceRows.tenant)).toEqual({
        status: "ok",
        sourceKey: k(1),
        move: { column: "tenant_id", type: "integer", value: "t2" },
      });
    });

    it("does not apply to other scopes, without a tenant column, or without a tenant claim", () => {
      const own = input("own", [k(1)], [k(1)]);
      expect(planTenantEscape(input("tenant", [k(1)], [k(1)]), alice, aliceRows.tenant)).toBeNull();
      expect(planTenantEscape(own, { tenant: undefined }, new Set())).toBeNull();
      const noTenant = { truth: truthOf(rows, { tenantColumn: null }) };
      expect(
        planTenantEscape(input("own", [k(1)], [k(1)], noTenant), alice, aliceRows.tenant),
      ).toBeNull();
      const same = { truth: truthOf(rows, { tenantColumn: "owner_id" }) };
      expect(
        planTenantEscape(input("own", [k(1)], [k(1)], same), alice, aliceRows.tenant),
      ).toBeNull();
    });

    it("is skipped with a reason when every other row is in the persona's tenant", () => {
      const oneTenant = truthOf([row(k(1), "alice", "t1"), row(k(2), "bob", "t1")]);
      expect(
        planTenantEscape(
          input("own", [k(1)], [k(1)], { truth: oneTenant }),
          alice,
          textMembership(oneTenant, alice).tenant,
        ),
      ).toMatchObject({ status: "skipped", reason: expect.stringContaining("tenant_id") });
    });
  });
});

describe("planInsertClasses", () => {
  it("finds the three classes and expects only in-scope clones to be allowed", () => {
    expect(planInsertClasses("tenant", truth, alice, aliceRows, [k(1), k(2)])).toEqual([
      { kind: "insert-own", sourceKey: k(1), expected: "allowed" },
      { kind: "insert-same-tenant", sourceKey: k(2), expected: "allowed" },
      { kind: "insert-other", sourceKey: k(3), expected: "blocked" },
    ]);
    expect(
      planInsertClasses("own", truth, alice, aliceRows, [k(1)]).map((plan) => plan.expected),
    ).toEqual(["allowed", "blocked", "blocked"]);
    expect(
      planInsertClasses("none", truth, alice, aliceRows, []).map((plan) => plan.expected),
    ).toEqual(["blocked", "blocked", "blocked"]);
    expect(
      planInsertClasses(
        "all",
        truth,
        alice,
        aliceRows,
        rows.map((entry) => entry.key),
      ).map((plan) => plan.expected),
    ).toEqual(["allowed", "allowed", "allowed"]);
  });

  it("an own row in another tenant is not the own class", () => {
    const moved = truthOf([row(k(1), "alice", "t2"), row(k(2), "alice", "t1")]);
    const membership = textMembership(moved, alice);
    expect(planInsertClasses("tenant", moved, alice, membership, [k(2)])).toEqual([
      { kind: "insert-own", sourceKey: k(2), expected: "allowed" },
      { kind: "insert-other", sourceKey: k(1), expected: "blocked" },
    ]);
  });

  it("a class with rows on both sides of the scope gets a representative for each side", () => {
    // Scope own: alice's row in another tenant is class "other" and IN scope; so is bob's row,
    // which is NOT. Without the second representative the forged insert is never attempted.
    const mixed = truthOf([row(k(1), "alice", "t2"), row(k(2), "bob", "t2")]);
    const membership = textMembership(mixed, alice);
    expect(planInsertClasses("own", mixed, alice, membership, [k(1)])).toEqual([
      { kind: "insert-other", sourceKey: k(1), expected: "allowed" },
      { kind: "insert-other", sourceKey: k(2), expected: "blocked" },
    ]);
  });

  it("without owner and tenant columns every row is the other class", () => {
    const bare = truthOf(rows, { ownerColumn: null, tenantColumn: null });
    expect(planInsertClasses("none", bare, alice, aliceRows, [])).toEqual([
      { kind: "insert-other", sourceKey: k(1), expected: "blocked" },
    ]);
  });

  it("custom splits by the expected rows", () => {
    expect(planInsertClasses("custom", truth, alice, aliceRows, [k(2), k(3)])).toEqual([
      { kind: "insert-in-scope", sourceKey: k(2), expected: "allowed" },
      { kind: "insert-out-of-scope", sourceKey: k(1), expected: "blocked" },
    ]);
  });

  it("an empty table has no class", () => {
    expect(planInsertClasses("all", truthOf([]), alice, aliceRows, [])).toEqual([]);
  });
});

describe("planFreshKey", () => {
  const table = (pk: CatalogColumn[], primaryKey = pk.map((entry) => entry.name)) => ({
    primaryKey,
    columns: [...pk, column("owner_id"), column("tenant_id")],
  });

  it("integer keys get max + 1000, or max + 1 near the end of the range", () => {
    const integers = truthOf([
      row(k(7), null, null),
      row(k(-3), null, null),
      row(k(12), null, null),
    ]);
    expect(planFreshKey(table([column("id", { type: "integer" })]), integers)).toEqual({
      status: "ok",
      column: "id",
      value: { column: "id", type: "integer", value: "1012" },
    });
    const nearEnd = truthOf([row(k(32000), null, null)]);
    expect(planFreshKey(table([column("id", { type: "smallint" })]), nearEnd)).toMatchObject({
      value: { value: "32001" },
    });
    const huge = truthOf([row(k("9007199254740993"), null, null)]);
    expect(planFreshKey(table([column("id", { type: "bigint" })]), huge)).toMatchObject({
      value: { value: "9007199254741993" },
    });
  });

  it("falls back to the default when the integer range is exhausted, else skips", () => {
    const full = truthOf([row(k(32767), null, null)]);
    expect(
      planFreshKey(table([column("id", { type: "smallint", default: "nextval('s')" })]), full),
    ).toEqual({ status: "ok", column: "id", value: null });
    expect(planFreshKey(table([column("id", { type: "smallint" })]), full).status).toBe("skipped");
  });

  it("uuid keys get a fixed literal that no seeded row uses", () => {
    const uuids = truthOf([row(k("00000000-0000-4000-8000-000000000001"), null, null)]);
    expect(
      planFreshKey(table([column("id", { type: "uuid", default: "gen_random_uuid()" })]), uuids),
    ).toEqual({
      status: "ok",
      column: "id",
      value: { column: "id", type: "uuid", value: "00000000-0000-4000-8000-000000000002" },
    });
  });

  it("an identity ALWAYS key and a defaulted key of another type are left to the database", () => {
    expect(
      planFreshKey(table([column("id", { type: "integer", identity: "always" })]), truth),
    ).toEqual({ status: "ok", column: "id", value: null });
    expect(planFreshKey(table([column("id", { default: "make_id()" })]), truth)).toEqual({
      status: "ok",
      column: "id",
      value: null,
    });
  });

  it("is skipped for a key it cannot make, with the reason", () => {
    expect(planFreshKey(table([column("id")]), truth)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining('"id"'),
    });
  });

  it("composite keys: replaces the first column that is not the owner or tenant column", () => {
    const composite = truthOf([row(k("t1", 5), null, "t1")], { primaryKey: ["tenant_id", "line"] });
    expect(
      planFreshKey(
        {
          primaryKey: ["tenant_id", "line"],
          columns: [column("tenant_id"), column("line", { type: "integer" })],
        },
        composite,
      ),
    ).toEqual({
      status: "ok",
      column: "line",
      value: { column: "line", type: "integer", value: "1005" },
    });
  });

  it("is skipped when the key consists of the scope columns only", () => {
    const membership = truthOf([row(k("t1", "alice"), "alice", "t1")], {
      primaryKey: ["tenant_id", "owner_id"],
    });
    expect(
      planFreshKey(
        {
          primaryKey: ["tenant_id", "owner_id"],
          columns: [column("tenant_id"), column("owner_id")],
        },
        membership,
      ),
    ).toMatchObject({ status: "skipped", reason: expect.stringContaining("owner or tenant") });
  });
});

describe("clone", () => {
  const columns = [
    column("id", { type: "integer" }),
    column("doubled", { generated: "stored" }),
    column("seq", { identity: "always" }),
    column("title"),
  ];

  it("names every writable column, the fresh key included", () => {
    const freshKey = { column: "id", value: { column: "id", type: "integer", value: "1003" } };
    expect(cloneColumns({ columns }, freshKey).map((entry) => entry.name)).toEqual(["id", "title"]);
  });

  it("leaves a defaulted key column out", () => {
    const freshKey = { column: "id", value: null };
    expect(cloneColumns({ columns }, freshKey).map((entry) => entry.name)).toEqual(["title"]);
  });
});
