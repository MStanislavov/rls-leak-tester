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
import { byCodeUnit } from "./text.mjs";

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
 * The rules rules.yaml marks as enforced by this script are exactly the ones it implements.
 * @param {readonly string[]} marked
 * @param {(id: string, message: string) => void} report
 */
function checkMarkedRules(marked, report) {
  for (const id of marked) {
    if (!IMPLEMENTED_RULES.includes(id)) {
      report(id, `${id} is marked ${SELF_SCRIPT} but the script has no check for it`);
    }
  }
  for (const id of IMPLEMENTED_RULES) {
    if (!marked.includes(id)) {
      report(
        id,
        `the script implements ${id}, so its enforced_by must include ${SELF_SCRIPT}: a check is never switched off by editing rules.yaml`,
      );
    }
  }
}

/**
 * The scripts a rule names as its enforcer (`script:<path>`).
 * @param {string | readonly string[]} enforcedBy
 * @returns {string[]}
 */
function enforcerScripts(enforcedBy) {
  const enforcers = Array.isArray(enforcedBy) ? enforcedBy : [enforcedBy];
  return enforcers
    .filter((enforcer) => enforcer.startsWith("script:"))
    .map((enforcer) => enforcer.slice("script:".length));
}

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
  if (rulesFile.scriptRuleIds !== null) {
    checkMarkedRules(rulesFile.scriptRuleIds, (id, message) => {
      report(rulesFile.ruleLines.get(id) ?? 1, message);
    });
  }
  for (const [index, rule] of (rulesFile.data?.rules ?? []).entries()) {
    for (const script of enforcerScripts(rule.enforced_by)) {
      if (!repo.exists(script)) {
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
 * rules.yaml as the checks need it, and what is wrong with the file itself.
 * @param {import("./checks.mjs").RepoView} repo
 * @returns {{ rulesFile: import("./schema.mjs").RulesFileResult | null, violations: Violation[] }}
 */
function readRulesFile(repo) {
  const rulesText = repo.read(RULES_FILE);
  if (rulesText === null) {
    const missing = {
      rule: SCHEMA_RULE_ID,
      path: RULES_FILE,
      line: 1,
      message: "rules.yaml is missing: it is the source of truth for every rule",
    };
    return { rulesFile: null, violations: [missing] };
  }
  const rulesFile = validateRulesFile(rulesText);
  return { rulesFile, violations: [...rulesFile.violations, ...checkRegistry(rulesFile, repo)] };
}

/**
 * The thresholds of rules.yaml, never looser than the floors of this script.
 * @param {import("./schema.mjs").RulesFileResult | null} rulesFile
 * @returns {import("./checks.mjs").CheckContext}
 */
function contextOf(rulesFile) {
  const thresholds = rulesFile?.data?.thresholds;
  return {
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
}

/**
 * Runs the enabled file checks over `files`.
 * @param {import("./checks.mjs").RepoView} repo
 * @param {readonly string[]} files
 * @param {ReadonlySet<string>} enabled
 * @param {import("./checks.mjs").CheckContext} context
 * @returns {{ violations: Violation[], filesChecked: number }}
 */
function runFileChecks(repo, files, enabled, context) {
  /** @type {Violation[]} */
  const violations = [];
  const fileChecks = FILE_CHECKS.filter((check) => enabled.has(check.rule));
  let filesChecked = 0;
  for (const path of files) {
    const applicable = fileChecks.filter((check) => check.applies(path));
    const content = applicable.length === 0 ? null : repo.read(path);
    if (content === null) continue;
    filesChecked += 1;
    const source = makeSource(path, content);
    for (const check of applicable) violations.push(...check.run(source, context));
  }
  return { violations, filesChecked };
}

/**
 * Fast mode asks git about the environment file names it was given, and only when there is one.
 * @param {NonNullable<RulesCheckOptions["git"]>} git
 * @param {readonly string[]} files
 * @returns {string[]}
 */
function trackedAmongGiven(git, files) {
  const envFiles = files.filter(isEnvFile);
  return envFiles.length === 0 ? [] : (git.trackedAmong?.(envFiles) ?? []);
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

  const { rulesFile, violations } = readRulesFile(repo);
  // An unreadable rule list never switches a check off: then every implemented check runs.
  const marked = rulesFile?.scriptRuleIds ?? null;
  const enabled = new Set(
    marked === null ? IMPLEMENTED_RULES : marked.filter((id) => IMPLEMENTED_RULES.includes(id)),
  );
  const context = contextOf(rulesFile);

  const files = fast ? normalizeInputPaths(root, options.paths ?? [], options.cwd) : repo.list("");
  const fileResults = runFileChecks(repo, files, enabled, context);
  violations.push(...fileResults.violations);

  for (const check of REPO_CHECKS) {
    if (!enabled.has(check.rule)) continue;
    if (fast && !files.some((path) => check.triggers(path))) continue;
    violations.push(...check.run(repo, context));
  }

  if (enabled.has(GIT_CHECK_RULE)) {
    const tracked = fast ? trackedAmongGiven(git, files) : (git.tracked() ?? []);
    violations.push(...checkTrackedEnvFiles(tracked));
  }

  const result = sortedUnique(violations);
  return {
    mode: fast ? "fast" : "full",
    ok: result.length === 0,
    violations: result,
    filesChecked: fileResults.filesChecked,
    rulesRun: [...enabled].sort(byCodeUnit),
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
  const found = `${count} ${count === 1 ? "violation" : "violations"}`;
  lines.push(
    `rules-check (${result.mode}): ${count === 0 ? "ok" : found}, ` +
      `${result.rulesRun.length} script rules, ${result.filesChecked} files, ${result.durationMs} ms`,
  );
  return lines.join("\n");
}
