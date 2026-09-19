#!/usr/bin/env node
/**
 * The rules check: validates rules.yaml and executes every rule it marks as enforced by this
 * script.
 *
 *   node scripts/rules-check.mjs                  full mode, the whole repository (npm run rules)
 *   node scripts/rules-check.mjs <file> [...]     fast mode, for hooks and lint-staged
 *   node scripts/rules-check.mjs --json [...]     machine-readable output
 *   node scripts/rules-check.mjs --root <dir>     check another checkout (used by the tests)
 *
 * Output: one line per violation, `RULE-ID path:line message`, then a summary line. Exit code 0
 * when clean, 1 on any violation, 2 on a usage error. Fast mode silently drops paths that do not
 * exist or lie outside the repository.
 *
 * The checks live in scripts/rules-check/ as pure functions and are tested in tests/rules-check/.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatResult, runRulesCheck } from "./rules-check/run.mjs";

const USAGE = "usage: node scripts/rules-check.mjs [--json] [--root <dir>] [--] [file ...]";

/**
 * @param {readonly string[]} argv
 * @returns {{ json: boolean, help: boolean, root: string | null, paths: string[], error: string | null }}
 */
export function parseArguments(argv) {
  const parsed = {
    json: false,
    help: false,
    root: /** @type {string | null} */ (null),
    paths: /** @type {string[]} */ ([]),
    error: /** @type {string | null} */ (null),
  };
  let onlyPaths = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (onlyPaths || !argument.startsWith("-")) {
      parsed.paths.push(argument);
    } else if (argument === "--") {
      onlyPaths = true;
    } else if (argument === "--json") {
      parsed.json = true;
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--root") {
      index += 1;
      parsed.root = argv[index] ?? null;
      if (parsed.root === null) parsed.error = "--root needs a directory";
    } else if (argument.startsWith("--root=")) {
      parsed.root = argument.slice("--root=".length);
    } else {
      parsed.error = `unknown option ${argument}`;
    }
  }
  return parsed;
}

/**
 * @param {readonly string[]} argv
 * @returns {number} the exit code
 */
export function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.error !== null) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // A file list, even an empty one after `--`, means fast mode; no arguments means full mode.
  const fast = parsed.paths.length > 0 || argv.includes("--");
  const result = runRulesCheck({
    root: parsed.root ?? repositoryRoot,
    paths: fast ? parsed.paths : null,
  });
  console.log(parsed.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return result.ok ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
