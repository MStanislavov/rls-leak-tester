/**
 * `buildExplainRequest` on a real matrix run (PGlite in Node): what leaves the browser when the
 * user presses Explain is the minimum of brief 3.7, passes the route's own validation, fits the
 * payload cap, and holds no seed data.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { buildExplainRequest, renderTableDdl } from "@/lib/ai/build-request";
import { handleExplain } from "@/lib/ai/explain";
import { EXPLAIN_PAYLOAD_MAX_BYTES, MAX_KEY_SAMPLE, explainRequestSchema } from "@/lib/ai/schema";
import { runStaticChecks, type Finding } from "@/lib/checks";
import type { CellResult, MatrixRun } from "@/lib/runner";
import type { Scenario } from "@/lib/scenario";

import { tenantScenario } from "../runner/fixtures";
import { cellOf, run } from "../runner/helpers";
import { harness, post } from "./fixtures";

let scenario: Scenario;
let matrix: MatrixRun;
let findings: Finding[];
let failing: CellResult;

beforeAll(async () => {
  scenario = tenantScenario("leaky");
  matrix = await run(scenario);
  findings = runStaticChecks(matrix.catalog, scenario);
  failing = cellOf(matrix.result, "alice", "projects", "update");
}, 120_000);

function built(cell: CellResult = failing, extra: readonly Finding[] = findings) {
  const result = buildExplainRequest(cell, matrix.catalog, scenario, extra);
  if (!result.ok) {
    throw new Error(`buildExplainRequest failed: ${result.reason}`);
  }
  return result;
}

describe("buildExplainRequest", () => {
  it("builds a request the route accepts for a cell the engine proved failing", async () => {
    expect(failing.status).toBe("escape");
    const { request, bytes } = built();

    expect(explainRequestSchema.safeParse(request).success).toBe(true);
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(request)).length);
    expect(bytes).toBeLessThanOrEqual(EXPLAIN_PAYLOAD_MAX_BYTES);
    const response = await handleExplain(post(request), harness().deps);
    expect(response.status).toBe(200);
    await response.text();
  });

  it("sends the table, every policy on it, the persona and the evidence", () => {
    const { request } = built();

    expect(request.mode).toBe(scenario.mode);
    expect(request.cell).toMatchObject({ operation: "update", status: "escape", scope: "tenant" });
    expect(request.cell.subProbes.some((probe) => probe.status === "escape")).toBe(true);
    expect(request.table).toMatchObject({
      schema: "public",
      name: "projects",
      rlsEnabled: true,
      ownerColumn: "user_id",
      tenantColumn: "tenant_id",
    });
    expect(request.table.grants).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(request.table.ddl).toContain('create table "public"."projects"');
    expect(request.table.ddl).toContain('"tenant_id" integer not null');
    expect(request.table.ddl).toContain("enable row level security");
    expect(request.policies.map((policy) => [policy.name, policy.appliesAs]).sort()).toEqual([
      ["add", "none"],
      ["change", "command"],
      ["read", "visibility"],
      ["remove", "none"],
    ]);
    expect(request.persona.dbRole).toBe("app_user");
    expect(JSON.parse(request.persona.claimsJson)).toMatchObject({ tenant_id: 1 });
    expect(request.keys.expected.total).toBe(failing.expectedKeys.length);
  });

  it("never sends seed data, the schema text, or a statement that inlines row values", () => {
    const text = JSON.stringify(built().request);

    for (const seeded of ["alpha", "beta", "gamma", "insert into", "create role", "seedSql"]) {
      expect(text).not.toContain(seeded);
    }
    for (const cell of matrix.result.cells.filter(
      (candidate) => candidate.operation === "insert",
    )) {
      const result = buildExplainRequest(cell, matrix.catalog, scenario, findings);
      if (result.ok) {
        expect(JSON.stringify(result.request)).not.toContain("insert into");
      }
    }
  });

  it("sends the custom expectation query only for a custom scope", () => {
    const custom: CellResult = {
      ...cellOf(matrix.result, "visitor", "tasks", "select"),
      status: "overblock",
    };

    expect(custom.scope).toBe("custom");
    expect(built(custom).request.cell.expectedRowsSql).toBe(
      "select id from tasks where user_id = :sub::uuid",
    );
    expect(built().request.cell.expectedRowsSql).toBeNull();
  });

  it("caps the key samples and keeps the totals", () => {
    const many = Array.from({ length: 500 }, (_, at) => JSON.stringify([String(at)]));
    const cell: CellResult = { ...failing, status: "leak", actualKeys: many, leakedKeys: many };

    const { request } = built(cell);

    expect(request.keys.leaked).toEqual({ total: 500, sample: many.slice(0, MAX_KEY_SAMPLE) });
  });

  it("drops findings before it gives up, and never cuts the DDL or a policy", () => {
    const bulky: Finding[] = Array.from({ length: 12 }, (_, at) => ({
      id: "RLS003",
      severity: "high",
      title: `finding ${at}`,
      explanation: "x".repeat(1_400),
      docsUrl: "https://www.postgresql.org/docs/",
      evidence: Array.from({ length: 8 }, () => ({ label: "using", value: "y".repeat(900) })),
      object: {
        kind: "table",
        schema: "public",
        name: "projects",
        qualifiedName: '"public"."projects"',
      },
    }));

    const { request, bytes } = built(failing, bulky);

    expect(bytes).toBeLessThanOrEqual(EXPLAIN_PAYLOAD_MAX_BYTES);
    expect(request.findings.every((finding) => finding.evidence.length === 0)).toBe(true);
    expect(request.policies).toHaveLength(4);
  });

  it("reports too-large when the table itself does not fit", () => {
    const huge = {
      ...matrix.catalog,
      policies: matrix.catalog.policies.map((policy) => ({
        ...policy,
        using: "z".repeat(3_900),
        withCheck: "z".repeat(3_900),
      })),
    };

    expect(buildExplainRequest(failing, huge, scenario, [])).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("refuses a cell that did not fail, an unknown table and an unknown persona", () => {
    const passing = matrix.result.cells.find((cell) => cell.status === "pass");
    expect(passing).toBeDefined();
    if (passing !== undefined) {
      expect(buildExplainRequest(passing, matrix.catalog, scenario, [])).toEqual({
        ok: false,
        reason: "not-failing",
      });
    }
    expect(
      buildExplainRequest({ ...failing, table: "nowhere" }, matrix.catalog, scenario, []),
    ).toEqual({ ok: false, reason: "unknown-table" });
    expect(
      buildExplainRequest({ ...failing, personaId: "mallory" }, matrix.catalog, scenario, []),
    ).toEqual({ ok: false, reason: "unknown-persona" });
  });
});

describe("renderTableDdl", () => {
  it("renders defaults, identity and generated columns, the key and the RLS switches", () => {
    const ddl = renderTableDdl({
      schema: "app",
      name: "Doc",
      owner: "owner",
      rlsEnabled: true,
      rlsForced: true,
      partitioned: true,
      primaryKey: ["id", "rev"],
      columns: [
        {
          name: "rev",
          position: 2,
          type: "integer",
          notNull: true,
          default: "1",
          generated: null,
          generationExpression: null,
          identity: null,
        },
        {
          name: "id",
          position: 1,
          type: "bigint",
          notNull: true,
          default: null,
          generated: null,
          generationExpression: null,
          identity: "always",
        },
        {
          name: "slug",
          position: 3,
          type: "text",
          notNull: false,
          default: null,
          generated: "stored",
          generationExpression: "lower(title)",
          identity: null,
        },
      ],
    });

    expect(ddl).toBe(
      [
        'create table "app"."Doc" (',
        '  "id" bigint generated always as identity not null,',
        '  "rev" integer default 1 not null,',
        '  "slug" text generated always as (lower(title)) stored,',
        '  primary key ("id", "rev")',
        ") /* partitioned */;",
        'alter table "app"."Doc" owner to "owner";',
        'alter table "app"."Doc" enable row level security;',
        'alter table "app"."Doc" force row level security;',
      ].join("\n"),
    );
  });
});
