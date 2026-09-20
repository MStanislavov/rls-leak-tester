/**
 * The quality gate conditions that scripts/sonar/bootstrap.sh sets: derived from rules.yaml, in
 * the vocabulary of the server's mode, on overall code and on new code.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  desiredConditions,
  formatPlan,
  main,
  planGate,
} from "../../scripts/sonar/gate-conditions.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const thresholds = () =>
  (parse(readFileSync(path.join(REPO_ROOT, "rules.yaml"), "utf8")) as { thresholds: unknown })
    .thresholds;
const compact = (mode: "MQR" | "STANDARD") =>
  desiredConditions(thresholds(), mode).map(({ metric, op, error }) => `${metric} ${op} ${error}`);

describe("desiredConditions", () => {
  it("states the gate of the brief in MQR vocabulary, on overall and on new code", () => {
    expect(compact("MQR")).toEqual([
      "coverage LT 80",
      "new_coverage LT 80",
      "duplicated_lines_density GT 3",
      "new_duplicated_lines_density GT 3",
      "software_quality_reliability_rating GT 1",
      "new_software_quality_reliability_rating GT 1",
      "software_quality_security_rating GT 1",
      "new_software_quality_security_rating GT 1",
      "software_quality_maintainability_rating GT 1",
      "new_software_quality_maintainability_rating GT 1",
      "security_hotspots_reviewed LT 100",
      "new_security_hotspots_reviewed LT 100",
      "software_quality_blocker_issues GT 0",
      "new_software_quality_blocker_issues GT 0",
      "software_quality_high_issues GT 0",
      "new_software_quality_high_issues GT 0",
    ]);
  });

  it("uses the classic metric keys for a server in standard mode", () => {
    const standard = compact("STANDARD");
    expect(standard).toHaveLength(16);
    expect(standard).toContain("reliability_rating GT 1");
    expect(standard).toContain("sqale_rating GT 1");
    expect(standard).toContain("new_maintainability_rating GT 1");
    expect(standard).toContain("blocker_violations GT 0");
    expect(standard).toContain("new_critical_violations GT 0");
    expect(standard.some((line) => line.includes("software_quality"))).toBe(false);
  });

  it("pairs every overall condition with the same condition on new code", () => {
    const conditions = desiredConditions(thresholds(), "MQR");
    for (let index = 0; index < conditions.length; index += 2) {
      const [overall, fresh] = [conditions[index], conditions[index + 1]];
      expect(overall?.scope).toBe("overall");
      expect(fresh?.scope).toBe("new");
      expect(fresh?.metric.startsWith("new_")).toBe(true);
      expect([fresh?.op, fresh?.error]).toEqual([overall?.op, overall?.error]);
    }
  });

  it("follows rules.yaml and refuses thresholds it cannot express", () => {
    const base = thresholds() as Record<string, Record<string, unknown>>;
    const stricter = { ...base, coverage: { ...base.coverage, lines_min_percent: 90 } };
    expect(desiredConditions(stricter, "MQR")[0]).toMatchObject({
      metric: "coverage",
      error: "90",
    });
    const oneSided = { ...base, quality_gate: { ...base.quality_gate, applies_to: ["new_code"] } };
    expect(() => desiredConditions(oneSided, "MQR")).toThrow(/overall_code and new_code/);
    const badRating = { ...base, quality_gate: { ...base.quality_gate, security_rating: "F" } };
    expect(() => desiredConditions(badRating, "MQR")).toThrow(/security_rating/);
    const noNumber = { ...base, duplication: {} };
    expect(() => desiredConditions(noNumber, "MQR")).toThrow(/duplicated_lines_max_percent/);
    expect(() => desiredConditions(base, "OTHER" as "MQR")).toThrow(/unknown mode/);
  });
});

describe("planGate", () => {
  const desired = desiredConditions(thresholds(), "MQR").slice(0, 4);
  const known = new Set(desired.map((condition) => condition.metric));

  it("creates what is missing, corrects what differs, keeps the rest and never deletes", () => {
    const existing = [
      { id: "a", metric: "new_coverage", op: "LT", error: "80" },
      { id: "b", metric: "new_duplicated_lines_density", op: "GT", error: "5" },
      { id: "c", metric: "new_violations", op: "GT", error: "0" },
    ];
    expect(formatPlan(planGate(existing, desired, known))).toEqual([
      "create\t-\tcoverage\tLT\t80\toverall",
      "keep\t-\tnew_coverage\tLT\t80\tnew",
      "create\t-\tduplicated_lines_density\tGT\t3\toverall",
      "update\tb\tnew_duplicated_lines_density\tGT\t3\tnew",
      "extra\tc\tnew_violations\tGT\t0\t-",
    ]);
  });

  it("corrects a condition whose operator was turned around", () => {
    const existing = [{ id: "a", metric: "coverage", op: "GT", error: "80" }];
    expect(planGate(existing, desired.slice(0, 1), known)[0]).toMatchObject({
      action: "update",
      id: "a",
    });
  });

  it("reports a metric the server does not know instead of guessing another one", () => {
    const steps = planGate([], desired, new Set(["coverage"]));
    expect(steps.map((step) => step.action)).toEqual([
      "create",
      "missing-metric",
      "missing-metric",
      "missing-metric",
    ]);
  });
});

describe("main", () => {
  it("lists the conditions and plans against files read from disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-"));
    try {
      const gate = path.join(dir, "gate.json");
      const metrics = path.join(dir, "metrics.json");
      const all = desiredConditions(thresholds(), "MQR");
      writeFileSync(gate, JSON.stringify({ name: "RLS Leak Tester" }));
      writeFileSync(
        metrics,
        JSON.stringify({ metrics: all.map(({ metric }) => ({ key: metric })) }),
      );
      expect(main(["list", "MQR"])).toHaveLength(16);
      const plan = main(["plan", "MQR", gate, metrics]);
      expect(plan).toHaveLength(16);
      expect(plan.every((line) => line.startsWith("create\t"))).toBe(true);
      expect(() => main(["plan", "MQR"])).toThrow(/usage/);
      expect(() => main(["list", "mqr"])).toThrow(/MQR or STANDARD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
