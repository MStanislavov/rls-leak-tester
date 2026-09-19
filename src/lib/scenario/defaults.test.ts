import { describe, expect, it } from "vitest";

import { defaultScope, findOrphanExpectations, resolveExpectations } from "./defaults";
import { OPERATIONS, type Expectation, type Persona, type TableConfig } from "./types";

const both: TableConfig = {
  schema: "public",
  name: "notes",
  ownerColumn: "user_id",
  tenantColumn: "tenant_id",
};
const ownerOnly: TableConfig = { schema: "public", name: "todos", ownerColumn: "user_id" };
const tenantOnly: TableConfig = { schema: "public", name: "projects", tenantColumn: "org_id" };
const neither: TableConfig = { schema: "public", name: "audit_log" };

describe("defaultScope", () => {
  it.each(OPERATIONS.map((operation) => [operation] as const))(
    "anon gets none and service_role gets all for %s, whatever the table",
    (operation) => {
      for (const table of [both, ownerOnly, tenantOnly, neither, undefined]) {
        expect(defaultScope({ dbRole: "anon" }, table, operation)).toBe("none");
        expect(defaultScope({ dbRole: "service_role" }, table, operation)).toBe("all");
      }
    },
  );

  it.each([["authenticated"], ["app_user"], ["Authenticated"], ["postgres"]])(
    "%s gets own, else tenant, else none",
    (dbRole) => {
      for (const operation of OPERATIONS) {
        expect(defaultScope({ dbRole }, both, operation)).toBe("own");
        expect(defaultScope({ dbRole }, ownerOnly, operation)).toBe("own");
        expect(defaultScope({ dbRole }, tenantOnly, operation)).toBe("tenant");
        expect(defaultScope({ dbRole }, neither, operation)).toBe("none");
        expect(defaultScope({ dbRole }, undefined, operation)).toBe("none");
      }
    },
  );

  it("never defaults to all for a custom role, and never to custom", () => {
    const scopes = new Set(
      [both, ownerOnly, tenantOnly, neither].map((table) =>
        defaultScope({ dbRole: "admin" }, table, "select"),
      ),
    );
    expect(scopes.has("all")).toBe(false);
    expect([...scopes]).not.toContain("custom");
  });
});

const personas: Persona[] = [
  { id: "zed", label: "Zed", dbRole: "authenticated", claims: { sub: "z" } },
  { id: "anon", label: "Visitor", dbRole: "anon", claims: {} },
  { id: "svc", label: "Backend", dbRole: "service_role", claims: {} },
];

