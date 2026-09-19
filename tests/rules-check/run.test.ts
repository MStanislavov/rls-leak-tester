/**
 * The runner against small checkouts in a temporary directory: full mode, fast mode, the link
 * between rules.yaml and the checks, and what is never read.
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { IMPLEMENTED_RULES } from "../../scripts/rules-check/checks.mjs";
import { createRepoView, isSkipped, normalizeInputPaths } from "../../scripts/rules-check/repo.mjs";
import { formatResult, runRulesCheck } from "../../scripts/rules-check/run.mjs";

import {
  createFixtureRepo,
  fixtureRules,
  glue,
  lines,
  NO_GIT,
  REPO_ROOT,
  summarize,
  type FixtureRepo,
} from "./helpers";

const REAL_RULES = readFileSync(path.join(REPO_ROOT, "rules.yaml"), "utf8");
const KEY_SHAPED = glue("sk", "-ant-", "api03-", "Ab1".repeat(10));
const UNPARSED_ROUTE = lines(
  "export async function POST(request: Request) {",
  "  return Response.json(await request.json());",
  "}",
);

const repos: FixtureRepo[] = [];
function fixture(files: Record<string, string> = {}): FixtureRepo {
  const repo = createFixtureRepo(REAL_RULES, files);
  repos.push(repo);
  return repo;
}
afterEach(() => {
  while (repos.length > 0) repos.pop()?.remove();
});

interface RuleEntry {
  id: string;
  enforced_by: string | string[];
}
/** The fixture rules.yaml with its rule list changed. */
function rulesWith(mutate: (rules: RuleEntry[]) => void): string {
  const document = fixtureRules(REAL_RULES);
  mutate(document.rules as RuleEntry[]);
  return stringify(document);
}

describe("full mode", () => {
  it("passes a healthy checkout and runs every script rule", () => {
    const result = runRulesCheck({ root: fixture().root, git: NO_GIT });
    expect(result.violations).toEqual([]);
    expect(result).toMatchObject({ mode: "full", ok: true, rulesRun: IMPLEMENTED_RULES });
    expect(result.filesChecked).toBeGreaterThanOrEqual(5);
  });

  it("finds violations across the tree, sorted by path and line", () => {
    const repo = fixture({
      "src/app/api/explain/route.ts": UNPARSED_ROUTE,
      "src/components/cell.tsx":
        "export const C = () => <i dangerouslySetInnerHTML={{ __html: x }} />;\n",
      "docs/notes.md": `token: ${KEY_SHAPED}\n`,
      "tsconfig.json": '{ "compilerOptions": { "strict": false } }\n',
    });
    const result = runRulesCheck({ root: repo.root, git: NO_GIT });
    expect(result.ok).toBe(false);
    expect(summarize(result.violations)).toEqual([
      "SEC-003 docs/notes.md:1",
      "SEC-002 src/app/api/explain/route.ts:2",
      "SEC-001 src/components/cell.tsx:1",
      "CODE-003 tsconfig.json:1",
    ]);
  });

  it("starts to bite when the guarded code appears", () => {
    const repo = fixture();
    expect(runRulesCheck({ root: repo.root, git: NO_GIT }).ok).toBe(true);
    repo.write("src/lib/runner/run.ts", "export const run = () => [];\n");
    repo.write("src/lib/redis/ports.ts", "export interface Cache {}\n");
    repo.write("src/lib/ai/prompt.ts", "export const PROMPT = 'explain';\n");
    expect(summarize(runRulesCheck({ root: repo.root, git: NO_GIT }).violations)).toEqual([
      "AI-001 src/lib/ai/model.ts:1",
      "REDIS-001 src/lib/redis/keys.ts:1",
      "RUN-001 src/lib/runner:1",
    ]);
  });

  it("skips dependencies and generated output, and never follows a link", () => {
    const repo = fixture({
      "node_modules/pkg/index.js": `const k = "${KEY_SHAPED}";\n`,
      "packages/app/node_modules/pkg/index.js": `const k = "${KEY_SHAPED}";\n`,
      ".next/server/chunk.js": `const k = "${KEY_SHAPED}";\n`,
      "coverage/lcov.info": KEY_SHAPED,
    });
    const outside = fixture({ "leak.md": KEY_SHAPED });
    symlinkSync(outside.root, path.join(repo.root, "linked"));
    expect(runRulesCheck({ root: repo.root, git: NO_GIT }).violations).toEqual([]);
    expect(isSkipped("node_modules/x")).toBe(true);
    expect(isSkipped("src/build/x.ts")).toBe(false);
  });

  it("leaves out what git ignores", () => {
    const repo = fixture({ "scratch/notes.md": KEY_SHAPED, "docs/kept.md": "fine\n" });
    const unfiltered = runRulesCheck({ root: repo.root, git: NO_GIT });
    expect(summarize(unfiltered.violations)).toEqual(["SEC-003 scratch/notes.md:1"]);
    const git = { ...NO_GIT, unignored: () => ["docs/kept.md", "rules.yaml"] };
    expect(runRulesCheck({ root: repo.root, git }).violations).toEqual([]);
  });

  it("never reads a real environment file and fails one that git tracks", () => {
    const repo = fixture({ ".env.local": `ANTHROPIC_API_KEY=${KEY_SHAPED}\n` });
    expect(createRepoView(repo.root).read(".env.local")).toBeNull();
    expect(runRulesCheck({ root: repo.root, git: NO_GIT }).violations).toEqual([]);

    const git = { ...NO_GIT, tracked: () => [".env.example", ".env.local", "rules.yaml"] };
    const result = runRulesCheck({ root: repo.root, git });
    expect(summarize(result.violations)).toEqual(["SEC-003 .env.local:1"]);
    expect(JSON.stringify(result)).not.toContain(KEY_SHAPED);
  });

  it("reports an unlisted ESLint ignore through the whole pipeline", () => {
    const config = 'export default [{ ignores: ["src/legacy/**"] }];\n';
    const result = runRulesCheck({
      root: fixture({ "eslint.config.mjs": config }).root,
      git: NO_GIT,
    });
    expect(summarize(result.violations)).toEqual([
      "QUAL-001 eslint.config.mjs:1",
      expect.stringMatching(/^QUAL-001 rules\.yaml:\d+$/),
      expect.stringMatching(/^QUAL-001 rules\.yaml:\d+$/),
    ]);
  });
});

