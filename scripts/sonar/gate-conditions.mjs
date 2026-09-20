#!/usr/bin/env node
/**
 * The conditions of the quality gate "RLS Leak Tester", derived from rules.yaml
 * (thresholds.quality_gate, thresholds.coverage, thresholds.duplication) so that the numbers live
 * in one place. scripts/sonar/bootstrap.sh asks this module what to do and performs the calls.
 *
 * SonarQube has two vocabularies for the same ideas. A server in "MQR" mode (multi-quality rule
 * mode, the default since 10.8) evaluates the software_quality_* metrics and the severities
 * BLOCKER, HIGH, MEDIUM, LOW, INFO; a server in standard mode evaluates the classic metrics and
 * BLOCKER, CRITICAL, MAJOR, MINOR, INFO. CRITICAL and HIGH are the same level. The server refuses
 * a gate that holds both spellings of one condition, so exactly one set is used: the one that
 * matches the mode the server reports.
 *
 * Usage (both read JSON from files, never from the network):
 *   node scripts/sonar/gate-conditions.mjs list <MQR|STANDARD>
 *   node scripts/sonar/gate-conditions.mjs plan <MQR|STANDARD> <gate-show.json> <metrics-search.json>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

/** @typedef {"MQR" | "STANDARD"} GateMode */
/** @typedef {{ metric: string, op: "LT" | "GT", error: string, scope: "overall" | "new", meaning: string }} GateCondition */
/** @typedef {{ id: string, metric: string, op?: string, error: string }} ExistingCondition */
/**
 * @typedef {{ action: "create", condition: GateCondition }
 *   | { action: "update", id: string, condition: GateCondition }
 *   | { action: "keep", condition: GateCondition }
 *   | { action: "missing-metric", condition: GateCondition }
 *   | { action: "extra", existing: ExistingCondition }} PlanStep
 */

const RATINGS = new Map([
  ["A", 1],
  ["B", 2],
  ["C", 3],
  ["D", 4],
  ["E", 5],
]);

/**
 * Metric keys per mode: [overall code, new code].
 * @type {Record<string, Record<"reliability" | "security" | "maintainability" | "blocker" | "critical", readonly [string, string]>>}
 */
