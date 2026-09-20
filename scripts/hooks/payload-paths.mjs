#!/usr/bin/env node
/**
 * Reads the JSON payload Claude Code sends to a PreToolUse or PostToolUse hook on stdin and prints
 * the file paths the tool call touches, one absolute path per line. The decisions live in
 * pre-edit.sh and post-edit.sh; this file only turns JSON into lines a shell can read.
 *
 *   node scripts/hooks/payload-paths.mjs --for-guard
 *       every path, plus what it resolves to and every target of a symbolic link on the way, so
 *       that a link to a protected file is seen under its real name even when the target does
 *       not exist yet
 *   node scripts/hooks/payload-paths.mjs --existing-files
 *       only paths that exist and are regular files, resolved, so that a deleted file or a
 *       directory is skipped
 *
 * Exit code 0 on success (no path at all is a success), 3 when stdin is not a JSON object, 4 when
 * a path contains a line break and therefore cannot be handed to a shell line by line, 64 on a
 * usage error.
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_BAD_PAYLOAD = 3;
export const EXIT_UNSAFE_PATH = 4;
export const EXIT_USAGE = 64;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What `tool_input` names as a path: the file, the notebook, and the file of every edit.
 * @param {unknown} input
 * @returns {unknown[]}
 */
function inputPaths(input) {
  if (!isRecord(input)) return [];
  const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
  return [
    input["file_path"],
    input["notebook_path"],
    ...edits.filter(isRecord).map((edit) => edit["file_path"]),
  ];
}

/**
 * The paths named by a tool call: Write, Edit and MultiEdit use `file_path`, NotebookEdit uses
 * `notebook_path`, a PostToolUse payload repeats the path as `tool_response.filePath`, and a list
 * of `edits` may carry a path per entry.
 * @param {Record<string, unknown>} payload
 * @returns {string[]} absolute paths, first occurrence first, without duplicates
 */
export function collectPaths(payload) {
  const base = typeof payload["cwd"] === "string" && payload["cwd"] !== "" ? payload["cwd"] : ".";
  const response = payload["tool_response"];
  const candidates = [
    ...inputPaths(payload["tool_input"]),
    isRecord(response) ? response["filePath"] : undefined,
  ];
  /** @type {Set<string>} */
  const unique = new Set();
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") {
      unique.add(path.resolve(base, candidate));
    }
  }
  return [...unique];
}

/**
 * @param {string} file
 * @returns {string | null} the resolved path, or null when nothing exists there
 */
function resolveExisting(file) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The targets of a symbolic link, hop by hop. Unlike realpath this also follows a link whose
 * target does not exist yet: writing through such a link would create the target.
 * @param {string} file
 * @returns {string[]}
 */
function linkTargets(file) {
  /** @type {string[]} */
  const targets = [];
  let current = file;
  for (let hop = 0; hop < 16; hop += 1) {
    try {
      if (!lstatSync(current).isSymbolicLink()) break;
      current = path.resolve(path.dirname(current), readlinkSync(current));
      targets.push(current);
    } catch {
      break;
    }
  }
  return targets;
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isRegularFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {"--for-guard" | "--existing-files"} mode
 * @param {readonly string[]} paths
 * @returns {string[]}
 */
export function selectPaths(mode, paths) {
  /** @type {Set<string>} */
  const selected = new Set();
  for (const file of paths) {
    const resolved = resolveExisting(file);
    if (mode === "--for-guard") {
      selected.add(file);
      for (const target of linkTargets(file)) selected.add(target);
      if (resolved !== null) selected.add(resolved);
    } else if (resolved !== null && isRegularFile(resolved)) {
      selected.add(resolved);
    }
  }
  return [...selected];
}

/**
 * @param {readonly string[]} argv
 * @param {string} stdin
 * @returns {{ code: number, lines: string[], error: string | null }}
 */
export function main(argv, stdin) {
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "--for-guard" && mode !== "--existing-files")) {
    return {
      code: EXIT_USAGE,
      lines: [],
      error: "usage: payload-paths.mjs --for-guard | --existing-files  (hook payload on stdin)",
    };
  }
  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    payload = null;
  }
  if (!isRecord(payload)) {
    return { code: EXIT_BAD_PAYLOAD, lines: [], error: "the hook payload is not a JSON object" };
  }
  const lines = selectPaths(mode, collectPaths(payload));
  if (lines.some((line) => /[\r\n]/.test(line))) {
    return { code: EXIT_UNSAFE_PATH, lines: [], error: "a file path contains a line break" };
  }
  return { code: 0, lines, error: null };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  const result = main(process.argv.slice(2), stdin);
  if (result.error !== null) console.error(`payload-paths: ${result.error}`);
  if (result.lines.length > 0) console.log(result.lines.join("\n"));
  process.exitCode = result.code;
}
