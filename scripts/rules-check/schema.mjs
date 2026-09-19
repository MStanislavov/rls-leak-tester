/**
 * The schema of rules.yaml and the semantic checks zod cannot express (duplicate ids, a first
 * principle that is not P1, an exclusion pointing at an unknown rule). Pure: text in, problems out.
 *
 * The schema also carries the floors of section 5 of the brief. Lowering the coverage minimum, the
 * duplication ceiling or a gate rating in rules.yaml fails validation, so the document cannot be
 * edited into a weaker gate (QUAL-002).
 */
import { isMap, isSeq, LineCounter, parseDocument } from "yaml";
import { z } from "zod";

export const RULES_FILE = "rules.yaml";
export const SCHEMA_RULE_ID = "RULES-SCHEMA";
export const SELF_SCRIPT = "script:scripts/rules-check.mjs";

export const AREAS = [
  "architecture",
  "code",
  "testing",
  "security",
  "redis",
  "ai",
  "quality",
  "git",
  "docs",
];
export const SEVERITIES = ["blocker", "major", "minor"];
/** Section 6.1 of the brief, plus the three enforcers the shared rule contract names. */
export const ENFORCERS = [
  "eslint",
  "tsc",
  "hook",
  "sonar",
  "ci",
  "review",
  "vitest",
  "playwright",
  "settings",
];
export const EXCLUSION_TOOLS = [
  "eslint",
  "eslint-rule-off",
  "vitest",
  "vitest-coverage",
  "coverage-scope",
  "sonar",
  "sonar-coverage",
  "sonar-cpd",
  "sonar-test",
  "sonar-issue",
  "rules-check",
  "rule-scope",
];

const text = (minimum = 1) => z.string().trim().min(minimum);
const enforcer = z
  .string()
  .refine(
    (value) => ENFORCERS.includes(value) || /^script:scripts\/[\w./-]+\.(mjs|sh)$/.test(value),
    {
      message: `expected one of ${ENFORCERS.join(", ")} or script:scripts/<file>.mjs`,
    },
  );

const ruleSchema = z.strictObject({
  id: z.string().regex(/^[A-Z]+-\d{3}$/, "expected an id such as ARCH-001"),
  area: z.enum(AREAS),
  severity: z.enum(SEVERITIES),
  statement: text(10),
  rationale: text(10),
  enforced_by: z.union([enforcer, z.array(enforcer).min(1, "enforced_by must not be empty")], {
    error: "a rule needs enforced_by: an enforcer or a non-empty list of enforcers",
  }),
  check: z.union([text(), z.array(text()).min(1)]).optional(),
});

const rateLimit = z.strictObject({
  window_seconds: z.number().int().positive(),
  per_ip: z.number().int().positive(),
  per_user: z.number().int().positive(),
});

const thresholdsSchema = z.strictObject({
  coverage: z.strictObject({
    scope: z.literal("src/lib/**"),
    lines_min_percent: z.number().min(80).max(100),
    branches_min_percent: z.number().min(80).max(100),
  }),
  duplication: z.strictObject({
    duplicated_lines_max_percent: z.number().min(0).max(3),
  }),
  quality_gate: z.strictObject({
    name: z.literal("RLS Leak Tester"),
    project_key: z.literal("postgres-rls-leak-tester"),
    applies_to: z
      .array(z.enum(["overall_code", "new_code"]))
      .refine((value) => value.includes("overall_code") && value.includes("new_code"), {
        message: "the gate applies to overall_code and to new_code",
      }),
    reliability_rating: z.literal("A"),
    security_rating: z.literal("A"),
    maintainability_rating: z.literal("A"),
    security_hotspots_reviewed_min_percent: z.literal(100),
    blocker_issues_max: z.literal(0),
    critical_issues_max: z.literal(0),
  }),
  architecture: z.strictObject({
    route_handler_max_lines: z.number().int().positive().max(80),
  }),
  runner: z.strictObject({
    probe_timeout_ms: z.number().int().positive().max(5000),
    run_ceiling_ms: z.number().int().positive(),
  }),
  ai: z.strictObject({
    explain_payload_max_bytes: z.number().int().positive().max(30720),
    explanation_cache_ttl_seconds: z.number().int().positive().max(604800),
    single_flight_lock_ttl_ms: z.number().int().positive(),
  }),
  redis: z.strictObject({
    key_scheme: z.literal("rlsleak:{env}:{purpose}:{id}"),
    scenario_cache_ttl_seconds: z.number().int().positive(),
  }),
  rate_limits: z.strictObject({
    explain: rateLimit,
    scenario_writes: rateLimit,
  }),
});

const exclusionSchema = z.strictObject({
  tool: z.enum(EXCLUSION_TOOLS),
  pattern: text(),
  reason: z
    .string({ error: "an exclusion needs a written reason" })
    .trim()
    .min(15, "an exclusion needs a written reason of at least 15 characters"),
  source: text().optional(),
  rule: z.string().optional(),
});

const numbered = (/** @type {RegExp} */ pattern, /** @type {string} */ example) =>
  z.strictObject({
    id: z.string().regex(pattern, `expected an id such as ${example}`),
    statement: text(10),
  });

