/**
 * The standing regression guard for the six rules that only ESLint enforces (rules.yaml ARCH-001,
 * ARCH-002, ARCH-004, CODE-001, CODE-002, SEC-001).
 *
 * It loads the real eslint.config.mjs through ESLint's Node API and lints one violating snippet
 * per rule and scope, plus an allowed counterpart. A rule that is downgraded to "warn", a scope
 * that shrinks, or a block that disappears from eslint.config.mjs fails here, where the rules check
 * (which reads the config as text) cannot see it.
 *
 * The snippets are strings and the file paths do not exist: `lintText` decides by path alone.
 *
 * Flat config replaces the options of a rule instead of merging them, so a later block that names
 * a governed rule for a sub-path, even as "error", drops every ban of the named blocks there. The
 * last two blocks of this file close that door: the exported array is inspected (only the named
 * `rules/*` blocks may name a governed rule, with exactly these scopes), and the resolved options
 * of every real code file are compared with what the named block of its scope declares.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import eslintConfig from "../../eslint.config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ERROR = 2;

const IMPORTS = "no-restricted-imports";
/** The local rule that resolves a specifier before it judges it (scripts/rules-check/eslint-boundaries.mjs). */
const RESOLVED = "boundaries/resolved-imports";
const SYNTAX = "no-restricted-syntax";
const GLOBALS = "no-restricted-globals";
const NO_DANGER = "react/no-danger";
const NO_ANY = "@typescript-eslint/no-explicit-any";
const NO_NON_NULL = "@typescript-eslint/no-non-null-assertion";
const GOVERNED = [IMPORTS, RESOLVED, SYNTAX, GLOBALS, NO_DANGER, NO_ANY, NO_NON_NULL];

const PURE_DIRS = ["runner", "checks", "export", "scenario"];

const eslint = new ESLint({ cwd: REPO_ROOT });

async function lint(file: string, code: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, file) });
  expect(results, `${file} must not be ignored by ESLint`).toHaveLength(1);
  const messages = results[0]?.messages ?? [];
  expect(
    messages.filter((message) => message.fatal === true),
    `${file} must parse`,
  ).toEqual([]);
  return messages;
}

/** Messages of the governed rules only: unrelated findings (an unused variable) are not the subject. */
const governed = (messages: Linter.LintMessage[]) =>
  messages.filter((message) => GOVERNED.includes(message.ruleId ?? ""));

/**
 * Exactly what the task of this suite is: the snippet is an error (not a warning) of the expected
 * ESLint rule, and the message names the rule id of rules.yaml.
 */
async function expectViolation(
  file: string,
  code: string,
  eslintRule: string,
  ruleId: string,
): Promise<void> {
  const hits = (await lint(file, code)).filter((message) => message.ruleId === eslintRule);
  expect(hits.length, `${eslintRule} must report ${file}: ${code}`).toBeGreaterThan(0);
  for (const hit of hits) {
    expect(hit.severity, `${eslintRule} must be an error on ${file}`).toBe(ERROR);
  }
  expect(
    hits.some((hit) => hit.message.includes(`${ruleId}: `)),
    `a ${eslintRule} message on ${file} must name "${ruleId}:", got: ${hits.map((hit) => hit.message).join(" | ")}`,
  ).toBe(true);
}

async function expectAllowed(file: string, code: string): Promise<void> {
  expect(governed(await lint(file, code)), `${file}: ${code}`).toEqual([]);
}