const METRIC_KEYS = {
  MQR: {
    reliability: ["software_quality_reliability_rating", "new_software_quality_reliability_rating"],
    security: ["software_quality_security_rating", "new_software_quality_security_rating"],
    maintainability: [
      "software_quality_maintainability_rating",
      "new_software_quality_maintainability_rating",
    ],
    blocker: ["software_quality_blocker_issues", "new_software_quality_blocker_issues"],
    critical: ["software_quality_high_issues", "new_software_quality_high_issues"],
  },
  STANDARD: {
    reliability: ["reliability_rating", "new_reliability_rating"],
    security: ["security_rating", "new_security_rating"],
    maintainability: ["sqale_rating", "new_maintainability_rating"],
    blocker: ["blocker_violations", "new_blocker_violations"],
    critical: ["critical_violations", "new_critical_violations"],
  },
};

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function number(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`rules.yaml thresholds: ${name} must be a number`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function rating(value, name) {
  const found = typeof value === "string" ? RATINGS.get(value) : undefined;
  if (found === undefined) {
    throw new TypeError(`rules.yaml thresholds: ${name} must be one of A to E`);
  }
  return found;
}

/**
 * @param {any} thresholds the `thresholds` mapping of rules.yaml
 * @param {GateMode} mode
 * @returns {GateCondition[]}
 */
export function desiredConditions(thresholds, mode) {
  const keys = METRIC_KEYS[mode];
  if (keys === undefined) throw new Error(`unknown mode "${mode}": expected MQR or STANDARD`);
  const gate = thresholds?.quality_gate ?? {};
  const appliesTo = Array.isArray(gate.applies_to) ? gate.applies_to : [];
  if (!appliesTo.includes("overall_code") || !appliesTo.includes("new_code")) {
    throw new Error(
      "rules.yaml thresholds: quality_gate.applies_to must name overall_code and new_code",
    );
  }
  const coverage = number(thresholds?.coverage?.lines_min_percent, "coverage.lines_min_percent");
  const duplication = number(
    thresholds?.duplication?.duplicated_lines_max_percent,
    "duplication.duplicated_lines_max_percent",
  );
  const hotspots = number(
    gate.security_hotspots_reviewed_min_percent,
    "quality_gate.security_hotspots_reviewed_min_percent",
  );
  /** @type {[readonly string[], "LT" | "GT", number, string][]} */
  const rows = [
    [["coverage", "new_coverage"], "LT", coverage, `coverage at least ${coverage} percent`],
    [
      ["duplicated_lines_density", "new_duplicated_lines_density"],
      "GT",
      duplication,
      `duplicated lines at most ${duplication} percent`,
    ],
    [
      keys.reliability,
      "GT",
      rating(gate.reliability_rating, "quality_gate.reliability_rating"),
      `reliability rating ${gate.reliability_rating}`,
    ],
    [
      keys.security,
      "GT",
      rating(gate.security_rating, "quality_gate.security_rating"),
      `security rating ${gate.security_rating}`,
    ],
    [
      keys.maintainability,
      "GT",
      rating(gate.maintainability_rating, "quality_gate.maintainability_rating"),
      `maintainability rating ${gate.maintainability_rating}`,
    ],
    [
      ["security_hotspots_reviewed", "new_security_hotspots_reviewed"],
      "LT",
      hotspots,
      `security hotspots reviewed ${hotspots} percent`,
    ],
    [
      keys.blocker,
      "GT",
      number(gate.blocker_issues_max, "quality_gate.blocker_issues_max"),
      "blocker issues",
    ],
    [
      keys.critical,
      "GT",
      number(gate.critical_issues_max, "quality_gate.critical_issues_max"),
      mode === "MQR" ? "critical issues (called high severity in MQR mode)" : "critical issues",
    ],
  ];
  /** @type {GateCondition[]} */
  const conditions = [];
  for (const [[overall, fresh], op, error, meaning] of rows) {
    if (overall === undefined || fresh === undefined) throw new Error("a metric key is missing");
    conditions.push(
      { metric: overall, op, error: String(error), scope: "overall", meaning },
      { metric: fresh, op, error: String(error), scope: "new", meaning },
    );
  }
  return conditions;
}

/**
 * What has to happen to a gate so that it holds every desired condition. Conditions the gate has
 * beyond the desired ones are reported as "extra" and left alone: a gate is a conjunction, so an
 * extra condition can only make it stricter (a new gate is born with the server's own
 * "Clean as You Code" conditions, one of which, no new issues at all, is such an extra).
 * @param {readonly ExistingCondition[]} existing the `conditions` of api/qualitygates/show
 * @param {readonly GateCondition[]} desired
 * @param {ReadonlySet<string>} knownMetrics the metric keys of api/metrics/search
 * @returns {PlanStep[]}
 */
export function planGate(existing, desired, knownMetrics) {
  /** @type {PlanStep[]} */
  const steps = [];
  const wanted = new Set(desired.map((condition) => condition.metric));
  for (const condition of desired) {
    const current = existing.find((entry) => entry.metric === condition.metric);
    if (!knownMetrics.has(condition.metric)) {
      steps.push({ action: "missing-metric", condition });
    } else if (current === undefined) {
      steps.push({ action: "create", condition });
    } else if (
      (current.op ?? condition.op) !== condition.op ||
      Number(current.error) !== Number(condition.error)
    ) {
      steps.push({ action: "update", id: current.id, condition });
    } else {
      steps.push({ action: "keep", condition });
    }
  }
  for (const entry of existing) {
    if (!wanted.has(entry.metric)) steps.push({ action: "extra", existing: entry });
  }
  return steps;
}

/**
 * One tab-separated line per step, for the shell: action, id, metric, op, error, scope.
 * @param {readonly PlanStep[]} steps
 * @returns {string[]}
 */
export function formatPlan(steps) {
  return steps.map((step) => {
    if (step.action === "extra") {
      const { id, metric, op, error } = step.existing;
      return ["extra", id, metric, op ?? "-", error, "-"].join("\t");
    }
    const { metric, op, error, scope } = step.condition;
    return [step.action, step.action === "update" ? step.id : "-", metric, op, error, scope].join(
      "\t",
    );
  });
}

/** @returns {any} */
function readThresholds() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return parse(readFileSync(path.join(root, "rules.yaml"), "utf8")).thresholds;
}

/**
 * @param {readonly string[]} argv
 * @returns {string[]}
 */
export function main(argv) {
  const [command, mode, gateFile, metricsFile] = argv;
  if (mode !== "MQR" && mode !== "STANDARD") throw new Error("mode must be MQR or STANDARD");
  const desired = desiredConditions(readThresholds(), mode);
  if (command === "list") {
    return desired.map(({ metric, op, error, scope }) => [metric, op, error, scope].join("\t"));
  }
  if (command === "plan" && gateFile !== undefined && metricsFile !== undefined) {
    const gate = JSON.parse(readFileSync(gateFile, "utf8"));
    const metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
    const known = new Set(
      /** @type {{ key: string }[]} */ (metrics.metrics ?? []).map((metric) => metric.key),
    );
    return formatPlan(planGate(gate.conditions ?? [], desired, known));
  }
  throw new Error(
    "usage: gate-conditions.mjs list <mode> | plan <mode> <gate.json> <metrics.json>",
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    for (const line of main(process.argv.slice(2))) console.log(line);
  } catch (error) {
    console.error(`gate-conditions: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
