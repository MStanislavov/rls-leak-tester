import { readFileSync } from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { IMPLEMENTED_RULES } from "../../scripts/rules-check/checks.mjs";
import {
  AREAS,
  SCHEMA_RULE_ID,
  SELF_SCRIPT,
  validateRulesFile,
} from "../../scripts/rules-check/schema.mjs";

import { REPO_ROOT } from "./helpers";

const REAL_RULES = readFileSync(path.join(REPO_ROOT, "rules.yaml"), "utf8");

interface RuleEntry {
  id: string;
  area: string;
  severity: string;
  enforced_by?: string | string[];
  [key: string]: unknown;
}
interface RulesDocument {
  principles: { id: string; statement: string }[];
  rules: RuleEntry[];
  thresholds: Record<string, Record<string, unknown>>;
  exclusions: Record<string, unknown>[];
  forbidden_actions: { id: string; statement: string }[];
  definition_of_done: { id: string; statement: string }[];
  [key: string]: unknown;
}

/** The real document, changed by `mutate`, validated again. */
function validateMutated(mutate: (document: RulesDocument) => void) {
  const document = parse(REAL_RULES) as RulesDocument;
  mutate(document);
  return validateRulesFile(stringify(document));
}

const messages = (result: ReturnType<typeof validateRulesFile>): string[] =>
  result.violations.map((violation) => violation.message);

describe("the real rules.yaml", () => {
  const result = validateRulesFile(REAL_RULES);

  it("is valid", () => {
    expect(result.violations).toEqual([]);
    expect(result.data).not.toBeNull();
  });

  it("puts the core principle first", () => {
    const first = result.data?.principles[0];
    expect(first?.id).toBe("P1");
    expect(first?.statement).toMatch(/deterministic verdicts/i);
    expect(first?.statement).toMatch(/never decides/i);
  });

  it("holds every rule of the shared contract with its severity", () => {
    const severities = Object.fromEntries(
      (result.data?.rules ?? []).map((rule) => [rule.id, rule.severity]),
    );
    expect(severities).toEqual({
      "ARCH-001": "blocker",
      "ARCH-002": "blocker",
      "ARCH-003": "major",
      "ARCH-004": "major",
      "CODE-001": "major",
      "CODE-002": "major",
      "CODE-003": "major",
      "SEC-001": "blocker",
      "SEC-002": "blocker",
      "SEC-003": "blocker",
      "SEC-004": "blocker",
      "SEC-005": "major",
      "RUN-001": "blocker",
      "TEST-001": "blocker",
      "TEST-002": "major",
      "REDIS-001": "blocker",
      "REDIS-002": "blocker",
      "AI-001": "major",
      "AI-002": "blocker",
      "QUAL-001": "major",
      "QUAL-002": "blocker",
      "GIT-001": "minor",
      "GIT-002": "blocker",
      "DOCS-001": "minor",
    });
  });

  it("marks exactly the implemented checks as enforced by the script", () => {
    expect([...(result.scriptRuleIds ?? [])].sort()).toEqual(IMPLEMENTED_RULES);
  });

  it("gives every rule a machine-readable check hint and uses every area", () => {
    const rules = result.data?.rules ?? [];
    expect(rules.filter((rule) => rule.check === undefined)).toEqual([]);
    expect(new Set(rules.map((rule) => rule.area))).toEqual(new Set(AREAS));
  });

  it("lists the forbidden actions of section 10 and the checklist of section 8", () => {
    expect(result.data?.forbidden_actions).toHaveLength(7);
    expect(result.data?.definition_of_done).toHaveLength(12);
  });

  it("knows the line of every rule", () => {
    const line = result.ruleLines.get("ARCH-001") ?? 0;
    expect(REAL_RULES.split("\n")[line - 1]).toContain("id: ARCH-001");
  });
});