describe("SEC-001 dangerouslySetInnerHTML is an error everywhere", () => {
  const jsx = 'export const View = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n';
  const props = 'export const props = { dangerouslySetInnerHTML: { __html: "x" } };\n';

  it.each([
    "src/components/view.tsx",
    "src/app/lab/view.tsx",
    "src/lib/engine/view.tsx",
    "src/lib/config/view.tsx",
    "src/lib/runner/view.tsx",
    "tests/view.tsx",
    "e2e/view.tsx",
  ])("fails JSX in %s, from the react rule and from the selector", async (file) => {
    const messages = await lint(file, jsx);
    const danger = messages.filter((message) => message.ruleId === NO_DANGER);
    expect(danger).toHaveLength(1);
    expect(danger[0]?.severity).toBe(ERROR);
    await expectViolation(file, jsx, SYNTAX, "SEC-001");
  });

  it.each([
    "scripts/props.mjs",
    "src/lib/store/props.ts",
    "src/lib/config/props.ts",
    "src/lib/scenario/props.ts",
    "src/components/props.cjs",
    "next.config.ts",
  ])("fails a props object in %s", async (file) => {
    const code = file.endsWith(".cjs")
      ? 'module.exports = { dangerouslySetInnerHTML: { __html: "x" } };\n'
      : props;
    await expectViolation(file, code, SYNTAX, "SEC-001");
    await expectViolation(
      file,
      code.replace("dangerouslySetInnerHTML:", '"dangerouslySetInnerHTML":'),
      SYNTAX,
      "SEC-001",
    );
  });

  it("passes text rendering", async () => {
    await expectAllowed(
      "src/components/view.tsx",
      "export const View = ({ text }: { text: string }) => <pre>{text}</pre>;\n",
    );
  });
});

describe("ARCH-002 only src/lib/config reads process.env", () => {
  const reads = [
    "export const value = process.env.SECRET;\n",
    'export const value = process["env"].SECRET;\n',
    "export const value = globalThis.process.env.SECRET;\n",
    "const { env } = process;\nexport const value = env.SECRET;\n",
  ];
  // An alias of the object reads the environment where no selector for `.env` can see it, so the
  // identifier itself is restricted: [snippet, the ESLint rule that must report it].
  const aliases: [string, string][] = [
    ["const p = process;\nexport const other = p.env.OTHER;\n", GLOBALS],
    ["export const read = (p = process) => p.env.OTHER;\n", GLOBALS],
    ['export const isNode = typeof process !== "undefined";\n', GLOBALS],
    ["const p = globalThis.process;\nexport const other = p.env.OTHER;\n", SYNTAX],
    ['const p = globalThis["process"];\nexport const other = p.env.OTHER;\n', SYNTAX],
    ["const p = global.process;\nexport const other = p.env.OTHER;\n", SYNTAX],
    ["const { process: p } = globalThis;\nexport const other = p.env.OTHER;\n", SYNTAX],
    ['const { "process": p } = globalThis;\nexport const other = p.env.OTHER;\n', SYNTAX],
  ];

  it.each([
    "src/components/reader.tsx",
    "src/app/reader.ts",
    "src/proxy.ts",
    "src/lib/engine/reader.ts",
    "src/lib/ai/reader.mts",
    "src/lib/runner/reader.ts",
    "src/lib/runner/reader.test.ts",
  ])(
    "fails every spelling of the read in %s, an alias of the process object included",
    async (file) => {
      for (const code of reads) await expectViolation(file, code, SYNTAX, "ARCH-002");
      for (const [code, rule] of aliases) await expectViolation(file, code, rule, "ARCH-002");
    },
  );

  it.each(["src/components/reader.ts", "src/lib/engine/reader.ts", "src/lib/checks/reader.ts"])(
    "fails an import of the process module in %s",
    async (file) => {
      await expectViolation(
        file,
        'import { env } from "node:process";\nexport const value = env.SECRET;\n',
        IMPORTS,
        "ARCH-002",
      );
      await expectViolation(
        file,
        'import process from "process";\nexport const value = process.argv;\n',
        IMPORTS,
        "ARCH-002",
      );
    },
  );

  it.each([
    "src/components/reader.cjs",
    "src/app/reader.cjs",
    "src/lib/engine/reader.cjs",
    "src/lib/export/reader.cjs",
  ])("fails a CommonJS file %s: .cjs is code under src/ too", async (file) => {
    await expectViolation(file, "module.exports = process.env.SECRET;\n", SYNTAX, "ARCH-002");
    await expectViolation(
      file,
      "const p = process;\nmodule.exports = p.env.SECRET;\n",
      GLOBALS,
      "ARCH-002",
    );
    await expectViolation(
      file,
      'const { env } = require("node:process");\nmodule.exports = env;\n',
      SYNTAX,
      "ARCH-002",
    );
  });

  it("passes the config module and everything outside src/", async () => {
    const code = reads[0] ?? "";
    await expectAllowed("src/lib/config/server.ts", code);
    for (const [alias] of aliases) {
      await expectAllowed("src/lib/config/server.ts", alias);
      await expectAllowed("scripts/reader.mjs", alias);
      await expectAllowed("tests/reader.ts", alias);
    }
    await expectAllowed("src/lib/config/reader.cjs", "module.exports = process.env.NODE_ENV;\n");
    await expectAllowed("scripts/reader.mjs", code);
    await expectAllowed("tests/reader.ts", code);
    await expectAllowed("e2e/reader.ts", code);
    await expectAllowed("next.config.ts", code);
    await expectAllowed(
      "src/components/reader.ts",
      'import { getPublicConfig } from "@/lib/config/public";\nexport const name = getPublicConfig().appName;\n',
    );
  });
});