export const rulesFileSchema = z.strictObject({
  version: z.literal(1),
  principles: z.array(numbered(/^P\d+$/, "P1")).min(1),
  rules: z.array(ruleSchema).min(1),
  thresholds: thresholdsSchema,
  exclusions: z.array(exclusionSchema),
  forbidden_actions: z.array(numbered(/^FA-\d+$/, "FA-1")).min(1),
  definition_of_done: z.array(numbered(/^DOD-\d+$/, "DOD-1")).min(1),
});

/**
 * @typedef {{ rule: string, path: string, line: number, message: string }} Violation
 * @typedef {z.infer<typeof rulesFileSchema>} RulesFile
 * @typedef {z.infer<typeof exclusionSchema> & { line: number }} ListedExclusion
 * @typedef {{
 *   data: RulesFile | null,
 *   violations: Violation[],
 *   scriptRuleIds: string[] | null,
 *   ruleLines: Map<string, number>,
 *   exclusions: ListedExclusion[],
 * }} RulesFileResult
 */

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function enforcersOf(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * Parses and validates the text of rules.yaml.
 * @param {string} source
 * @returns {RulesFileResult}
 */
export function validateRulesFile(source) {
  /** @type {Violation[]} */
  const violations = [];
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false });

  /** @param {number} line @param {string} message */
  const report = (line, message) => {
    violations.push({ rule: SCHEMA_RULE_ID, path: RULES_FILE, line, message });
  };
  /**
   * Line of the deepest existing node on a path, so a missing key points at its parent.
   * @param {ReadonlyArray<PropertyKey>} path
   */
  const lineAt = (path) => {
    for (let depth = path.length; depth >= 0; depth -= 1) {
      const node = document.getIn(path.slice(0, depth), true);
      if ((isMap(node) || isSeq(node) || typeof node === "object") && node !== null) {
        const range = /** @type {{ range?: [number, number, number] | null }} */ (node).range;
        if (range) return lineCounter.linePos(range[0]).line;
      }
    }
    return 1;
  };

  for (const error of document.errors) {
    report(lineCounter.linePos(error.pos[0]).line, `YAML syntax: ${error.message.split("\n")[0]}`);
  }
  if (document.errors.length > 0) {
    return { data: null, violations, scriptRuleIds: null, ruleLines: new Map(), exclusions: [] };
  }

  /** @type {unknown} */
  const raw = document.toJS();
  const parsed = rulesFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      report(lineAt(issue.path), `${where}${issue.message}`);
    }
  }

  // The semantic checks run on the raw document as far as its shape allows, so one schema
  // problem does not hide a duplicate id somewhere else.
  const rawRules =
    typeof raw === "object" && raw !== null && Array.isArray(/** @type {any} */ (raw).rules)
      ? /** @type {unknown[]} */ (/** @type {any} */ (raw).rules)
      : null;

  /** @type {Map<string, number>} */
  const ruleLines = new Map();
  /** @type {string[] | null} */
  let scriptRuleIds = rawRules === null ? null : [];
  if (rawRules !== null) {
    rawRules.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null) return;
      const { id, enforced_by: enforcedBy } = /** @type {Record<string, unknown>} */ (entry);
      if (typeof id !== "string") return;
      const line = lineAt(["rules", index]);
      if (ruleLines.has(id)) {
        report(line, `duplicate rule id ${id} (first defined on line ${ruleLines.get(id)})`);
      } else {
        ruleLines.set(id, line);
      }
      if (enforcersOf(enforcedBy).includes(SELF_SCRIPT)) scriptRuleIds?.push(id);
    });
  }

  if (!parsed.success) {
    // An unreadable rule list must never switch checks off: the caller then runs every check.
    if (rawRules === null) scriptRuleIds = null;
    return { data: null, violations, scriptRuleIds, ruleLines, exclusions: [] };
  }

  const data = parsed.data;
  for (const key of /** @type {const} */ ([
    "principles",
    "forbidden_actions",
    "definition_of_done",
  ])) {
    /** @type {Set<string>} */
    const seen = new Set();
    data[key].forEach((entry, index) => {
      if (seen.has(entry.id)) report(lineAt([key, index]), `duplicate id ${entry.id} in ${key}`);
      seen.add(entry.id);
    });
  }
  if (data.principles[0]?.id !== "P1") {
    report(lineAt(["principles", 0]), "the first principle must be P1");
  }

  /** @type {ListedExclusion[]} */
  const exclusions = [];
  /** @type {Set<string>} */
  const seenExclusions = new Set();
  data.exclusions.forEach((entry, index) => {
    const line = lineAt(["exclusions", index]);
    const key = `${entry.tool}\u0000${entry.rule ?? ""}\u0000${entry.pattern}`;
    if (seenExclusions.has(key)) {
      report(line, `duplicate exclusion ${entry.tool} ${entry.pattern}`);
    }
    seenExclusions.add(key);
    if (entry.rule !== undefined && !ruleLines.has(entry.rule)) {
      report(line, `exclusion ${entry.pattern} names the unknown rule ${entry.rule}`);
    }
    if (entry.tool === "rule-scope" && entry.rule === undefined) {
      report(line, `exclusion ${entry.pattern} has tool rule-scope and must name its rule`);
    }
    exclusions.push({ ...entry, line });
  });

  return { data, violations, scriptRuleIds, ruleLines, exclusions };
}
