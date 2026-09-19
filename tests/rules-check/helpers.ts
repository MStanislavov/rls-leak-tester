/**
 * Shared helpers for the rules-check suites.
 *
 * Fixtures that would violate a rule of this repository if they were written out literally (key
 * shaped strings for SEC-003, network calls and provider imports for TEST-001) are assembled at
 * run time with `glue`, so this directory never contains such a string.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { GUARD_SUITES, makeSource } from "../../scripts/rules-check/checks.mjs";
import { SKIP_DIRS } from "../../scripts/rules-check/repo.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SCRIPT = path.join(REPO_ROOT, "scripts/rules-check.mjs");

/** Joins fragments at run time. */
export const glue = (...parts: string[]): string => parts.join("");
/** A multi-line fixture. */
export const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;
/** A source for a file check. */
export const source = (filePath: string, content: string) => makeSource(filePath, content);

export interface Violation {
  rule: string;
  path: string;
  line: number;
  message: string;
}

/** `RULE path:line` of each violation: short, stable and easy to assert on. */
export const summarize = (violations: readonly Violation[]): string[] =>
  violations.map((violation) => `${violation.rule} ${violation.path}:${violation.line}`);

export const FIXTURE_ESLINT_CONFIG = lines(
  'import { defineConfig, globalIgnores } from "eslint/config";',
  "",
  'export default defineConfig([globalIgnores([".next/**", "coverage/**"])]);',
);

export const FIXTURE_VITEST_CONFIG = lines(
  'import { defineConfig } from "vitest/config";',
  "",
  "export default defineConfig({",
  "  test: {",
  '    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],',
  '    exclude: ["node_modules/**"],',
  "    coverage: {",
  '      include: ["src/lib/**"],',
  '      exclude: ["src/lib/**/*.test.{ts,tsx}"],',
  "      thresholds: { lines: 80, branches: 80 },",
  "    },",
  '    setupFiles: ["./tests/setup/network-guard.setup.ts"],',
  "  },",
  "});",
);

/** What the run-time layer of TEST-001 needs to find in a healthy checkout. */
export const FIXTURE_NETWORK_GUARD_SETUP = lines(
  'import { afterEach } from "vitest";',
  'import { failOnBlockedAttempts, installNetworkGuard } from "./network-guard";',
  "",
  "installNetworkGuard(process.env);",
  "afterEach(() => failOnBlockedAttempts());",
);

/** A suite that QUAL-002 accepts as present: it holds a test and nothing switches it off. */
export const FIXTURE_GUARD_SUITE = lines(
  'import { expect, it } from "vitest";',
  "",
  'it("guards a rule", () => expect(true).toBe(true));',
);

/** The suites rules.yaml names as an enforcer, as a healthy checkout has them. */
export const FIXTURE_GUARD_SUITES: Record<string, string> = Object.fromEntries(
  GUARD_SUITES.map((suite) => [suite.path, FIXTURE_GUARD_SUITE]),
);

const FIXTURE_EXCLUSIONS = [
  { tool: "eslint", pattern: ".next/**" },
  { tool: "eslint", pattern: "coverage/**" },
  { tool: "vitest", pattern: "node_modules/**" },
  { tool: "vitest-coverage", pattern: "src/lib/**/*.test.{ts,tsx}" },
  ...SKIP_DIRS.map((pattern) => ({ tool: "rules-check", pattern })),
].map((entry) => ({ ...entry, reason: "A written reason that is long enough for the schema." }));

/**
 * The repository's real rules.yaml as data, with the exclusions swapped for the ones that match
 * the fixture configuration files. The rule list stays the real one on purpose.
 */
export function fixtureRules(realRulesYaml: string): Record<string, unknown> {
  const data = parse(realRulesYaml) as Record<string, unknown>;
  return { ...data, exclusions: FIXTURE_EXCLUSIONS };
}

export interface FixtureRepo {
  root: string;
  write: (relativePath: string, content: string) => void;
  remove: () => void;
}

/**
 * A small, healthy checkout in a temporary directory: valid rules.yaml, matching ESLint and
 * Vitest configuration, strict tsconfig. `files` adds to it or overwrites it.
 */
export function createFixtureRepo(
  realRulesYaml: string,
  files: Record<string, string> = {},
): FixtureRepo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rules-check-")));
  const write = (relativePath: string, content: string): void => {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  const baseline: Record<string, string> = {
    "rules.yaml": stringify(fixtureRules(realRulesYaml)),
    "scripts/rules-check.mjs": "// stands in for the real script: rules.yaml names this path\n",
    "eslint.config.mjs": FIXTURE_ESLINT_CONFIG,
    "vitest.config.mts": FIXTURE_VITEST_CONFIG,
    "tests/setup/network-guard.setup.ts": FIXTURE_NETWORK_GUARD_SETUP,
    ...FIXTURE_GUARD_SUITES,
    "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
  };
  for (const [relativePath, content] of Object.entries({ ...baseline, ...files })) {
    write(relativePath, content);
  }
  return { root, write, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** Git answers for a directory that is not a repository: nothing tracked, nothing filtered. */
export const NO_GIT = {
  tracked: (): string[] | null => null,
  unignored: (): string[] | null => null,
  trackedAmong: (): string[] => [],
};
