/**
 * scripts/hooks/pre-edit.sh and scripts/hooks/post-edit.sh as processes, driven with the payloads
 * Claude Code sends. The contract under test: exit 0 lets the call through in silence, exit 2
 * blocks it (pre) or reports back to the agent (post), and the message is on stderr.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createScratch,
  glue,
  POST_EDIT,
  PRE_EDIT,
  REPO_ROOT,
  runHook,
  writePayload,
  wrotePayload,
  type Scratch,
} from "./helpers";

const HOOK_TIMEOUT_MS = 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

// One test writes below build/, which exists in no fresh checkout. The suite leaves the
// repository root the way it found it; an empty, git-ignored directory is invisible to git.
const BUILD_DIR = path.join(REPO_ROOT, "build");
const buildDirExistedBefore = existsSync(BUILD_DIR);
afterAll(() => {
  expect(existsSync(BUILD_DIR), "the suite must not leave build/ behind").toBe(
    buildDirExistedBefore,
  );
});

function scratch(parent = "tests/hooks"): Scratch {
  const created = createScratch(parent);
  cleanups.push(created.remove);
  return created;
}

/**
 * Registers the removal of a directory below the repository root that a test is about to create.
 * A directory that was there before the test is left alone, and so is one that holds anything
 * else by then: `rmdirSync` refuses a directory that is not empty.
 */
function removeIfCreatedAndEmpty(relativeDir: string): void {
  const dir = path.join(REPO_ROOT, relativeDir);
  if (existsSync(dir)) return;
  cleanups.push(() => {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty (somebody else uses it) or already gone: not ours to delete.
    }
  });
}

function outsideDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rls-hooks-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("scripts/hooks/pre-edit.sh", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.sonar",
    ".env.production",
    ".env.development.local",
    ".ENV.Local",
    "apps/web/.env.local",
  ])("blocks the real environment file %s", (name) => {
    const file = path.join(REPO_ROOT, name);
    const { status, stderr, stdout } = runHook(PRE_EDIT, writePayload(file));
    expect(status).toBe(2);
    expect(stderr).toContain("BLOCKED");
    expect(stderr).toContain("SEC-003");
    expect(stderr).toContain(file);
    expect(stderr).toContain(".env.example");
    expect(stdout).toBe("");
  });

  it("blocks a hand edit of package-lock.json and says what to do instead", () => {
    const payload = {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(REPO_ROOT, "package-lock.json"),
        old_string: "a",
        new_string: "b",
      },
    };
    const { status, stderr } = runHook(PRE_EDIT, payload);
    expect(status).toBe(2);
    expect(stderr).toContain("written by npm, never by hand");
    expect(stderr).toContain("npm install");
  });

  it("sees the path of NotebookEdit, of a list of edits and of a relative path", () => {
    const notebook = { tool_name: "NotebookEdit", tool_input: { notebook_path: "/work/.env" } };
    expect(runHook(PRE_EDIT, notebook).status).toBe(2);

    const edits = {
      tool_name: "MultiEdit",
      tool_input: { edits: [{ file_path: "/work/ok.ts" }, { file_path: "/work/.env.sonar" }] },
    };
    expect(runHook(PRE_EDIT, edits).status).toBe(2);

    const relative = writePayload("../.env.local", { cwd: path.join(REPO_ROOT, "src") });
    const result = runHook(PRE_EDIT, relative);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(path.join(REPO_ROOT, ".env.local"));
  });

  it("blocks a symbolic link that points at an environment file that does not exist yet", () => {
    const { dir } = scratch();
    const link = path.join(dir, "notes.txt");
    symlinkSync(".env.local", link);
    const { status, stderr } = runHook(PRE_EDIT, writePayload(link));
    expect(status).toBe(2);
    expect(stderr).toContain(path.join(dir, ".env.local"));
  });

  it.each([".env.example", "src/app/page.tsx", "package.json", "docs/env.md", "src/lib/env.ts"])(
    "lets %s through in silence",
    (name) => {
      const result = runHook(PRE_EDIT, writePayload(path.join(REPO_ROOT, name)));
      expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    },
  );

  it("lets a payload without a path through and does not depend on the working directory", () => {
    const payload = { tool_name: "Write", tool_input: {} };
    expect(runHook(PRE_EDIT, payload, outsideDir()).status).toBe(0);
    const blocked = runHook(PRE_EDIT, writePayload("/work/.env"), outsideDir());
    expect(blocked.status).toBe(2);
  });

  it.each(["", "not json", "[]", '"text"'])("blocks when the payload is %j", (payload) => {
    const { status, stderr } = runHook(PRE_EDIT, payload);
    expect(status).toBe(2);
    expect(stderr).toContain("could not be read");
  });

  it("blocks a path with a line break instead of guessing", () => {
    const { status, stderr } = runHook(PRE_EDIT, writePayload("/work/a\n.env"));
    expect(status).toBe(2);
    expect(stderr).toContain("line break");
  });
});