describe("rules.yaml drives the run", () => {
  it("fails when rules.yaml is missing, and still runs every check", () => {
    const repo = fixture({ "src/components/cell.tsx": "el.innerHTML = value;\n" });
    rmSync(path.join(repo.root, "rules.yaml"));
    const missing = runRulesCheck({ root: repo.root, git: NO_GIT });
    expect(missing.rulesRun).toEqual(IMPLEMENTED_RULES);
    expect(missing.violations.map((violation) => violation.message)).toContain(
      "rules.yaml is missing: it is the source of truth for every rule",
    );
    expect(missing.violations.map((violation) => violation.rule)).toContain("SEC-001");

    repo.write("rules.yaml", "");
    const empty = runRulesCheck({ root: repo.root, git: NO_GIT });
    expect(empty.rulesRun).toEqual(IMPLEMENTED_RULES);
    expect(empty.violations.map((violation) => violation.rule)).toContain("RULES-SCHEMA");
    expect(empty.violations.map((violation) => violation.rule)).toContain("SEC-001");
  });

  it("reports schema problems next to rule violations", () => {
    const broken = rulesWith((rules) => {
      const first = rules[0];
      if (first) Reflect.deleteProperty(first, "enforced_by");
    });
    const repo = fixture({ "rules.yaml": broken, "docs/notes.md": KEY_SHAPED });
    const result = runRulesCheck({ root: repo.root, git: NO_GIT });
    expect(summarize(result.violations)).toEqual([
      "SEC-003 docs/notes.md:1",
      expect.stringMatching(/^RULES-SCHEMA rules\.yaml:\d+$/),
    ]);
  });

  it("refuses to switch a check off by unmarking its rule", () => {
    const unmarked = rulesWith((rules) => {
      const rule = rules.find((entry) => entry.id === "SEC-001");
      if (rule) rule.enforced_by = ["eslint"];
    });
    const result = runRulesCheck({ root: fixture({ "rules.yaml": unmarked }).root, git: NO_GIT });
    expect(result.rulesRun).not.toContain("SEC-001");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe("RULES-SCHEMA");
    expect(result.violations[0]?.message).toContain("the script implements SEC-001");
  });

  it("fails a rule marked for the script that the script does not implement", () => {
    const overclaimed = rulesWith((rules) => {
      const rule = rules.find((entry) => entry.id === "DOCS-001");
      if (rule) rule.enforced_by = ["review", "script:scripts/rules-check.mjs"];
    });
    const result = runRulesCheck({
      root: fixture({ "rules.yaml": overclaimed }).root,
      git: NO_GIT,
    });
    expect(result.violations.map((violation) => violation.message)).toEqual([
      "DOCS-001 is marked script:scripts/rules-check.mjs but the script has no check for it",
    ]);
  });

  it("fails a rule enforced by a script that does not exist", () => {
    const dangling = rulesWith((rules) => {
      const rule = rules.find((entry) => entry.id === "GIT-001");
      if (rule) rule.enforced_by = ["hook", "script:scripts/hooks/commit-msg.sh"];
    });
    const result = runRulesCheck({ root: fixture({ "rules.yaml": dangling }).root, git: NO_GIT });
    expect(result.violations.map((violation) => violation.message)).toEqual([
      "GIT-001 is enforced by scripts/hooks/commit-msg.sh, which does not exist",
    ]);
  });

  it("takes the route limit and the coverage minimum from the thresholds", () => {
    const document = fixtureRules(REAL_RULES) as {
      thresholds: { architecture: Record<string, number>; coverage: Record<string, number> };
    };
    document.thresholds.architecture.route_handler_max_lines = 10;
    document.thresholds.coverage.lines_min_percent = 90;
    const route = lines(
      ...Array.from({ length: 11 }, () => "export const dynamic = 'force-dynamic';"),
    );
    const repo = fixture({
      "rules.yaml": stringify(document),
      "src/app/api/health/route.ts": route,
    });
    expect(summarize(runRulesCheck({ root: repo.root, git: NO_GIT }).violations)).toEqual([
      "ARCH-003 src/app/api/health/route.ts:11",
      "TEST-002 vitest.config.mts:10",
    ]);
    expect(parse(REAL_RULES)).toHaveProperty("thresholds.architecture.route_handler_max_lines", 80);
  });
});

