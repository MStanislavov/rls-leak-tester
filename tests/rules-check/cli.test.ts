/**
 * The script as a process: exit codes, the line format, --json, and the real repository.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureRepo, REPO_ROOT, SCRIPT, type FixtureRepo } from "./helpers";

const REAL_RULES = readFileSync(path.join(REPO_ROOT, "rules.yaml"), "utf8");

function run(args: string[], cwd: string = REPO_ROOT) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const repos: FixtureRepo[] = [];
function fixture(files: Record<string, string> = {}): FixtureRepo {
  const repo = createFixtureRepo(REAL_RULES, files);
  repos.push(repo);
  return repo;
}
afterEach(() => {
  while (repos.length > 0) repos.pop()?.remove();
});

describe("scripts/rules-check.mjs", () => {
  it("passes on this repository in full mode", () => {
    const { status, stdout } = run([]);
    expect(stdout).toMatch(/^rules-check \(full\): ok, 15 script rules, \d+ files, \d+ ms$/);
    expect(status).toBe(0);
  });

  it("passes on this repository's own rules.yaml and script in fast mode", () => {
    const { status, stdout } = run(["--json", "rules.yaml", "scripts/rules-check.mjs", "gone.ts"]);
    const result = JSON.parse(stdout) as { mode: string; ok: boolean; filesChecked: number };
    expect(result).toMatchObject({ mode: "fast", ok: true, filesChecked: 2 });
    expect(status).toBe(0);
  });

  it("prints RULE-ID path:line message and exits 1 on a violation", () => {
    const repo = fixture({ "src/components/cell.tsx": "el.innerHTML = value;\n" });
    const { status, stdout } = run(["--root", repo.root]);
    const output = stdout.split("\n");
    expect(output).toHaveLength(2);
    expect(output[0]).toMatch(/^SEC-001 src\/components\/cell\.tsx:1 \S.+$/);
    expect(output[1]).toMatch(/^rules-check \(full\): 1 violation, /);
    expect(status).toBe(1);
  });

  it("prints machine-readable output with --json", () => {
    const repo = fixture({ "src/components/cell.tsx": "el.innerHTML = value;\n" });
    const { status, stdout } = run([`--root=${repo.root}`, "--json"]);
    const result = JSON.parse(stdout) as {
      mode: string;
      ok: boolean;
      violations: { rule: string; path: string; line: number; message: string }[];
      rulesRun: string[];
    };
    expect(result.mode).toBe("full");
    expect(result.ok).toBe(false);
    expect(result.rulesRun).toHaveLength(15);
    expect(result.violations).toEqual([
      {
        rule: "SEC-001",
        path: "src/components/cell.tsx",
        line: 1,
        message: expect.stringContaining("forbidden") as string,
      },
    ]);
    expect(status).toBe(1);
  });

  it("runs in fast mode from another directory and ignores a path that does not exist", () => {
    const repo = fixture({ "src/components/cell.tsx": "el.innerHTML = value;\n" });
    const cwd = path.join(repo.root, "src");
    const clean = run(["--root", repo.root, "--", "does-not-exist.ts"], cwd);
    expect(clean.stdout).toMatch(/^rules-check \(fast\): ok, 15 script rules, 0 files, \d+ ms$/);
    expect(clean.status).toBe(0);

    const dirty = run(["--root", repo.root, "--", "components/cell.tsx", "does-not-exist.ts"], cwd);
    expect(dirty.stdout.split("\n")[0]).toMatch(/^SEC-001 src\/components\/cell\.tsx:1 /);
    expect(dirty.status).toBe(1);
  });

  it("treats an empty file list after -- as fast mode, the way lint-staged can call it", () => {
    const repo = fixture({ "src/components/cell.tsx": "el.innerHTML = value;\n" });
    const { status, stdout } = run(["--root", repo.root, "--"]);
    expect(stdout).toMatch(/^rules-check \(fast\): ok, /);
    expect(status).toBe(0);
  });

  it("exits 2 on a usage error and 0 on --help", () => {
    const unknown = run(["--fix"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown option --fix");
    expect(run(["--root"]).status).toBe(2);
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: node scripts/rules-check.mjs");
  });
});
