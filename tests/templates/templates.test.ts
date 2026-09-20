/**
 * The templates as data: every scenario is valid, every cell is explicit, and the metadata the
 * golden tests rely on is consistent. No database here; see the integration suites beside it.
 */
import { describe, expect, it } from "vitest";
import {
  findOrphanExpectations,
  isUuid,
  OPERATIONS,
  parseScenario,
  parseScenarioJson,
  resolveExpectations,
  serializeScenario,
  splitSqlStatements,
  MAX_DESCRIPTION_LENGTH,
} from "@/lib/scenario";
import {
  findTemplate,
  findTemplateVariant,
  TEMPLATE_VARIANT_KINDS,
  TEMPLATES,
  templateVariants,
} from "@/lib/scenario/templates";
import { buildExpectations, everyOperation, readOnly } from "@/lib/scenario/templates/build";

/**
 * The grants regime of every template, pinned. The three demos run under the legacy blanket
 * grants, so RLS is their only barrier; the app's own migration writes its grants itself.
 */
const GRANTS_REGIMES: Readonly<Record<string, string>> = {
  "multi-tenant-saas": "legacy",
  "team-workspace": "legacy",
  "todos-sharing": "legacy",
  "own-scenarios-table": "explicit",
};

const VARIANTS = templateVariants().map(({ template, variant }) => ({
  id: variant.scenario.id,
  template,
  variant,
}));

describe("TEMPLATES", () => {
  it("lists the four templates in the order of the brief", () => {
    expect(TEMPLATES.map((template) => template.id)).toEqual([
      "multi-tenant-saas",
      "team-workspace",
      "todos-sharing",
      "own-scenarios-table",
    ]);
  });

  it("gives every template a title, one paragraph of description, the leak and the fix", () => {
    for (const template of TEMPLATES) {
      for (const text of [template.title, template.description, template.leak, template.fix]) {
        expect(text.trim().length).toBeGreaterThan(10);
        expect(text).not.toContain("\n");
      }
    }
  });

  it("finds templates and variants by id", () => {
    expect(findTemplate("team-workspace")).toBe(TEMPLATES[1]);
    expect(findTemplate("nope")).toBeUndefined();
    expect(findTemplateVariant("todos-sharing-fixed")).toBe(TEMPLATES[2]?.fixed);
    expect(findTemplateVariant("todos-sharing")).toBeUndefined();
    expect(VARIANTS.map((entry) => entry.id)).toEqual(
      TEMPLATES.flatMap((template) =>
        TEMPLATE_VARIANT_KINDS.map((kind) => `${template.id}-${kind}`),
      ),
    );
  });

  it("differs between leaky and fixed in the schema SQL only", () => {
    for (const template of TEMPLATES) {
      const { leaky, fixed } = template;
      expect(leaky.scenario.schemaSql).not.toBe(fixed.scenario.schemaSql);
      expect({ ...leaky.scenario, id: "", title: "", description: "", schemaSql: "" }).toEqual({
        ...fixed.scenario,
        id: "",
        title: "",
        description: "",
        schemaSql: "",
      });
    }
  });

  it("hands out independent copies: editing one variant leaves the other alone", () => {
    const template = TEMPLATES[0];
    expect(template?.leaky.scenario.personas).not.toBe(template?.fixed.scenario.personas);
    expect(template?.leaky.scenario.personas[1]?.claims).not.toBe(
      template?.fixed.scenario.personas[1]?.claims,
    );
    expect(template?.leaky.scenario.expectations[0]).not.toBe(
      template?.fixed.scenario.expectations[0],
    );
  });
});