describe("fast mode", () => {
  it("checks only the given files", () => {
    const repo = fixture({
      "src/components/cell.tsx": "el.innerHTML = value;\n",
      "src/components/other.tsx": "el.outerHTML = value;\n",
    });
    const result = runRulesCheck({
      root: repo.root,
      paths: [path.join(repo.root, "src/components/cell.tsx")],
      git: NO_GIT,
    });
    expect(result.mode).toBe("fast");
    expect(result.filesChecked).toBe(1);
    expect(summarize(result.violations)).toEqual(["SEC-001 src/components/cell.tsx:1"]);
  });

  it("ignores paths that do not exist, directories, and paths outside the repository", () => {
    const repo = fixture({ "src/lib/utils.ts": "export const one = 1;\n" });
    const outside = fixture({ "leak.md": KEY_SHAPED });
    mkdirSync(path.join(repo.root, "src/empty"));
    symlinkSync(path.join(outside.root, "leak.md"), path.join(repo.root, "link.md"));
    const inputs = [
      "src/lib/does-not-exist.ts",
      "src/empty",
      path.join(outside.root, "leak.md"),
      "../../etc/hosts",
      "link.md",
      "node_modules/pkg/index.js",
      "src/lib/utils.ts",
      "./src/lib/utils.ts",
    ];
    expect(normalizeInputPaths(repo.root, inputs, repo.root)).toEqual(["src/lib/utils.ts"]);
    const result = runRulesCheck({ root: repo.root, paths: inputs, cwd: repo.root, git: NO_GIT });
    expect(result).toMatchObject({ mode: "fast", ok: true, filesChecked: 1 });

    const nothing = runRulesCheck({
      root: repo.root,
      paths: ["gone.ts"],
      cwd: repo.root,
      git: NO_GIT,
    });
    expect(nothing).toMatchObject({ mode: "fast", ok: true, filesChecked: 0 });
  });

  it("resolves relative paths against the caller's directory", () => {
    const repo = fixture({ "src/components/cell.tsx": "el.innerHTML = value;\n" });
    const result = runRulesCheck({
      root: repo.root,
      paths: ["cell.tsx"],
      cwd: path.join(repo.root, "src/components"),
      git: NO_GIT,
    });
    expect(summarize(result.violations)).toEqual(["SEC-001 src/components/cell.tsx:1"]);
  });

  it("runs a repository check only when a given path triggers it", () => {
    const repo = fixture({ "src/lib/runner/run.ts": "export const run = () => [];\n" });
    const unrelated = runRulesCheck({
      root: repo.root,
      paths: ["tsconfig.json"],
      cwd: repo.root,
      git: NO_GIT,
    });
    expect(unrelated.violations).toEqual([]);
    const related = runRulesCheck({
      root: repo.root,
      paths: ["src/lib/runner/run.ts"],
      cwd: repo.root,
      git: NO_GIT,
    });
    expect(summarize(related.violations)).toEqual(["RUN-001 src/lib/runner:1"]);
  });

  it("always validates rules.yaml, because every hook run depends on it", () => {
    const repo = fixture({
      "rules.yaml": "version: 1\n",
      "src/lib/utils.ts": "export const one = 1;\n",
    });
    const result = runRulesCheck({
      root: repo.root,
      paths: ["src/lib/utils.ts"],
      cwd: repo.root,
      git: NO_GIT,
    });
    expect(result.ok).toBe(false);
    expect(new Set(result.violations.map((violation) => violation.rule))).toEqual(
      new Set(["RULES-SCHEMA"]),
    );
  });

  it("fails a staged environment file by name without reading it", () => {
    const repo = fixture({ ".env.local": `ANTHROPIC_API_KEY=${KEY_SHAPED}\n` });
    const untracked = runRulesCheck({
      root: repo.root,
      paths: [".env.local"],
      cwd: repo.root,
      git: NO_GIT,
    });
    expect(untracked).toMatchObject({ ok: true, filesChecked: 0 });
    const git = { ...NO_GIT, trackedAmong: (paths: string[]) => paths };
    const staged = runRulesCheck({ root: repo.root, paths: [".env.local"], cwd: repo.root, git });
    expect(summarize(staged.violations)).toEqual(["SEC-003 .env.local:1"]);
    expect(JSON.stringify(staged)).not.toContain(KEY_SHAPED);
  });

  it("finishes a handful of files well under a second", () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `src/lib/feature/module-${index}.ts`,
        lines(...Array.from({ length: 300 }, (__, row) => `export const value${row} = ${row};`)),
      ]),
    );
    const repo = fixture(files);
    const result = runRulesCheck({
      root: repo.root,
      paths: Object.keys(files),
      cwd: repo.root,
      git: NO_GIT,
    });
    expect(result).toMatchObject({ ok: true, filesChecked: 8 });
    expect(result.durationMs).toBeLessThan(500);
  });
});

describe("formatResult", () => {
  it("prints one line per violation and a summary", () => {
    const repo = fixture({ "src/components/cell.tsx": "el.innerHTML = value;\n" });
    const output = formatResult(runRulesCheck({ root: repo.root, git: NO_GIT })).split("\n");
    expect(output[0]).toMatch(
      /^SEC-001 src\/components\/cell\.tsx:1 an innerHTML or outerHTML assignment is forbidden/,
    );
    expect(output[1]).toMatch(
      /^rules-check \(full\): 1 violation, 15 script rules, \d+ files, \d+ ms$/,
    );
    const clean = formatResult(runRulesCheck({ root: fixture().root, git: NO_GIT }));
    expect(clean).toMatch(/^rules-check \(full\): ok, 15 script rules, \d+ files, \d+ ms$/);
  });
});
