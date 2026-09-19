#!/usr/bin/env node
/**
 * Conventional Commits check for .husky/commit-msg (rules.yaml GIT-001). No dependency.
 *
 *   node scripts/hooks/commit-msg.mjs <path to the commit message file>
 *
 * The subject is the first line that is neither empty nor a git comment. It must read
 * `type(scope)!: subject` with the scope and the `!` optional. Merge commits pass as git writes
 * them. Exit code 0 when the message is fine, 1 when it is not, 2 on a usage error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

/** Keep in step with the `check` of GIT-001 in rules.yaml. */
export const SUBJECT_PATTERN = new RegExp(
  String.raw`^(${COMMIT_TYPES.join("|")})(\([\w./-]+\))?!?: \S.*$`,
);
const MERGE_PATTERN = /^Merge /;

/**
 * @param {string} message the whole commit message file
 * @returns {string} the subject line, or "" when there is none
 */
export function subjectOf(message) {
  for (const line of message.split(/\r?\n/)) {
    // Everything below the scissors line is the diff of `git commit --verbose`.
    if (/^# -{24} >8 -{24}$/.test(line)) break;
    if (line.startsWith("#") || line.trim() === "") continue;
    return line.trimEnd();
  }
  return "";
}

/**
 * @param {string} message the whole commit message file
 * @returns {{ ok: true, subject: string } | { ok: false, subject: string, reason: string }}
 */
export function checkCommitMessage(message) {
  const subject = subjectOf(message);
  if (subject === "") return { ok: false, subject, reason: "the commit message is empty" };
  if (MERGE_PATTERN.test(subject) || SUBJECT_PATTERN.test(subject)) return { ok: true, subject };
  return {
    ok: false,
    subject,
    reason: "the subject does not follow Conventional Commits",
  };
}

/**
 * @param {readonly string[]} argv
 * @returns {number} the exit code
 */
export function main(argv) {
  const file = argv[0];
  if (argv.length !== 1 || file === undefined) {
    console.error("usage: node scripts/hooks/commit-msg.mjs <commit message file>");
    return 2;
  }
  /** @type {string} */
  let message;
  try {
    message = readFileSync(file, "utf8");
  } catch {
    console.error(`commit-msg: cannot read ${file}`);
    return 2;
  }
  const result = checkCommitMessage(message);
  if (result.ok) return 0;
  console.error(
    [
      `commit-msg (rules.yaml GIT-001): ${result.reason}.`,
      `  subject:  ${result.subject === "" ? "(none)" : result.subject}`,
      "  expected: type(scope)!: subject    the scope and the ! are optional",
      `  types:    ${COMMIT_TYPES.join(", ")}`,
      "  examples: feat(runner): add the scope-escape probe",
      "            fix!: reject scenarios without a primary key",
    ].join("\n"),
  );
  return 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