describe.each(VARIANTS)("scenario $id", ({ template, variant }) => {
  const { scenario } = variant;

  it("passes parseScenario unchanged, and survives a serialise and parse round trip", () => {
    const parsed = parseScenario(scenario);
    expect(parsed).toEqual({ ok: true, scenario });
    expect(parseScenarioJson(serializeScenario(scenario)).ok).toBe(true);
    expect(scenario.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  it("is a supabase scenario under its pinned grants regime, named after its template", () => {
    expect(scenario.id).toBe(`${template.id}-${variant.kind}`);
    expect(scenario.title).toBe(`${template.title} (${variant.kind})`);
    expect(scenario.description.startsWith(template.description)).toBe(true);
    expect(scenario.mode).toBe("supabase");
    expect(GRANTS_REGIMES[template.id]).toBeDefined();
    expect(scenario.options).toEqual({
      exposedSchemas: ["public"],
      supabaseGrants: GRANTS_REGIMES[template.id],
    });
  });

  it("has anon, at least two signed-in users with distinct uuid subs, and service_role", () => {
    const roles = scenario.personas.map((persona) => persona.dbRole);
    expect(roles[0]).toBe("anon");
    expect(roles.at(-1)).toBe("service_role");
    const subs = scenario.personas
      .filter((persona) => persona.dbRole === "authenticated")
      .map((persona) => persona.claims.sub);
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(subs).size).toBe(subs.length);
    expect(subs.every((sub) => isUuid(sub))).toBe(true);
  });

  it("states every persona x table x operation explicitly, in matrix order", () => {
    const resolved = resolveExpectations(scenario, scenario.tables);
    expect(resolved).toHaveLength(
      scenario.personas.length * scenario.tables.length * OPERATIONS.length,
    );
    expect(resolved).toEqual(
      scenario.expectations.map((cell) => ({ ...cell, source: "explicit" })),
    );
    expect(findOrphanExpectations(scenario, scenario.tables)).toEqual([]);
  });

  it("splits into statements: schema and seed are not empty", () => {
    expect(splitSqlStatements(scenario.schemaSql).length).toBeGreaterThan(3);
    expect(splitSqlStatements(scenario.seedSql).length).toBeGreaterThan(1);
  });

  it("declares failures only for the leaky variant, each one an existing cell, in matrix order", () => {
    const cells = scenario.expectations.map(
      (cell) => `${cell.personaId}|${cell.schema}|${cell.table}|${cell.operation}`,
    );
    const failing = variant.expectedFailures.map(
      (cell) => `${cell.personaId}|${cell.schema}|${cell.table}|${cell.operation}`,
    );
    const positions = failing.map((cell) => cells.indexOf(cell));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(failing).size).toBe(failing.length);

    if (variant.kind === "leaky") {
      expect(variant.expectedVerdict).toBe("LEAKING");
      expect(failing.length).toBeGreaterThan(0);
    } else {
      expect(variant.expectedVerdict).toBe("ISOLATED");
      expect(variant.expectedFailures).toEqual([]);
      expect(variant.expectedStaticChecks).toEqual([]);
    }
  });

  it("never declares a service_role cell as a failure: BYPASSRLS proves nothing about policies", () => {
    const service = scenario.personas.at(-1)?.id;
    expect(variant.expectedFailures.some((cell) => cell.personaId === service)).toBe(false);
  });
});

describe("expected static checks of the leaky variants", () => {
  it("names the rule and the policy", () => {
    expect(
      TEMPLATES.map((template) =>
        template.leaky.expectedStaticChecks.map((check) => `${check.id} ${check.policy}`),
      ),
    ).toEqual([
      ["RLS003 projects_update", "RLS004 projects_update"],
      [],
      ["RLS003 todos_select_public"],
      [],
    ]);
  });
});

describe("buildExpectations", () => {
  const personas = [{ id: "anon" }, { id: "alice" }];

  it("writes one expectation per persona and operation, custom SQL included", () => {
    const built = buildExpectations(personas, [
      {
        schema: "public",
        table: "docs",
        byPersona: { anon: everyOperation("none"), alice: readOnly({ customSql: "select 1" }) },
      },
    ]);
    expect(built).toHaveLength(8);
    expect(built[0]).toEqual({
      personaId: "anon",
      schema: "public",
      table: "docs",
      operation: "select",
      scope: "none",
    });
    expect(built[4]).toEqual({
      personaId: "alice",
      schema: "public",
      table: "docs",
      operation: "select",
      scope: "custom",
      expectedRowsSql: "select 1",
    });
    expect(built.slice(5).map((cell) => cell.scope)).toEqual(["none", "none", "none"]);
  });

  it("refuses a table that forgets a persona, so no cell falls back to a default", () => {
    expect(() =>
      buildExpectations(personas, [
        { schema: "public", table: "docs", byPersona: { anon: everyOperation("none") } },
      ]),
    ).toThrow("public.docs: no expectations for persona 'alice'");
  });

  it("refuses a persona the scenario does not have", () => {
    expect(() =>
      buildExpectations(personas, [
        {
          schema: "public",
          table: "docs",
          byPersona: {
            anon: everyOperation("none"),
            alice: everyOperation("own"),
            mallory: everyOperation("all"),
          },
        },
      ]),
    ).toThrow("public.docs: unknown persona 'mallory'");
  });
});