describe("ARCH-004 src/lib never imports the UI layers", () => {
  const specifiers = [
    "@/components/ui/button",
    "@/components",
    "@/app/lab/page",
    "@/app",
    "../../components/ui/button",
    "../../app/lab/page",
    "../components",
  ];

  it.each([
    "src/lib/engine/port.ts",
    "src/lib/config/port.ts",
    "src/lib/store/port.test.ts",
    "src/lib/runner/port.ts",
  ])("fails a static, a type-only and a dynamic import in %s", async (file) => {
    for (const specifier of specifiers) {
      await expectViolation(
        file,
        `import { thing } from "${specifier}";\nexport { thing };\n`,
        IMPORTS,
        "ARCH-004",
      );
      await expectViolation(
        file,
        `import type { Thing } from "${specifier}";\nexport type { Thing };\n`,
        IMPORTS,
        "ARCH-004",
      );
      await expectViolation(
        file,
        `export const load = () => import("${specifier}");\n`,
        SYNTAX,
        file.includes("/runner/") ? "ARCH-001" : "ARCH-004",
      );
    }
  });

  it.each(["src/lib/engine/port.cjs", "src/lib/config/port.cjs"])(
    "fails require() in %s",
    async (file) => {
      await expectViolation(
        file,
        'module.exports = require("@/components/ui/button");\n',
        SYNTAX,
        "ARCH-004",
      );
    },
  );

  /** Every form that names a module, for one specifier. */
  const importForms = (specifier: string): string[] => [
    `import { thing } from "${specifier}";\nexport { thing };\n`,
    `import type { Thing } from "${specifier}";\nexport type { Thing };\n`,
    `export * from "${specifier}";\n`,
    `export { thing } from "${specifier}";\n`,
    `export const load = () => import("${specifier}");\n`,
    `export const load = () => import(\`${specifier}\`);\n`,
    `export type Thing = import("${specifier}").Thing;\n`,
  ];

  // The banned directory is reached THROUGH another one, so the text patterns of
  // no-restricted-imports do not see it; boundaries/resolved-imports resolves first.
  it.each([
    ["src/lib/security/csp.ts", "../../../src/components/ui/button"],
    ["src/lib/security/csp.ts", "../../lib/../components/ui/button"],
    ["src/lib/security/csp.ts", "../engine/../../app/lab/page"],
    ["src/lib/engine/worker/client.ts", "../../../../src/app/lab/page"],
    ["src/lib/config/server.ts", "../../../src/components/ui/button"],
    ["src/lib/store/port.test.ts", "@/lib/../components/ui/button"],
    ["src/lib/runner/core.ts", "../../../src/components/ui/button"],
  ])("fails %s importing %s, which resolves into a UI layer", async (file, specifier) => {
    for (const code of importForms(specifier)) {
      await expectViolation(file, code, RESOLVED, "ARCH-004");
    }
    const commonJs = file.replace(/(?:\.test)?\.ts$/, ".cjs");
    await expectViolation(
      commonJs,
      `module.exports = require("${specifier}");\n`,
      RESOLVED,
      "ARCH-004",
    );
  });

  it("reports the direct spellings through the resolved rule as well", async () => {
    for (const specifier of specifiers) {
      // "../components" is the UI layer only from a file directly under src/lib.
      const file = specifier === "../components" ? "src/lib/utils.ts" : "src/lib/engine/port.ts";
      await expectViolation(
        file,
        `import { thing } from "${specifier}";\nexport { thing };\n`,
        RESOLVED,
        "ARCH-004",
      );
    }
  });

  it("does not mistake a library directory for a UI layer by its name", async () => {
    await expectAllowed(
      "src/lib/security/csp.ts",
      [
        'import { a } from "../../lib/engine/components/port";',
        'import { b } from "./app/port";',
        'import { c } from "../../../src/lib/utils";',
        'import { d } from "../../../tests/components/helper";',
        "export { a, b, c, d };",
        "",
      ].join("\n"),
    );
  });

  it("passes the same imports from the UI, and library imports inside src/lib", async () => {
    await expectAllowed(
      "src/components/lab/panel.tsx",
      'import { Button } from "@/components/ui/button";\nexport { Button };\n',
    );
    await expectAllowed(
      "src/app/lab/page.tsx",
      'import { Panel } from "../../components/lab/panel";\nexport default Panel;\n',
    );
    await expectAllowed(
      "src/lib/engine/port.ts",
      'import { cn } from "@/lib/utils";\nimport { z } from "zod";\nexport { cn, z };\n',
    );
  });
});