describe("scripts/hooks/post-edit.sh", () => {
  it(
    "formats the edited file and stays silent when it is fine",
    () => {
      const file = scratch().write("format-me.ts", "export   const answer   =  {a:1,\n  b:2}\n");
      const result = runHook(POST_EDIT, wrotePayload(file));
      expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(readFileSync(file, "utf8")).toBe("export const answer = { a: 1, b: 2 };\n");
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "reports an ESLint error of the edited file on stderr with exit code 2",
    () => {
      const content = `export const props = { ${glue("dangerously", "SetInnerHTML")}: { __html: "x" } };\n`;
      const file = scratch().write("lint-error.ts", content);
      const { status, stderr, stdout } = runHook(POST_EDIT, wrotePayload(file));
      expect(status).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("eslint");
      expect(stderr).toContain("SEC-001");
      expect(stderr).toContain("lint-error.ts");
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "reports an ESLint warning too, because the lint gate runs with --max-warnings 0",
    () => {
      const content = "const unused = 1;\nexport const used = 2;\n";
      const file = scratch().write("lint-warning.ts", content);
      const { status, stderr } = runHook(POST_EDIT, wrotePayload(file));
      expect(status).toBe(2);
      expect(stderr).toContain("lint-warning.ts");
      expect(stderr).toMatch(/warning\s+'unused' is assigned a value but never used/);
      expect(stderr).toMatch(/ESLint found too many warnings \(maximum: 0\)/);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "reports a rules.yaml violation of the edited file with its rule id",
    () => {
      const content = `${glue("// @ts-", "ignore")}\nexport const value: number = 1;\n`;
      const file = scratch().write("rules-violation.ts", content);
      const { status, stderr } = runHook(POST_EDIT, wrotePayload(file));
      expect(status).toBe(2);
      expect(stderr).toContain("rules check");
      expect(stderr).toMatch(/QUAL-001 tests\/hooks\/\.scratch-[^/]+\/rules-violation\.ts:1 /);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "reports a file that cannot be parsed",
    () => {
      const file = scratch().write("syntax.ts", "export const = ;\n");
      const { status, stderr } = runHook(POST_EDIT, wrotePayload(file));
      expect(status).toBe(2);
      expect(stderr).toContain("prettier could not format");
      expect(stderr).toContain("SyntaxError");
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "formats a non-source file without linting it and leaves unknown file types alone",
    () => {
      const created = scratch();
      const markdown = created.write("notes.md", "# Title\n\n\n\ntext\n");
      expect(runHook(POST_EDIT, wrotePayload(markdown))).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
      expect(readFileSync(markdown, "utf8")).toBe("# Title\n\ntext\n");

      const unknown = created.write("data.bin", "a  =  1\n\n\n");
      expect(runHook(POST_EDIT, wrotePayload(unknown)).status).toBe(0);
      expect(readFileSync(unknown, "utf8")).toBe("a  =  1\n\n\n");
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "does not fail on a file that ESLint and Prettier ignore",
    () => {
      // build/ is ignored by git, by Prettier (through .gitignore) and by eslint.config.mjs.
      const content = `export   const props = { ${glue("dangerously", "SetInnerHTML")}: 1 }\n`;
      // Registered before the scratch directory, because the cleanups run last in, first out:
      // build/ can only be removed once the scratch directory inside it is gone.
      removeIfCreatedAndEmpty("build");
      const file = scratch("build").write("ignored.ts", content);
      expect(runHook(POST_EDIT, wrotePayload(file))).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(readFileSync(file, "utf8")).toBe(content);
    },
    HOOK_TIMEOUT_MS,
  );

  it("ignores a deleted file, a directory, a file outside the repository and a bad payload", () => {
    const gone = path.join(REPO_ROOT, "tests/hooks/never-existed.ts");
    expect(runHook(POST_EDIT, wrotePayload(gone)).status).toBe(0);
    expect(runHook(POST_EDIT, wrotePayload(path.join(REPO_ROOT, "src"))).status).toBe(0);

    const outside = path.join(outsideDir(), "outside.ts");
    writeFileSync(outside, "export   const x=1\n");
    expect(runHook(POST_EDIT, wrotePayload(outside))).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(outside, "utf8")).toBe("export   const x=1\n");

    expect(runHook(POST_EDIT, "not json").status).toBe(0);
    expect(runHook(POST_EDIT, { tool_name: "Write", tool_input: {} }).status).toBe(0);
  });

  describe("in a checkout whose rules.yaml is broken", () => {
    // The hook finds its repository from its own location, so a copy of scripts/ is a checkout.
    let root = "";
    let hook = "";
    beforeAll(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), "rls-hooks-checkout-")));
      mkdirSync(path.join(root, "scripts"));
      for (const entry of ["hooks", "rules-check", "rules-check.mjs"]) {
        cpSync(path.join(REPO_ROOT, "scripts", entry), path.join(root, "scripts", entry), {
          recursive: true,
        });
      }
      symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
      writeFileSync(path.join(root, "rules.yaml"), "version: 1\n");
      hook = path.join(root, "scripts/hooks/post-edit.sh");
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it(
      "does not blame an unrelated file for it",
      () => {
        const notes = path.join(root, "notes.md");
        writeFileSync(notes, "# Notes\n");
        expect(runHook(hook, wrotePayload(notes))).toEqual({ status: 0, stdout: "", stderr: "" });
      },
      HOOK_TIMEOUT_MS,
    );

    it(
      "reports it when rules.yaml is the edited file",
      () => {
        const { status, stderr } = runHook(hook, wrotePayload(path.join(root, "rules.yaml")));
        expect(status).toBe(2);
        expect(stderr).toMatch(/^RULES-SCHEMA rules\.yaml:\d+ /m);
      },
      HOOK_TIMEOUT_MS,
    );
  });
});
