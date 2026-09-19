/**
 * The only part of the rules check that touches the disk and git. Everything it returns is a
 * repo-relative POSIX path or file text, which is what the pure checks work on.
 *
 * Two things are never done here: following a symbolic link, and reading a real environment file
 * (`.env`, `.env.local`, `.env.sonar`, …). Those are looked at by name only.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { isBinaryFile, isEnvFile } from "./checks.mjs";

/**
 * Directories at the repository root that the walk never enters: dependencies, git's own data and
 * generated output. Each one is listed in rules.yaml under exclusions (tool: rules-check), and
 * QUAL-001 fails when the two lists differ. `node_modules` is skipped at any depth.
 */
export const SKIP_DIRS = Object.freeze([
  ".git",
  "node_modules",
  ".next",
  "out",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".scannerwork",
]);

const MAX_FILE_BYTES = 2_000_000;

/**
 * @typedef {{ tracked: () => string[] | null, unignored: () => string[] | null }} GitInfo
 */

/** @param {string} value */
const toPosix = (value) => value.split(path.sep).join("/");

/**
 * @param {string} relativePath
 */
export function isSkipped(relativePath) {
  const segments = relativePath.split("/");
  return SKIP_DIRS.includes(segments[0] ?? "") || segments.includes("node_modules");
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {string[] | null} null when git is missing or `root` is not inside a work tree
 */
function gitList(root, args) {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "-z", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\0").filter((entry) => entry !== "");
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {GitInfo}
 */
export function createGitInfo(root) {
  return {
    tracked: () => gitList(root, ["--cached"]),
    unignored: () => gitList(root, ["--cached", "--others", "--exclude-standard"]),
  };
}

/**
 * Which of `paths` git tracks or has staged. Used by fast mode for environment file names.
 * @param {string} root
 * @param {string[]} paths repo-relative
 */
export function gitTrackedAmong(root, paths) {
  return paths.length === 0 ? [] : (gitList(root, ["--cached", "--", ...paths]) ?? []);
}

/**
 * A read-only view of the working tree.
 * @param {string} root absolute path of the repository
 * @param {{ keep?: ReadonlySet<string> | null }} [options] `keep`: the paths git does not ignore
 * @returns {import("./checks.mjs").RepoView}
 */
export function createRepoView(root, options = {}) {
  const keep = options.keep ?? null;
  /** @type {Map<string, string | null>} */
  const contents = new Map();
  /** @type {Map<string, string[]>} */
  const listings = new Map();

  /** @param {string} relativePath */
  const isFile = (relativePath) => {
    try {
      return statSync(path.join(root, relativePath)).isFile();
    } catch {
      return false;
    }
  };

  /**
   * @param {string} dir repo-relative, "" for the root
   * @param {string[]} found
   */
  const walk = (dir, found) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isSymbolicLink() || isSkipped(relativePath)) continue;
      if (entry.isDirectory()) {
        walk(relativePath, found);
      } else if (entry.isFile() && (keep === null || keep.has(relativePath))) {
        found.push(relativePath);
      }
    }
  };

  return {
    exists: (relativePath) => !isSkipped(relativePath) && isFile(relativePath),
    read(relativePath) {
      if (isEnvFile(relativePath) || isBinaryFile(relativePath) || isSkipped(relativePath)) {
        return null;
      }
      if (!contents.has(relativePath)) {
        /** @type {string | null} */
        let text = null;
        try {
          const absolute = path.join(root, relativePath);
          if (statSync(absolute).size <= MAX_FILE_BYTES) text = readFileSync(absolute, "utf8");
        } catch {
          text = null;
        }
        // A NUL byte means a binary file with an unknown extension.
        contents.set(relativePath, text !== null && text.includes("\0") ? null : text);
      }
      return contents.get(relativePath) ?? null;
    },
    list(dir) {
      const key = dir.replace(/\/+$/, "");
      let found = listings.get(key);
      if (found === undefined) {
        found = [];
        if (!isSkipped(key)) walk(key, found);
        found.sort();
        listings.set(key, found);
      }
      return found;
    },
  };
}

/**
 * Turns command-line paths into repo-relative ones. Paths that do not exist, are not files, lie
 * outside the repository or inside a skipped directory are dropped without a word: a hook passes
 * whatever was just edited or staged, including deleted files.
 * @param {string} root
 * @param {readonly string[]} inputs absolute, or relative to `cwd`
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function normalizeInputPaths(root, inputs, cwd = process.cwd()) {
  /** @type {Set<string>} */
  const result = new Set();
  for (const input of inputs) {
    let real;
    try {
      // Resolving links on both sides keeps /var and /private/var (macOS) from looking different,
      // and sends a link that points out of the repository where it belongs: outside.
      real = realpathSync(path.resolve(cwd, input));
      if (!statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    const relativePath = toPosix(path.relative(root, real));
    if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      continue;
    }
    if (!isSkipped(relativePath)) result.add(relativePath);
  }
  return [...result].sort();
}

/**
 * The canonical absolute path of the repository root.
 * @param {string} root
 */
export function resolveRoot(root) {
  return realpathSync(path.resolve(root));
}