describe("CODE-001 and CODE-002: no any and no non-null assertion in src/lib", () => {
  const anyCode = "export const value: any = 1;\n";
  const nonNullCode = "export const size = (text: string | null) => text!.length;\n";

  it.each([
    "src/lib/engine/typed.ts",
    "src/lib/config/typed.ts",
    "src/lib/runner/typed.ts",
    "src/lib/ai/typed.test.ts",
    "src/lib/store/typed.tsx",
  ])("fails both in %s as errors", async (file) => {
    const messages = await lint(file, `${anyCode}${nonNullCode}`);
    for (const rule of [NO_ANY, NO_NON_NULL]) {
      const hits = messages.filter((message) => message.ruleId === rule);
      expect(hits, `${rule} on ${file}`).toHaveLength(1);
      expect(hits[0]?.severity, `${rule} on ${file}`).toBe(ERROR);
    }
  });

  it("passes unknown with a guard in src/lib, and keeps CODE-002 scoped to src/lib", async () => {
    await expectAllowed(
      "src/lib/engine/typed.ts",
      'export const size = (value: unknown) => (typeof value === "string" ? value.length : 0);\n',
    );
    const outside = await lint("src/components/typed.ts", nonNullCode);
    expect(outside.filter((message) => message.ruleId === NO_NON_NULL)).toEqual([]);
  });
});

