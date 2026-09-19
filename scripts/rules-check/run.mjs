/**
 * Runs the rules check over a repository: validate rules.yaml, then execute every rule that
 * rules.yaml marks as enforced by this script.
 *
 * - Full mode (no paths): walks the working tree and runs every file check and every repository
 *   check. When git is available, files git ignores are left out.
 * - Fast mode (paths given): only the file checks that apply to those files, plus a repository
 *   check when one of the paths triggers it. No tree walk, no git call unless an environment file
 *   name was passed.
 */
import {
  checkTrackedEnvFiles,
  FILE_CHECKS,
  GIT_CHECK_RULE,
  IMPLEMENTED_RULES,
  isEnvFile,
  makeSource,
  REPO_CHECKS,
} from "./checks.mjs";
import {
  createGitInfo,
  createRepoView,
  gitTrackedAmong,
  normalizeInputPaths,
  resolveRoot,
  SKIP_DIRS,
} from "./repo.mjs";
import { RULES_FILE, SCHEMA_RULE_ID, SELF_SCRIPT, validateRulesFile } from "./schema.mjs";

/**
 * @typedef {import("./schema.mjs").Violation} Violation
 * @typedef {{
 *   mode: "full" | "fast",
 *   ok: boolean,
 *   violations: Violation[],
 *   filesChecked: number,
 *   rulesRun: string[],
 *   durationMs: number,
 * }} RulesCheckResult
 * @typedef {{
 *   root: string,
 *   paths?: readonly string[] | null,
 *   cwd?: string,
 *   git?: import("./repo.mjs").GitInfo & { trackedAmong?: (paths: string[]) => string[] },
 * }} RulesCheckOptions
 */

const COVERAGE_FLOOR = 80;
const ROUTE_LINES_CEILING = 80;

/**
 * Problems in how rules.yaml and this script refer to each other.
 * @param {import("./schema.mjs").RulesFileResult} rulesFile
 * @param {import("./checks.mjs").RepoView} repo
 * @returns {Violation[]}
 */
function checkRegistry(rulesFile, repo) {
  /** @type {Violation[]} */
  const violations = [];
  /** @param {number} line @param {string} message */
  const report = (line, message) => {
    violations.push({ rule: SCHEMA_RULE_ID, path: RULES_FILE, line, message });
  };
  const marked = rulesFile.scriptRuleIds;
  if (marked !== null) {
    for (const id of marked) {
      if (!IMPLEMENTED_RULES.includes(id)) {
        report(
          rulesFile.ruleLines.get(id) ?? 1,
          `${id} is marked ${SELF_SCRIPT} but the script has no check for it`,
        );
      }
    }
    for (const id of IMPLEMENTED_RULES) {
      if (!marked.includes(id)) {
        report(
          rulesFile.ruleLines.get(id) ?? 1,
          `the script implements ${id}, so its enforced_by must include ${SELF_SCRIPT}: a check is never switched off by editing rules.yaml`,
        );
      }
    }
  }
  for (const [index, rule] of (rulesFile.data?.rules ?? []).entries()) {
    const enforcers = Array.isArray(rule.enforced_by) ? rule.enforced_by : [rule.enforced_by];
    for (const enforcer of enforcers) {
      const script = enforcer.startsWith("script:") ? enforcer.slice("script:".length) : null;
      if (script !== null && !repo.exists(script)) {
        report(
          rulesFile.ruleLines.get(rule.id) ?? index + 1,
          `${rule.id} is enforced by ${script}, which does not exist`,
        );
      }
    }
  }
  return violations;
}

/**
 * @param {Violation[]} violations
 * @returns {Violation[]}
 */
function sortedUnique(violations) {
  /** @type {Map<string, Violation>} */
  const unique = new Map();
  for (const violation of violations) {
    unique.set(
      `${violation.path}\u0000${violation.line}\u0000${violation.rule}\u0000${violation.message}`,
      violation,
    );
  }
  return [...unique.values()].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule) ||
      a.message.localeCompare(b.message),
  );
}

