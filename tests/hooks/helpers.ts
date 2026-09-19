/**
 * Shared helpers for the hook suites: run a hook script the way Claude Code does (JSON payload on
 * stdin, exit code and stderr as the answer) and keep scratch files out of everybody's way.
 *
 * Scratch files live inside the repository, because ESLint and Prettier decide by location, in a
 * directory that ignores itself through its own `.gitignore`. Git, and with it the full rules
 * check that another suite runs against this repository at the same time, never sees them.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PRE_EDIT = path.join(REPO_ROOT, "scripts/hooks/pre-edit.sh");
export const POST_EDIT = path.join(REPO_ROOT, "scripts/hooks/post-edit.sh");

/** Joins fragments at run time, so that this directory never contains a rule violation itself. */
export const glue = (...parts: string[]): string => parts.join("");

export interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * @param script absolute path of the hook script
 * @param payload the hook payload; a string is sent as it is, anything else as JSON
 * @param cwd the directory the hook is started in; the hooks must not depend on it
 */
export function runHook(script: string, payload: unknown, cwd: string = REPO_ROOT): HookResult {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const result = spawnSync("sh", [script], { cwd, input, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A PreToolUse payload as Claude Code sends it for Write. */
export const writePayload = (filePath: string, extra: Record<string, unknown> = {}) => ({
  session_id: "test",
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: filePath, content: "x" },
  ...extra,
});

/** A PostToolUse payload as Claude Code sends it for Write. */
export const wrotePayload = (filePath: string) => ({
  session_id: "test",
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: filePath, content: "x" },
  tool_response: { filePath, type: "create" },
});

export interface Scratch {
  dir: string;
  /** Writes a file below the scratch directory and returns its absolute path. */
  write: (relativePath: string, content: string) => string;
  remove: () => void;
}

/**
 * A scratch directory below `parent` (relative to the repository root) that git ignores.
 */
export function createScratch(parent: string): Scratch {
  const base = path.join(REPO_ROOT, parent);
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, ".scratch-"));
  writeFileSync(path.join(dir, ".gitignore"), "*\n");
  return {
    dir,
    write(relativePath, content) {
      const file = path.join(dir, relativePath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
