/**
 * scripts/hooks/commit-msg.mjs: the check itself, and the script as git runs it, with the path of
 * a message file as its only argument. No commit is ever created here.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  checkCommitMessage,
  COMMIT_TYPES,
  SUBJECT_PATTERN,
  subjectOf,
} from "../../scripts/hooks/commit-msg.mjs";
import { REPO_ROOT } from "./helpers";

const SCRIPT = path.join(REPO_ROOT, "scripts/hooks/commit-msg.mjs");

const GOOD = [
  "feat: add the matrix runner",
  "fix(runner): roll the probe back after an error",
  "feat!: drop the legacy scenario format",
  "refactor(lib/engine)!: split the worker client",
  "chore(deps-dev): bump vitest",
  "docs(adr): record the CSP decision",
  "build(next.config): switch off scope hoisting",
  "revert: feat: add the matrix runner",
  "test: cover the WITH CHECK escape\n\nA body line.\n\nRefs: #12",
  "# a comment git leaves in the editor\n\nci: cache npm\n# another comment",
  "perf: reuse the worker\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x",
  "Merge branch 'feature' into main",
  "Merge pull request #7 from someone/feature",
  "style: format",
];

const BAD = [
  "",
  "\n\n",
  "# only a comment",
  "add the matrix runner",
  "Feat: add the matrix runner",
  "feature: add the matrix runner",
  "feat:add the matrix runner",
  "feat:  ",
  "feat: ",
  "feat (runner): add it",
  "feat(): add it",
  "feat(runner: add it",
  "feat(run ner): add it",
  "wip",
  'Revert "feat: add the matrix runner"',
  "fixup! feat: add the matrix runner",
  "merge: something",
  "# ------------------------ >8 ------------------------\nfeat: below the scissors",
];

describe("checkCommitMessage", () => {
  it.each(GOOD)("accepts %j", (message) => {
    expect(checkCommitMessage(message).ok).toBe(true);
  });

  it.each(BAD)("rejects %j", (message) => {
    const result = checkCommitMessage(message);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("");
  });

  it("accepts every type of the brief and nothing else", () => {
    expect(COMMIT_TYPES).toEqual([
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
    ]);
    for (const type of COMMIT_TYPES) expect(checkCommitMessage(`${type}: x`).ok).toBe(true);
  });

  it("reads the subject from the first line that is neither empty nor a comment", () => {
    expect(subjectOf("\n# comment\n\nfix: the subject  \n\nbody\n")).toBe("fix: the subject");
    expect(subjectOf("# comment\r\nfix: crlf\r\n")).toBe("fix: crlf");
    expect(subjectOf("")).toBe("");
  });
});

describe("scripts/hooks/commit-msg.mjs as a process", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rls-commit-msg-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(message: string | null) {
    const args = [SCRIPT];
    if (message !== null) {
      const file = path.join(dir, `msg-${Math.random().toString(36).slice(2)}`);
      writeFileSync(file, message);
      args.push(file);
    }
    const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("exits 0 in silence for a conventional message", () => {
    expect(run("feat(lab): show the leaking rows\n")).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(run("Merge branch 'main' of example\n").status).toBe(0);
  });

  it("exits 1 and explains the expected shape for anything else", () => {
    const { status, stderr } = run("Added some stuff\n");
    expect(status).toBe(1);
    expect(stderr).toContain("GIT-001");
    expect(stderr).toContain("Added some stuff");
    expect(stderr).toContain("type(scope)!: subject");
    expect(stderr).toContain(COMMIT_TYPES.join(", "));
  });

  it("exits 2 without a message file", () => {
    expect(run(null).status).toBe(2);
    const missing = spawnSync(process.execPath, [SCRIPT, path.join(dir, "missing")], {
      encoding: "utf8",
    });
    expect(missing.status).toBe(2);
  });
});

describe("the git hooks and rules.yaml", () => {
  const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

  it(".husky/commit-msg hands the message file to the script", () => {
    expect(read(".husky/commit-msg")).toMatch(/^node scripts\/hooks\/commit-msg\.mjs "\$1"$/m);
  });

  it(".husky/pre-commit runs lint-staged, which formats, lints and runs the fast rules check", () => {
    expect(read(".husky/pre-commit")).toMatch(/^lint-staged$/m);
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      "lint-staged": Record<string, string[]>;
    };
    expect(pkg.scripts["prepare"]).toBe("node scripts/hooks/install-git-hooks.mjs");
    const tasks = Object.values(pkg["lint-staged"]);
    expect(tasks.length).toBeGreaterThan(0);
    for (const commands of tasks) {
      expect(commands[0]).toMatch(/^prettier --write/);
      expect(commands.at(-1)).toBe("node scripts/rules-check.mjs --");
    }
    const source = Object.entries(pkg["lint-staged"]).find(([glob]) => glob.startsWith("*."));
    // A warning fails the commit as it fails `npm run lint` (QUAL-002).
    expect(source?.[1]).toContain("eslint --fix --max-warnings 0 --no-warn-ignored");
    expect(pkg.scripts["lint"]).toBe("eslint --max-warnings 0");
  });

  it("GIT-001 in rules.yaml quotes the pattern the script enforces", () => {
    const rules = parse(read("rules.yaml")) as { rules: { id: string; check?: string }[] };
    const check = rules.rules.find((rule) => rule.id === "GIT-001")?.check ?? "";
    expect(check).toContain(`/${SUBJECT_PATTERN.source}/`);
    expect(check).toContain("scripts/hooks/commit-msg.mjs");
  });
});