describe("schema failures", () => {
  it("fails on a rule without enforced_by and points at the rule", () => {
    const result = validateMutated((document) => {
      delete document.rules[2]?.enforced_by;
    });
    expect(result.data).toBeNull();
    expect(result.violations).toHaveLength(1);
    const [violation] = result.violations;
    expect(violation?.rule).toBe(SCHEMA_RULE_ID);
    expect(violation?.path).toBe("rules.yaml");
    expect(violation?.message).toMatch(/rules\.2\.enforced_by: a rule needs enforced_by/);
    expect(violation?.line).toBeGreaterThan(1);
  });

  it("fails on an empty enforced_by list", () => {
    const result = validateMutated((document) => {
      const rule = document.rules[0];
      if (rule) rule.enforced_by = [];
    });
    expect(messages(result).join("\n")).toMatch(/enforced_by/);
  });

  it("fails on an unknown enforcer", () => {
    const result = validateMutated((document) => {
      const rule = document.rules[0];
      if (rule) rule.enforced_by = ["hope"];
    });
    expect(messages(result).join("\n")).toMatch(/enforced_by/);
  });

  it("fails on a duplicate rule id", () => {
    const result = validateMutated((document) => {
      const copy = document.rules[0];
      if (copy) document.rules.push({ ...copy });
    });
    expect(messages(result)).toEqual([
      expect.stringMatching(/^duplicate rule id ARCH-001 \(first defined on line \d+\)$/),
    ]);
  });

  it("still reports a duplicate id when another rule breaks the schema", () => {
    const result = validateMutated((document) => {
      const copy = document.rules[0];
      if (copy) document.rules.push({ ...copy });
      const broken = document.rules[1];
      if (broken) broken.severity = "catastrophic";
    });
    expect(messages(result).some((message) => message.startsWith("duplicate rule id"))).toBe(true);
    expect(messages(result).some((message) => message.startsWith("rules.1.severity"))).toBe(true);
  });

  it("fails on an unknown area and on an unknown severity", () => {
    const area = validateMutated((document) => {
      const rule = document.rules[0];
      if (rule) rule.area = "vibes";
    });
    expect(messages(area)).toEqual([expect.stringMatching(/^rules\.0\.area: /)]);
    const severity = validateMutated((document) => {
      const rule = document.rules[0];
      if (rule) rule.severity = "trivial";
    });
    expect(messages(severity)).toEqual([expect.stringMatching(/^rules\.0\.severity: /)]);
  });

  it("fails on a malformed rule id and on an unknown key", () => {
    const result = validateMutated((document) => {
      const rule = document.rules[0];
      if (rule) {
        rule.id = "arch-1";
        rule.owner = "nobody";
      }
    });
    expect(messages(result).join("\n")).toMatch(/rules\.0\.id/);
    expect(messages(result).join("\n")).toMatch(/owner/);
  });

  it("fails on an exclusion without a reason", () => {
    const missing = validateMutated((document) => {
      delete document.exclusions[0]?.reason;
    });
    expect(messages(missing)).toEqual(["exclusions.0.reason: an exclusion needs a written reason"]);
    const tooShort = validateMutated((document) => {
      const exclusion = document.exclusions[0];
      if (exclusion) exclusion.reason = "because";
    });
    expect(messages(tooShort)).toEqual([
      "exclusions.0.reason: an exclusion needs a written reason of at least 15 characters",
    ]);
  });

  it("fails on an exclusion for an unknown tool, an unknown rule or a rule scope without a rule", () => {
    const tool = validateMutated((document) => {
      const exclusion = document.exclusions[0];
      if (exclusion) exclusion.tool = "magic";
    });
    expect(messages(tool)).toEqual([expect.stringMatching(/^exclusions\.0\.tool: /)]);

    const semantic = validateMutated((document) => {
      const reason = "A written reason that is long enough.";
      document.exclusions.push({ tool: "rule-scope", rule: "NOPE-999", pattern: "a/**", reason });
      document.exclusions.push({ tool: "rule-scope", pattern: "b/**", reason });
    });
    expect(messages(semantic)).toEqual([
      "exclusion a/** names the unknown rule NOPE-999",
      "exclusion b/** has tool rule-scope and must name its rule",
    ]);
  });

  it("fails on a duplicate exclusion", () => {
    const result = validateMutated((document) => {
      const copy = document.exclusions[0];
      if (copy) document.exclusions.push({ ...copy });
    });
    expect(messages(result)).toEqual([expect.stringMatching(/^duplicate exclusion eslint /)]);
  });

  it("refuses thresholds that are weaker than the brief", () => {
    const weakened: [string, string, unknown][] = [
      ["coverage", "lines_min_percent", 79],
      ["coverage", "branches_min_percent", 50],
      ["duplication", "duplicated_lines_max_percent", 5],
      ["quality_gate", "security_rating", "B"],
      ["quality_gate", "security_hotspots_reviewed_min_percent", 90],
      ["quality_gate", "blocker_issues_max", 1],
      ["architecture", "route_handler_max_lines", 200],
      ["runner", "probe_timeout_ms", 60000],
      ["ai", "explain_payload_max_bytes", 1000000],
      ["ai", "explanation_cache_ttl_seconds", 9999999],
    ];
    for (const [group, key, value] of weakened) {
      const result = validateMutated((document) => {
        const section = document.thresholds[group];
        if (section) section[key] = value;
      });
      expect(messages(result), `${group}.${key}`).toEqual([
        expect.stringMatching(new RegExp(`^thresholds\\.${group}\\.${key}: `)),
      ]);
    }
  });

  it("refuses a gate that skips overall code", () => {
    const result = validateMutated((document) => {
      const gate = document.thresholds.quality_gate;
      if (gate) gate.applies_to = ["new_code"];
    });
    expect(messages(result)).toEqual([
      "thresholds.quality_gate.applies_to: the gate applies to overall_code and to new_code",
    ]);
  });

  it("requires P1 first and unique ids in the numbered lists", () => {
    const order = validateMutated((document) => {
      document.principles.reverse();
    });
    expect(messages(order)).toEqual(["the first principle must be P1"]);
    const duplicate = validateMutated((document) => {
      const copy = document.forbidden_actions[0];
      if (copy) document.forbidden_actions.push({ ...copy });
    });
    expect(messages(duplicate)).toEqual(["duplicate id FA-1 in forbidden_actions"]);
  });

  it("fails on a missing section and on a wrong version", () => {
    const result = validateMutated((document) => {
      Reflect.deleteProperty(document, "definition_of_done");
      document.version = 2;
    });
    expect(messages(result).join("\n")).toMatch(/version/);
    expect(messages(result).join("\n")).toMatch(/definition_of_done/);
  });

  it("reports a YAML syntax error with its line and runs no semantic checks", () => {
    const result = validateRulesFile("version: 1\nrules:\n  - id: [unclosed\n");
    expect(result.data).toBeNull();
    expect(result.scriptRuleIds).toBeNull();
    expect(result.violations[0]?.message).toMatch(/^YAML syntax: /);
    expect(result.violations[0]?.line).toBeGreaterThanOrEqual(3);
  });

  it("never reports fewer script rules because the document is broken", () => {
    const noRules = validateRulesFile("version: 1\n");
    expect(noRules.scriptRuleIds).toBeNull();
    const brokenElsewhere = validateMutated((document) => {
      document.version = 7;
    });
    expect(brokenElsewhere.scriptRuleIds).toContain("SEC-003");
    expect(SELF_SCRIPT).toBe("script:scripts/rules-check.mjs");
  });
});