describe("resolveExpectations", () => {
  it("returns one expectation per table x persona x operation", () => {
    const resolved = resolveExpectations({ personas, expectations: [] }, [both, neither]);
    expect(resolved).toHaveLength(2 * personas.length * OPERATIONS.length);
    const cells = new Set(
      resolved.map((cell) => `${cell.schema}.${cell.table}/${cell.personaId}/${cell.operation}`),
    );
    expect(cells.size).toBe(resolved.length);
    expect(resolved.every((cell) => cell.source === "default")).toBe(true);
  });

  it("orders by table (schema, name), then persona in scenario order, then operation", () => {
    const tables: TableConfig[] = [
      { schema: "public", name: "b" },
      { schema: "public", name: "B" },
      { schema: "api", name: "z" },
      { schema: "public", name: "a" },
    ];
    const resolved = resolveExpectations({ personas, expectations: [] }, tables);
    const tableOrder = [...new Set(resolved.map((cell) => `${cell.schema}.${cell.table}`))];
    expect(tableOrder).toEqual(["api.z", "public.B", "public.a", "public.b"]);
    expect(resolved.slice(0, 8).map((cell) => `${cell.personaId}/${cell.operation}`)).toEqual([
      "zed/select",
      "zed/insert",
      "zed/update",
      "zed/delete",
      "anon/select",
      "anon/insert",
      "anon/update",
      "anon/delete",
    ]);
  });

  it("gives the same result for any order of tables and expectations", () => {
    const expectations: Expectation[] = [
      { personaId: "zed", schema: "public", table: "notes", operation: "delete", scope: "none" },
      { personaId: "anon", schema: "public", table: "todos", operation: "select", scope: "all" },
    ];
    const forward = resolveExpectations({ personas, expectations }, [both, ownerOnly, neither]);
    const backward = resolveExpectations({ personas, expectations: [...expectations].reverse() }, [
      neither,
      ownerOnly,
      both,
    ]);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it("applies the defaults from the table config", () => {
    const resolved = resolveExpectations({ personas, expectations: [] }, [tenantOnly]);
    const scopeOf = (personaId: string) =>
      resolved.find((cell) => cell.personaId === personaId && cell.operation === "update")?.scope;
    expect(scopeOf("zed")).toBe("tenant");
    expect(scopeOf("anon")).toBe("none");
    expect(scopeOf("svc")).toBe("all");
  });

  it("lets an explicit expectation win and marks it", () => {
    const custom: Expectation = {
      personaId: "zed",
      schema: "public",
      table: "notes",
      operation: "select",
      scope: "custom",
      expectedRowsSql: "select id from public.notes",
    };
    const resolved = resolveExpectations({ personas, expectations: [custom] }, [both]);
    expect(resolved[0]).toEqual({ ...custom, source: "explicit" });
    expect(resolved[1]).toEqual({
      personaId: "zed",
      schema: "public",
      table: "notes",
      operation: "insert",
      scope: "own",
      source: "default",
    });
    expect(resolved.filter((cell) => cell.source === "explicit")).toHaveLength(1);
  });

  it("does not mutate or share the explicit expectation", () => {
    const explicit: Expectation = {
      personaId: "anon",
      schema: "public",
      table: "notes",
      operation: "select",
      scope: "all",
    };
    const resolved = resolveExpectations({ personas, expectations: [explicit] }, [both]);
    const cell = resolved.find((item) => item.source === "explicit");
    expect(cell).not.toBe(explicit);
    expect(explicit).not.toHaveProperty("source");
  });

  it("matches tables by schema and name, not by name alone", () => {
    const explicit: Expectation = {
      personaId: "anon",
      schema: "api",
      table: "notes",
      operation: "select",
      scope: "all",
    };
    const resolved = resolveExpectations({ personas, expectations: [explicit] }, [both]);
    expect(resolved.every((cell) => cell.source === "default")).toBe(true);
  });

  it("keeps the first of duplicate tables and duplicate expectations", () => {
    const first: Expectation = {
      personaId: "anon",
      schema: "public",
      table: "notes",
      operation: "select",
      scope: "all",
    };
    const resolved = resolveExpectations(
      { personas, expectations: [first, { ...first, scope: "own" }] },
      [both, { schema: "public", name: "notes" }],
    );
    expect(resolved).toHaveLength(personas.length * OPERATIONS.length);
    expect(resolved.find((cell) => cell.source === "explicit")?.scope).toBe("all");
    // The first config has an owner column, the dropped duplicate has none.
    expect(resolved[0]?.scope).toBe("own");
  });

  it("returns nothing without tables or without personas", () => {
    expect(resolveExpectations({ personas, expectations: [] }, [])).toEqual([]);
    expect(resolveExpectations({ personas: [], expectations: [] }, [both])).toEqual([]);
  });
});

describe("findOrphanExpectations", () => {
  const onNotes: Expectation = {
    personaId: "anon",
    schema: "public",
    table: "notes",
    operation: "select",
    scope: "none",
  };
  const onDropped: Expectation = { ...onNotes, table: "dropped" };
  const otherSchema: Expectation = { ...onNotes, schema: "private" };
  const unknownPersona: Expectation = { ...onNotes, personaId: "ghost" };

  it("lists expectations whose table or persona is not part of the run", () => {
    const orphans = findOrphanExpectations(
      { personas, expectations: [onNotes, onDropped, otherSchema, unknownPersona] },
      [{ schema: "public", name: "notes" }],
    );
    expect(orphans).toEqual([onDropped, otherSchema, unknownPersona]);
  });

  it("returns nothing when every expectation has a cell", () => {
    expect(findOrphanExpectations({ personas, expectations: [onNotes] }, [both])).toEqual([]);
  });
});
