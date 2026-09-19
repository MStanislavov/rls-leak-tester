/**
 * Golden tests (brief 5.1): every built-in template through the real matrix runner and the static
 * checks, against a real PGlite. A leaky variant yields the verdict LEAKING and exactly the failing
 * cells and findings its metadata declares; a fixed variant yields ISOLATED with every cell
 * passing. The full result JSON of every variant is a file snapshot, and a second, independent run
 * must produce the same bytes.
 *
 * A red test here is never repaired by editing the declaration or the snapshot: reproduce the cell
 * by hand first (role switch plus the probe SQL of `cell.sql`) and fix whichever of policy,
 * expectation or runner is wrong. docs/adr has the reconciliation log.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runStaticChecks, type Finding } from "@/lib/checks";
import type { CellResult, MatrixResult, MatrixRun } from "@/lib/runner";
import { compareText, OPERATIONS } from "@/lib/scenario";
import { templateVariants, type TemplateVariant } from "@/lib/scenario/templates";
import { run } from "../runner/helpers";

const RUN_TIMEOUT_MS = 120_000;
const BLOCKING_SEVERITIES: readonly string[] = ["critical", "high"];
const SERVICE_ROLE = "service_role";

const VARIANTS = templateVariants().map(({ variant }) => ({ id: variant.scenario.id, variant }));

/** The byte form the determinism requirement is about: plain JSON, two spaces, final newline. */
function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function failureLine(
  cell: Pick<CellResult, "personaId" | "schema" | "table" | "operation">,
  status: string,
): string {
  return `${cell.personaId} ${cell.schema}.${cell.table} ${cell.operation}: ${status}`;
}

function failingCells(result: MatrixResult): string[] {
  return result.cells
    .filter((cell) => cell.status === "leak" || cell.status === "escape")
    .map((cell) => failureLine(cell, cell.status))
    .sort(compareText);
}

function declaredFailures(variant: TemplateVariant): string[] {
  return variant.expectedFailures
    .map((failure) => failureLine(failure, failure.status))
    .sort(compareText);
}

function findingLine(finding: Finding): string {
  const table = finding.object.table ?? finding.object.name;
  const policy = finding.object.kind === "policy" ? ` policy ${finding.object.name}` : "";
  return `${finding.id} ${finding.object.schema}.${table}${policy}`;
}

function declaredFindings(variant: TemplateVariant): string[] {
  return variant.expectedStaticChecks.map(
    (check) =>
      `${check.id} ${check.schema}.${check.table}${check.policy === undefined ? "" : ` policy ${check.policy}`}`,
  );
}

describe.each(VARIANTS)("golden: $id", ({ id, variant }) => {
  let first: MatrixRun;
  let findings: Finding[];

  beforeAll(async () => {
    first = await run(variant.scenario);
    findings = runStaticChecks(first.catalog, variant.scenario);
  }, RUN_TIMEOUT_MS);

  it("covers the whole matrix with explicit expectations", () => {
    const { result } = first;
    expect(result.scenarioId).toBe(id);
    expect(result.missingSchemas).toEqual([]);
    expect(result.orphanExpectations).toEqual([]);
    expect(result.tables.map((table) => table.skippedReason)).toEqual(
      result.tables.map(() => null),
    );
    expect(result.personas.map((persona) => persona.roleExists)).toEqual(
      result.personas.map(() => true),
    );
    expect(result.totalCells).toBe(
      result.personas.length * result.tables.length * OPERATIONS.length,
    );
    expect(result.cells).toHaveLength(result.totalCells);
    expect(result.cells.filter((cell) => cell.expectationSource !== "explicit")).toEqual([]);
  });

  it("reaches the declared verdict with exactly the declared failing cells", () => {
    const { result } = first;
    expect(failingCells(result)).toEqual(declaredFailures(variant));
    expect(result.counts.leak + result.counts.escape).toBe(variant.expectedFailures.length);
    expect(result.verdict).toBe(variant.expectedVerdict);
  });

  it("passes every other cell: no overblock, nothing inconclusive, nothing skipped", () => {
    const { result } = first;
    const smells = result.cells
      .filter((cell) => ["overblock", "inconclusive", "skipped"].includes(cell.status))
      .map((cell) => `${cell.id}: ${cell.status} (${cell.reason ?? cell.error?.message ?? ""})`);
    expect(smells).toEqual([]);
    expect(result.counts.pass).toBe(result.totalCells - variant.expectedFailures.length);
    const inconclusiveProbes = result.cells.flatMap((cell) =>
      cell.subProbes
        .filter((probe) => probe.status === "inconclusive")
        .map((probe) => `${cell.id} ${probe.kind}: ${probe.error?.message ?? ""}`),
    );
    expect(inconclusiveProbes).toEqual([]);
  });

  it("probes every persona without an RLS bypass, except the service role", () => {
    const { result } = first;
    const serviceIds = new Set(
      result.personas
        .filter((persona) => persona.dbRole === SERVICE_ROLE)
        .map((persona) => persona.id),
    );
    expect(serviceIds.size).toBe(1);
    for (const persona of result.personas) {
      expect(persona.rlsBypass).toBe(serviceIds.has(persona.id) ? "bypassrls" : null);
    }
    for (const cell of result.cells) {
      expect(cell.rlsBypass, cell.id).toBe(serviceIds.has(cell.personaId) ? "bypassrls" : null);
    }
  });

  it("yields exactly the declared static findings", () => {
    expect(findings.map(findingLine)).toEqual(declaredFindings(variant));
  });

  if (variant.kind === "leaky") {
    it("is LEAKING, and every declared failure carries its evidence", () => {
      const { result } = first;
      expect(variant.expectedVerdict).toBe("LEAKING");
      expect(variant.expectedFailures.length).toBeGreaterThan(0);
      for (const cell of result.cells) {
        if (cell.status === "leak") {
          expect(cell.leakedKeys.length, cell.id).toBeGreaterThan(0);
        }
        if (cell.status === "escape") {
          expect(
            cell.subProbes.filter((probe) => probe.status === "escape").length,
            cell.id,
          ).toBeGreaterThan(0);
        }
      }
    });
  } else {
    it("is ISOLATED: zero leaks, zero escapes, no high or critical static finding", () => {
      const { result } = first;
      expect(result.verdict).toBe("ISOLATED");
      expect(result.counts.leak).toBe(0);
      expect(result.counts.escape).toBe(0);
      expect(result.cells.flatMap((cell) => [...cell.leakedKeys, ...cell.missingKeys])).toEqual([]);
      expect(
        findings
          .filter((finding) => BLOCKING_SEVERITIES.includes(finding.severity))
          .map(findingLine),
      ).toEqual([]);
    });
  }

  it("matches the golden result JSON", async () => {
    await expect(toJson(first.result)).toMatchFileSnapshot(`./__snapshots__/${id}.result.json`);
  });

  it("matches the golden static findings JSON", async () => {
    await expect(toJson(findings)).toMatchFileSnapshot(`./__snapshots__/${id}.findings.json`);
  });

  it(
    "is deterministic: a second, independent run yields byte-identical JSON",
    async () => {
      const second = await run(variant.scenario);
      expect(toJson(second.result)).toBe(toJson(first.result));
      expect(toJson(runStaticChecks(second.catalog, variant.scenario))).toBe(toJson(findings));
    },
    RUN_TIMEOUT_MS,
  );
});