describe("ARCH-001 the pure directories", () => {
  const forbidden = [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "next",
    "next/server",
    "next/navigation",
    "ioredis",
    "ioredis/built/Redis",
    "@supabase/supabase-js",
    "@supabase/ssr",
    "ai",
    "ai/rsc",
    "@ai-sdk/anthropic",
    "node:http",
    "http",
    "node:https",
    "https",
    "node:http2",
    "http2",
    "node:net",
    "net",
    "node:tls",
    "node:dgram",
    "node:dns",
    "dns",
    "node:dns/promises",
    "dns/promises",
    "node:child_process",
    "child_process",
    "node:fs",
    "fs",
    "node:fs/promises",
    "fs/promises",
    "@/app/lab/page",
    "@/components/ui/button",
    "../../components/ui/button",
    "@/lib/redis",
    "@/lib/redis/keys",
    "@/lib/ai",
    "@/lib/ai/model",
    "@/lib/store",
    "@/lib/store/supabase",
    "@/lib/config/server",
    "@/lib/config/public",
    "@/lib/config/runtime",
    "../redis/keys",
    "../ai/model",
    "../store",
    "../../store/local",
    "../config/server",
    "../config/public",
    "../config/runtime",
  ];

  it.each(PURE_DIRS)("fails an import of Redis in src/lib/%s, test files included", async (dir) => {
    for (const file of [`src/lib/${dir}/core.ts`, `src/lib/${dir}/core.test.ts`]) {
      await expectViolation(
        file,
        'import Redis from "ioredis";\nexport { Redis };\n',
        IMPORTS,
        "ARCH-001",
      );
    }
  });

  it("fails every forbidden module: static, type-only, re-export, dynamic and require()", async () => {
    for (const specifier of forbidden) {
      // The UI layers keep their own, more specific message.
      const staticId = /(^@\/|\/)(app|components)(\/|$)/.test(specifier) ? "ARCH-004" : "ARCH-001";
      await expectViolation(
        "src/lib/runner/core.ts",
        `import * as banned from "${specifier}";\nexport { banned };\n`,
        IMPORTS,
        staticId,
      );
      await expectViolation(
        "src/lib/checks/core.ts",
        `import type { Banned } from "${specifier}";\nexport type { Banned };\n`,
        IMPORTS,
        staticId,
      );
      await expectViolation(
        "src/lib/export/core.ts",
        `export * from "${specifier}";\n`,
        IMPORTS,
        staticId,
      );
      await expectViolation(
        "src/lib/scenario/core.ts",
        `export const load = () => import("${specifier}");\n`,
        SYNTAX,
        "ARCH-001",
      );
      await expectViolation(
        "src/lib/runner/core.cjs",
        `module.exports = require("${specifier}");\n`,
        SYNTAX,
        "ARCH-001",
      );
    }
  }, 60_000);

  // Reached through an intermediate directory: only the resolved rule sees these.
  const throughAnotherDirectory = [
    "../../lib/redis/keys",
    "../../lib/ai/model",
    "../../../src/lib/store/local",
    "../checks/../redis/keys",
    "../../lib/config/server",
    "../../lib/config",
    "../scenario/../config/runtime",
    "@/lib/runner/../redis/keys",
  ];

  it.each(PURE_DIRS)(
    "fails an impure library directory reached through another one in src/lib/%s",
    async (dir) => {
      for (const specifier of throughAnotherDirectory) {
        for (const file of [`src/lib/${dir}/core.ts`, `src/lib/${dir}/core.test.ts`]) {
          await expectViolation(
            file,
            `import * as banned from "${specifier}";\nexport { banned };\n`,
            RESOLVED,
            "ARCH-001",
          );
        }
        await expectViolation(
          `src/lib/${dir}/core.ts`,
          `import type { Banned } from "${specifier}";\nexport type { Banned };\n`,
          RESOLVED,
          "ARCH-001",
        );
        await expectViolation(
          `src/lib/${dir}/core.ts`,
          `export const load = () => import("${specifier}");\n`,
          RESOLVED,
          "ARCH-001",
        );
        await expectViolation(
          `src/lib/${dir}/core.cjs`,
          `module.exports = require("${specifier}");\n`,
          RESOLVED,
          "ARCH-001",
        );
      }
      await expectViolation(
        `src/lib/${dir}/core.ts`,
        'import { Button } from "../../../src/components/ui/button";\nexport { Button };\n',
        RESOLVED,
        "ARCH-004",
      );
    },
  );

  it("keeps the pure config parser and the pure directories allowed through any spelling", async () => {
    await expectAllowed(
      "src/lib/runner/core.ts",
      [
        'import { parsePublicEnv } from "../../lib/config/env";',
        'import { parseServerEnv } from "../config/env.ts";',
        'import { defaults } from "../../lib/scenario/defaults";',
        'import { registry } from "../../../src/lib/checks/registry";',
        'import type { SqlEngine } from "../../lib/engine/port";',
        "export { parsePublicEnv, parseServerEnv, defaults, registry };",
        "export type { SqlEngine };",
        "",
      ].join("\n"),
    );
    // Not the parser: a sibling that only starts with its name.
    await expectViolation(
      "src/lib/runner/core.ts",
      'import { read } from "../../lib/config/env.server";\nexport { read };\n',
      RESOLVED,
      "ARCH-001",
    );
  });

  it.each(PURE_DIRS)("fails the network globals in src/lib/%s", async (dir) => {
    const file = `src/lib/${dir}/core.ts`;
    const bare = [
      'export const load = () => fetch("/api/health");\n',
      "export const open = () => new XMLHttpRequest();\n",
      'export const open = () => new WebSocket("/socket");\n',
      'export const open = () => new EventSource("/events");\n',
    ];
    for (const code of bare) await expectViolation(file, code, GLOBALS, "ARCH-001");
    const members = [
      'export const load = () => globalThis.fetch("/api/health");\n',
      'export const load = () => global.fetch("/api/health");\n',
      'export const open = () => new window.WebSocket("/socket");\n',
      'export const open = () => new self.EventSource("/events");\n',
      'export const send = () => navigator.sendBeacon("/beacon");\n',
      // The bracket form, as for process.
      'export const load = () => globalThis["fetch"]("/api/health");\n',
      'export const open = () => new window["WebSocket"]("/socket");\n',
      'export const open = () => new self["XMLHttpRequest"]();\n',
      'export const open = () => new global["EventSource"]("/events");\n',
      'export const send = () => navigator["sendBeacon"]("/beacon");\n',
      // Destructured from a global object, renamed or not.
      'const { fetch: load } = globalThis;\nexport const run = () => load("/api/health");\n',
      'const { WebSocket: Socket } = window;\nexport const open = () => new Socket("/socket");\n',
      'const { EventSource: Source } = self;\nexport const open = () => new Source("/events");\n',
      "const { XMLHttpRequest: Xhr } = global;\nexport const open = () => new Xhr();\n",
      'const { "fetch": load } = globalThis;\nexport const run = () => load("/api/health");\n',
      'const { sendBeacon } = navigator;\nexport const send = () => sendBeacon("/beacon");\n',
    ];
    for (const code of members) await expectViolation(file, code, SYNTAX, "ARCH-001");
  });

  it("passes zod, PGlite, the engine port, the pure config parser and other pure code", async () => {
    await expectAllowed(
      "src/lib/runner/core.ts",
      [
        'import { PGlite } from "@electric-sql/pglite";',
        'import { z } from "zod";',
        'import { parsePublicEnv } from "@/lib/config/env";',
        'import type { SqlResultSet } from "@/lib/engine/worker/protocol";',
        'import { cn } from "@/lib/utils";',
        'import { defaults } from "../scenario/defaults";',
        "export { PGlite, z, parsePublicEnv, cn, defaults };",
        "export type { SqlResultSet };",
        'export const later = () => import("../checks/registry");',
        "",
      ].join("\n"),
    );
  });

  it("does not apply outside the four directories", async () => {
    await expectAllowed(
      "src/lib/redis/adapters/redis.ts",
      'import Redis from "ioredis";\nimport { readFileSync } from "node:fs";\nexport { Redis, readFileSync };\nexport const load = () => fetch("/api/health");\n',
    );
    await expectAllowed(
      "src/lib/ai/explain.ts",
      'import { keys } from "../../lib/redis/keys";\nconst { fetch: load } = globalThis;\nexport const run = () => globalThis["fetch"](keys.health) ?? load(keys.health);\n',
    );
    await expectAllowed(
      "src/lib/ai/explain.ts",
      'import { getServerConfig } from "@/lib/config/server";\nimport { keys } from "@/lib/redis/keys";\nexport { getServerConfig, keys };\n',
    );
    await expectAllowed(
      "src/components/lab/panel.tsx",
      'import { useState } from "react";\nexport { useState };\n',
    );
  });
});