/**
 * @param {RulesCheckOptions} options
 * @returns {RulesCheckResult}
 */
export function runRulesCheck(options) {
  const started = performance.now();
  const root = resolveRoot(options.root);
  const git = options.git ?? {
    ...createGitInfo(root),
    trackedAmong: (/** @type {string[]} */ paths) => gitTrackedAmong(root, paths),
  };
  const fast = options.paths !== undefined && options.paths !== null;
  const unignored = fast ? null : git.unignored();
  const repo = createRepoView(root, { keep: unignored === null ? null : new Set(unignored) });

  /** @type {Violation[]} */
  const violations = [];
  const rulesText = repo.read(RULES_FILE);
  const rulesFile = rulesText === null ? null : validateRulesFile(rulesText);
  if (rulesFile === null) {
    violations.push({
      rule: SCHEMA_RULE_ID,
      path: RULES_FILE,
      line: 1,
      message: "rules.yaml is missing: it is the source of truth for every rule",
    });
  } else {
    violations.push(...rulesFile.violations, ...checkRegistry(rulesFile, repo));
  }

  // An unreadable rule list never switches a check off: then every implemented check runs.
  const marked = rulesFile?.scriptRuleIds ?? null;
  const enabled = new Set(
    marked === null ? IMPLEMENTED_RULES : marked.filter((id) => IMPLEMENTED_RULES.includes(id)),
  );
  const thresholds = rulesFile?.data?.thresholds;
  /** @type {import("./checks.mjs").CheckContext} */
  const context = {
    routeMaxLines: Math.min(
      ROUTE_LINES_CEILING,
      thresholds?.architecture.route_handler_max_lines ?? ROUTE_LINES_CEILING,
    ),
    coverageMin: {
      lines: Math.max(COVERAGE_FLOOR, thresholds?.coverage.lines_min_percent ?? COVERAGE_FLOOR),
      branches: Math.max(
        COVERAGE_FLOOR,
        thresholds?.coverage.branches_min_percent ?? COVERAGE_FLOOR,
      ),
    },
    exclusions: rulesFile?.data ? rulesFile.exclusions : null,
    skipDirs: SKIP_DIRS,
  };

  const files = fast ? normalizeInputPaths(root, options.paths ?? [], options.cwd) : repo.list("");
  const fileChecks = FILE_CHECKS.filter((check) => enabled.has(check.rule));
  let filesChecked = 0;
  for (const path of files) {
    const applicable = fileChecks.filter((check) => check.applies(path));
    if (applicable.length === 0) continue;
    const content = repo.read(path);
    if (content === null) continue;
    filesChecked += 1;
    const source = makeSource(path, content);
    for (const check of applicable) violations.push(...check.run(source, context));
  }

  for (const check of REPO_CHECKS) {
    if (!enabled.has(check.rule)) continue;
    if (fast && !files.some((path) => check.triggers(path))) continue;
    violations.push(...check.run(repo, context));
  }

  if (enabled.has(GIT_CHECK_RULE)) {
    const envFiles = files.filter(isEnvFile);
    const tracked = fast
      ? envFiles.length === 0
        ? []
        : (git.trackedAmong?.(envFiles) ?? [])
      : (git.tracked() ?? []);
    violations.push(...checkTrackedEnvFiles(tracked));
  }

  const result = sortedUnique(violations);
  return {
    mode: fast ? "fast" : "full",
    ok: result.length === 0,
    violations: result,
    filesChecked,
    rulesRun: [...enabled].sort(),
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * One line per violation, then a summary.
 * @param {RulesCheckResult} result
 * @returns {string}
 */
export function formatResult(result) {
  const lines = result.violations.map(
    (violation) => `${violation.rule} ${violation.path}:${violation.line} ${violation.message}`,
  );
  const count = result.violations.length;
  lines.push(
    `rules-check (${result.mode}): ${count === 0 ? "ok" : `${count} violation${count === 1 ? "" : "s"}`}, ` +
      `${result.rulesRun.length} script rules, ${result.filesChecked} files, ${result.durationMs} ms`,
  );
  return lines.join("\n");
}
