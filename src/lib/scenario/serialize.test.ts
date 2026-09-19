import { describe, expect, it } from "vitest";

import { parseScenarioJson } from "./schema";
import { canonicalScenario, serializeScenario, stableStringify } from "./serialize";
import type { Scenario } from "./types";

describe("stableStringify", () => {
  it("sorts object keys at every level and keeps array order", () => {
    const value = { b: 1, a: { d: [3, { z: 1, y: 2 }, 1], c: null } };
    expect(stableStringify(value)).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1},1]},"b":1}');
  });

  it("gives the same text for the same data written in a different key order", () => {
    const one = { x: 1, y: { p: true, q: "s" } };
    const two = { y: { q: "s", p: true }, x: 1 };
    expect(stableStringify(one)).toBe(stableStringify(two));
  });

  it("sorts by code unit, not by locale", () => {
    expect(stableStringify({ a: 1, B: 2, ä: 3, A: 4 })).toBe('{"A":4,"B":2,"a":1,"ä":3}');
  });

  it("indents when asked", () => {
    expect(stableStringify({ b: [1], a: 2 }, 2)).toBe('{\n  "a": 2,\n  "b": [\n    1\n  ]\n}');
  });

  it("handles scalars and drops undefined properties like JSON.stringify", () => {
    expect(stableStringify("text")).toBe('"text"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(1.5)).toBe("1.5");
    expect(stableStringify({ keep: 1, drop: undefined })).toBe('{"keep":1}');
    expect(stableStringify([undefined, Number.NaN])).toBe("[null,null]");
  });

  it("keeps an own __proto__ key as data", () => {
    const parsed: unknown = JSON.parse('{"b":1,"__proto__":{"a":2}}');
    expect(stableStringify(parsed)).toBe('{"__proto__":{"a":2},"b":1}');
  });

  it("allows the same object twice, but refuses a cycle", () => {
    const shared = { n: 1 };
    expect(stableStringify({ first: shared, second: shared })).toBe(
      '{"first":{"n":1},"second":{"n":1}}',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = { back: cyclic };
    expect(() => stableStringify(cyclic)).toThrow(/circular/);
  });

  it("refuses what has no JSON form", () => {
    expect(() => stableStringify(undefined)).toThrow(TypeError);
    expect(() => stableStringify(() => 1)).toThrow(TypeError);
    expect(() => stableStringify({ big: 1n })).toThrow(TypeError);
  });

  it("does not mutate its input", () => {
    const value = { b: [{ d: 1, c: 2 }], a: 1 };
    stableStringify(value);
    expect(Object.keys(value)).toEqual(["b", "a"]);
    expect(Object.keys(value.b[0] ?? {})).toEqual(["d", "c"]);
  });
});

const ALICE = "00000000-0000-0000-0000-00000000000a";

const scenario: Scenario = {
  id: "demo",
  version: 1,
  title: "Demo",
  description: "",
  mode: "supabase",
  schemaSql: "create table t (id int primary key);",
  seedSql: "",
  personas: [
    { id: "zed", label: "Zed", dbRole: "authenticated", claims: { sub: ALICE, role: "x" } },
    { id: "anon", label: "Visitor", dbRole: "anon", claims: {} },
  ],
  tables: [
    { schema: "public", name: "t" },
    { schema: "api", name: "z", ownerColumn: "user_id" },
    { schema: "public", name: "a" },
  ],
  expectations: [
    { personaId: "anon", schema: "public", table: "t", operation: "delete", scope: "none" },
    { personaId: "anon", schema: "public", table: "t", operation: "select", scope: "all" },
    { personaId: "zed", schema: "public", table: "t", operation: "update", scope: "own" },
    { personaId: "zed", schema: "api", table: "z", operation: "insert", scope: "own" },
    { personaId: "ghost", schema: "api", table: "z", operation: "insert", scope: "none" },
    { personaId: "zed", schema: "public", table: "a", operation: "select", scope: "all" },
  ],
  options: { exposedSchemas: ["public", "api"], supabaseGrants: "legacy" },
};

function shuffled(input: Scenario): Scenario {
  return {
    options: input.options,
    expectations: [...input.expectations].reverse(),
    tables: [...input.tables].reverse(),
    personas: input.personas.map((persona) => ({
      claims: Object.fromEntries(Object.entries(persona.claims).reverse()),
      dbRole: persona.dbRole,
      label: persona.label,
      id: persona.id,
    })),
    seedSql: input.seedSql,
    schemaSql: input.schemaSql,
    mode: input.mode,
    description: input.description,
    title: input.title,
    version: input.version,
    id: input.id,
  };
}

describe("canonicalScenario", () => {
  it("sorts tables by schema and name", () => {
    expect(canonicalScenario(scenario).tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      "api.z",
      "public.a",
      "public.t",
    ]);
  });

  it("sorts expectations by table, persona order of the scenario, then operation", () => {
    const order = canonicalScenario(scenario).expectations.map(
      (e) => `${e.schema}.${e.table}/${e.personaId}/${e.operation}`,
    );
    expect(order).toEqual([
      "api.z/zed/insert",
      "api.z/ghost/insert",
      "public.a/zed/select",
      "public.t/zed/update",
      "public.t/anon/select",
      "public.t/anon/delete",
    ]);
  });

  it("orders unknown personas among themselves by id", () => {
    const base = { schema: "public", table: "t", operation: "select", scope: "none" } as const;
    const result = canonicalScenario({
      ...scenario,
      expectations: [
        { ...base, personaId: "ghost-b" },
        { ...base, personaId: "ghost-a" },
      ],
    });
    expect(result.expectations.map((e) => e.personaId)).toEqual(["ghost-a", "ghost-b"]);
  });

  it("keeps the order of personas and exposed schemas, and does not mutate", () => {
    const before = structuredClone(scenario);
    const result = canonicalScenario(scenario);
    expect(result.personas.map((p) => p.id)).toEqual(["zed", "anon"]);
    expect(result.options?.exposedSchemas).toEqual(["public", "api"]);
    expect(scenario).toEqual(before);
    expect(result.tables).not.toBe(scenario.tables);
  });

  it("is idempotent", () => {
    const once = canonicalScenario(scenario);
    expect(canonicalScenario(once)).toEqual(once);
  });
});

describe("serializeScenario", () => {
  it("gives byte-identical text however the scenario was written", () => {
    expect(serializeScenario(shuffled(scenario))).toBe(serializeScenario(scenario));
  });

  it("is pretty-printed JSON with sorted keys", () => {
    const text = serializeScenario(scenario);
    expect(text.startsWith('{\n  "description": "",\n  "expectations": [')).toBe(true);
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
  });

  it("round-trips through parseScenarioJson", () => {
    const valid: Scenario = {
      ...scenario,
      expectations: scenario.expectations.filter((e) => e.personaId !== "ghost"),
    };
    const parsed = parseScenarioJson(serializeScenario(valid));
    expect(parsed).toEqual({ ok: true, scenario: canonicalScenario(valid) });
    expect(parsed.ok && serializeScenario(parsed.scenario)).toBe(serializeScenario(valid));
  });

  it("drops an undefined options key", () => {
    const text = serializeScenario({ ...scenario, options: undefined });
    expect(text).not.toContain("options");
  });
});