describe("the resolved configuration", () => {
  const expected: [string, string[]][] = [
    ["scripts/tool.mjs", [SYNTAX, NO_DANGER]],
    ["src/components/panel.tsx", [SYNTAX, IMPORTS, GLOBALS, NO_DANGER]],
    ["src/components/panel.cjs", [SYNTAX, IMPORTS, GLOBALS]],
    ["src/proxy.ts", [SYNTAX, IMPORTS, GLOBALS, NO_DANGER]],
    ["src/lib/engine/port.ts", GOVERNED],
    ["src/lib/engine/port.cjs", [SYNTAX, IMPORTS, RESOLVED, GLOBALS]],
    ["src/lib/config/server.ts", [SYNTAX, IMPORTS, RESOLVED, NO_DANGER, NO_ANY, NO_NON_NULL]],
    ...PURE_DIRS.flatMap((dir): [string, string[]][] => [
      [`src/lib/${dir}/core.ts`, GOVERNED],
      [`src/lib/${dir}/core.test.ts`, GOVERNED],
      [`src/lib/${dir}/core.cjs`, [SYNTAX, IMPORTS, RESOLVED, GLOBALS]],
    ]),
  ];

  it.each(expected)("has every governed rule of %s as an error", async (file, rules) => {
    const config = (await eslint.calculateConfigForFile(path.join(REPO_ROOT, file))) as {
      rules?: Record<string, [number, ...unknown[]]>;
    };
    for (const rule of rules) {
      expect(config.rules?.[rule]?.[0], `${rule} on ${file}`).toBe(ERROR);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// No block re-declares a governed rule for a sub-path
// -------------------------------------------------------------------------------------------------

const CORE_EXT = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";
const PLUGIN_EXT = "{js,jsx,mjs,ts,tsx,mts,cts}";
const CONFIG_GLOB = `src/lib/config/**/*.${CORE_EXT}`;

/** The only blocks of eslint.config.mjs that may name a governed rule, with their exact scope. */
const NAMED_BLOCKS: Record<string, { files: string[]; ignores?: string[]; rules: string[] }> = {
  "rules/sec-001": { files: [`**/*.${CORE_EXT}`], rules: [SYNTAX] },
  "rules/sec-001-react": { files: [`**/*.${PLUGIN_EXT}`], rules: [NO_DANGER] },
  "rules/arch-002": {
    files: [`src/**/*.${CORE_EXT}`],
    ignores: [CONFIG_GLOB],
    rules: [SYNTAX, IMPORTS, GLOBALS],
  },
  "rules/arch-004": { files: [`src/lib/**/*.${CORE_EXT}`], rules: [IMPORTS, RESOLVED, SYNTAX] },
  "rules/code-001-code-002": {
    files: [`src/lib/**/*.${PLUGIN_EXT}`],
    rules: [NO_ANY, NO_NON_NULL],
  },
  "rules/config-dir": { files: [CONFIG_GLOB], rules: [IMPORTS, RESOLVED, SYNTAX] },
  "rules/arch-001": {
    files: PURE_DIRS.map((dir) => `src/lib/${dir}/**/*.${CORE_EXT}`),
    rules: [IMPORTS, RESOLVED, GLOBALS, SYNTAX],
  },
};

type Scope = "outside" | "src" | "lib" | "config" | "pure";

/** Which named block decides each governed rule in a scope. A rule that is absent is not set. */
const DECIDED_BY: Record<Scope, Partial<Record<string, string>>> = {
  outside: { [SYNTAX]: "rules/sec-001" },
  src: { [SYNTAX]: "rules/arch-002", [IMPORTS]: "rules/arch-002", [GLOBALS]: "rules/arch-002" },
  lib: {
    [SYNTAX]: "rules/arch-004",
    [IMPORTS]: "rules/arch-004",
    [RESOLVED]: "rules/arch-004",
    [GLOBALS]: "rules/arch-002",
  },
  config: {
    [SYNTAX]: "rules/config-dir",
    [IMPORTS]: "rules/config-dir",
    [RESOLVED]: "rules/config-dir",
  },
  pure: {
    [SYNTAX]: "rules/arch-001",
    [IMPORTS]: "rules/arch-001",
    [RESOLVED]: "rules/arch-001",
    [GLOBALS]: "rules/arch-001",
  },
};

function scopeOf(file: string): Scope {
  if (!file.startsWith("src/")) return "outside";
  if (file.startsWith("src/lib/config/")) return "config";
  if (PURE_DIRS.some((dir) => file.startsWith(`src/lib/${dir}/`))) return "pure";
  return file.startsWith("src/lib/") ? "lib" : "src";
}

interface Block {
  name?: string;
  files?: unknown;
  ignores?: unknown;
  rules?: Record<string, unknown>;
}
const blocks = eslintConfig as Block[];
const governedIn = (block: Block) =>
  Object.keys(block.rules ?? {}).filter((rule) => GOVERNED.includes(rule));
const namedBlock = (name: string) => blocks.find((block) => block.name === name);

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);

function codeFilesBelow(dir: string): string[] {
  return readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : codeFilesBelow(relative);
    return CODE_FILE.test(entry.name) ? [relative] : [];
  });
}

/** One synthetic path per directory of the layout (brief 4.2), flat, nested, CommonJS and test. */
const LAYOUT_DIRS = [
  "src/app",
  "src/app/api/explain",
  "src/app/docs",
  "src/components",
  ...["scenario", "engine", "runner", "checks", "export", "redis", "ai", "store", "config"].map(
    (dir) => `src/lib/${dir}`,
  ),
  "src/lib",
  "src",
  "tests",
  "e2e",
  "scripts",
];
const syntheticFiles = LAYOUT_DIRS.flatMap((dir) => [
  `${dir}/synthetic.ts`,
  `${dir}/synthetic.tsx`,
  `${dir}/synthetic.cjs`,
  `${dir}/synthetic.test.ts`,
  `${dir}/deeper/than/that/synthetic.mts`,
]);

describe("only the named blocks of eslint.config.mjs name a governed rule", () => {
  it("has each named block exactly once, with exactly its scope and its governed rules", () => {
    for (const [name, expected] of Object.entries(NAMED_BLOCKS)) {
      const found = blocks.filter((block) => block.name === name);
      expect(found, name).toHaveLength(1);
      expect(found[0]?.files, `${name} files`).toEqual(expected.files);
      expect(found[0]?.ignores, `${name} ignores`).toEqual(expected.ignores);
      expect(governedIn(found[0] ?? {}).sort(), `${name} rules`).toEqual(
        [...expected.rules].sort(),
      );
    }
  });

  it("has no other block that names one, except third-party presets that come first", () => {
    const firstNamed = blocks.findIndex((block) => block.name === "rules/sec-001");
    expect(firstNamed).toBeGreaterThan(0);
    const strangers = blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          governedIn(block).length > 0 && !Object.hasOwn(NAMED_BLOCKS, block.name ?? ""),
      );
    // A preset that sits before the named blocks cannot replace them; anything after them can.
    expect(
      strangers.filter(({ index }) => index > firstNamed).map(({ block }) => block.name ?? block),
    ).toEqual([]);
    // What the presets say about a governed rule is an error too (typescript-eslint/recommended).
    for (const { block } of strangers) {
      for (const rule of governedIn(block)) {
        const entry = block.rules?.[rule];
        expect(Array.isArray(entry) ? entry[0] : entry, `${block.name}: ${rule}`).toBe("error");
      }
    }
  });
});

describe("every file resolves to what the named block of its scope declares", () => {
  async function resolved(file: string): Promise<Record<string, unknown[] | undefined>> {
    const config = (await eslint.calculateConfigForFile(path.join(REPO_ROOT, file))) as
      { rules?: Record<string, unknown[]> } | undefined;
    return config?.rules ?? {};
  }

  /** `["error", a, b]` as declared in a block, in the resolved form `[2, a, b]`. */
  const declared = (blockName: string, rule: string): unknown[] => {
    const entry = namedBlock(blockName)?.rules?.[rule];
    expect(entry, `${blockName} declares ${rule}`).toBeDefined();
    const [severity, ...options] = Array.isArray(entry) ? (entry as unknown[]) : [entry];
    expect(severity, `${blockName}: ${rule}`).toBe("error");
    return [ERROR, ...options];
  };

  async function expectScopeOptions(file: string): Promise<void> {
    const rules = await resolved(file);
    const decidedBy = DECIDED_BY[scopeOf(file)];
    for (const rule of [SYNTAX, IMPORTS, RESOLVED, GLOBALS]) {
      const blockName = decidedBy[rule];
      if (blockName === undefined) {
        expect(rules[rule], `${rule} on ${file}`).toBeUndefined();
      } else {
        expect(rules[rule], `${rule} on ${file} must be what ${blockName} declares`).toEqual(
          declared(blockName, rule),
        );
      }
    }
    const typed = /\.(?:ts|tsx|mts|cts)$/.test(file);
    const inLib = file.startsWith("src/lib/");
    if (!file.endsWith(".cjs"))
      expect(rules[NO_DANGER], `${NO_DANGER} on ${file}`).toEqual([ERROR]);
    if (typed || (inLib && !file.endsWith(".cjs"))) {
      expect(rules[NO_ANY]?.[0], `${NO_ANY} on ${file}`).toBe(ERROR);
    }
    if (inLib && !file.endsWith(".cjs")) {
      expect(rules[NO_NON_NULL], `${NO_NON_NULL} on ${file}`).toEqual([ERROR]);
    }
  }

  it("holds for every real code file under src/, tests/, e2e/ and scripts/, and at the root", async () => {
    const rootFiles = readdirSync(REPO_ROOT).filter((name) => CODE_FILE.test(name));
    const files = [
      ...["src", "tests", "e2e", "scripts"].flatMap((dir) => codeFilesBelow(dir)),
      ...rootFiles,
    ];
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain("src/proxy.ts");
    let checked = 0;
    for (const file of files) {
      if (await eslint.isPathIgnored(path.join(REPO_ROOT, file))) continue;
      await expectScopeOptions(file);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  }, 60_000);

  it("holds for a synthetic path in every directory of the layout", async () => {
    for (const file of syntheticFiles) await expectScopeOptions(file);
  }, 60_000);
});
