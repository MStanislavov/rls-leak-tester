import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

import boundaries from "./scripts/rules-check/eslint-boundaries.mjs";

/*
 * Architecture and safety rules from rules.yaml that ESLint enforces. Every
 * message carries its rule id. All of them are errors; none may be downgraded
 * or scoped down to get green (QUAL-002). tests/eslint/boundaries.test.ts loads
 * this file and lints one violating snippet per rule and scope, so a weaker
 * rule, a smaller scope or a missing block fails `npm test`.
 *
 * Flat config does not merge rule options: when two blocks set the same rule
 * for a file, the later block replaces the earlier one. `no-restricted-imports`,
 * `no-restricted-syntax` and `no-restricted-globals` are therefore composed
 * from the shared lists below, so a narrower scope always carries everything
 * the wider scopes ban.
 *
 * For the same reason a governed rule is named in the `rules/*` blocks of this
 * file and nowhere else (`boundaries/resolved-imports` included: its zones are
 * options too). A later block that sets one of them for a sub-path,
 * even as "error", silently drops everything the named blocks ban there. The
 * rules check (QUAL-002) refuses a governed rule name outside these blocks, and
 * tests/eslint/boundaries.test.ts compares the resolved options of every real
 * file with its scope. Need another selector? Add it to a shared list here.
 */

// The `react` plugin of eslint-config-next is registered for exactly these
// extensions, so the blocks that name a plugin rule use the same set.
const EXT = "{js,jsx,mjs,ts,tsx,mts,cts}";
// The boundary rules use core ESLint rules only and therefore also cover
// CommonJS files: tsconfig has allowJs, and .cjs under src/ is code like any other.
const CORE_EXT = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";
const ALL_CODE = [`**/*.${CORE_EXT}`];
const ALL_PLUGIN_CODE = [`**/*.${EXT}`];
const SRC = [`src/**/*.${CORE_EXT}`];
const LIB = [`src/lib/**/*.${CORE_EXT}`];
const LIB_TYPED = [`src/lib/**/*.${EXT}`];
const CONFIG_DIR = [`src/lib/config/**/*.${CORE_EXT}`];
const PURE_DIRS = ["runner", "checks", "export", "scenario"].map(
  (dir) => `src/lib/${dir}/**/*.${CORE_EXT}`,
);

// A relative path that climbs out and lands in src/app or src/components.
const RELATIVE_APP_LAYER = String.raw`^(?:\.\./)+(?:app|components)(?:/|$)`;
// The parts of src/lib that reach the network or the environment: Redis, the
// model, the store, and every config module except the pure parser env.ts.
const ALIAS_IMPURE_LIB = "^@/lib/(?:redis|ai|store)(?:/|$)";
const RELATIVE_IMPURE_LIB = String.raw`^(?:\.\./)+(?:redis|ai|store)(?:/|$)`;
const ALIAS_CONFIG_READER = String.raw`^@/lib/config(?:$|/(?!env(?:\.[cm]?[jt]s)?$))`;
const RELATIVE_CONFIG_READER = String.raw`^(?:\.\./)+config(?:$|/(?!env(?:\.[cm]?[jt]s)?$))`;

// ---------------------------------------------------------------------------
// no-restricted-imports, composed per scope
// ---------------------------------------------------------------------------

const ARCH_002_IMPORT =
  "ARCH-002: only src/lib/config reads the environment. Import the typed config instead of the process module.";
const ARCH_004_IMPORT =
  "ARCH-004: src/lib never imports from src/app or src/components. Dependencies point from the UI into the library.";
const ARCH_001_IMPORT =
  "ARCH-001: src/lib/runner, checks, export and scenario are pure: no React, no Next.js, no UI layers, no Redis, no Supabase, no AI SDK, no network, DNS, child process or file system modules, and nothing from src/lib/redis, src/lib/ai, src/lib/store or the readers in src/lib/config. Take values and ports as parameters.";

const processModulePaths = ["process", "node:process"].map((name) => ({
  name,
  message: ARCH_002_IMPORT,
}));

const appLayerPatterns = [
  { group: ["@/app", "@/app/**", "@/components", "@/components/**"], message: ARCH_004_IMPORT },
  { regex: RELATIVE_APP_LAYER, message: ARCH_004_IMPORT },
];

const NODE_IO_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "child_process",
  "fs",
];

const PURE_FORBIDDEN_MODULES = [
  "react",
  "react-dom",
  "next",
  "ioredis",
  "ai",
  ...NODE_IO_MODULES.flatMap((name) => [name, `node:${name}`]),
];

const purePaths = PURE_FORBIDDEN_MODULES.map((name) => ({ name, message: ARCH_001_IMPORT }));

const purePatterns = [
  {
    // Every subpath of the modules above (react/jsx-runtime, next/server,
    // node:fs/promises, dns/promises, ...) and the two scoped SDK families.
    group: [...PURE_FORBIDDEN_MODULES.map((name) => `${name}/*`), "@supabase/*", "@ai-sdk/*"],
    message: ARCH_001_IMPORT,
  },
  ...[ALIAS_IMPURE_LIB, RELATIVE_IMPURE_LIB, ALIAS_CONFIG_READER, RELATIVE_CONFIG_READER].map(
    (regex) => ({ regex, message: ARCH_001_IMPORT }),
  ),
];

function restrictedImports({ processModule = false, pure = false }) {
  return [
    "error",
    {
      paths: [...(processModule ? processModulePaths : []), ...(pure ? purePaths : [])],
      patterns: [...appLayerPatterns, ...(pure ? purePatterns : [])],
    },
  ];
}

// ---------------------------------------------------------------------------
// boundaries/resolved-imports, composed per scope
// ---------------------------------------------------------------------------

/*
 * The patterns above match the specifier as text and only see a banned
 * directory that follows the `../` chain directly. This rule resolves the
 * specifier against the importing file (scripts/rules-check/eslint-boundaries.mjs,
 * the resolver of the SEC-004 check), so `../../lib/redis/keys` from
 * src/lib/runner, `../../../src/components/ui/button` from src/lib/security and
 * `../checks/../redis/keys` are errors as well, in every import form.
 */
const ARCH_004_RESOLVED =
  "ARCH-004: src/lib never imports from src/app or src/components, whichever directories the relative path passes through.";
const ARCH_001_RESOLVED =
  "ARCH-001: this directory is pure and reaches nothing from src/lib/redis, src/lib/ai, src/lib/store or the readers in src/lib/config, whichever directories the relative path passes through.";

const appLayerZone = { dirs: ["src/app", "src/components"], message: ARCH_004_RESOLVED };
const pureZones = [
  { dirs: ["src/lib/redis", "src/lib/ai", "src/lib/store"], message: ARCH_001_RESOLVED },
  {
    dirs: ["src/lib/config"],
    // The pure parser env.ts stays allowed, exactly as in ALIAS_CONFIG_READER.
    except: String.raw`^src/lib/config/env(?:\.[cm]?[jt]s)?$`,
    message: ARCH_001_RESOLVED,
  },
];

function resolvedImports({ pure = false }) {
  return ["error", [appLayerZone, ...(pure ? pureZones : [])]];
}

// ---------------------------------------------------------------------------
// no-restricted-syntax, composed per scope
// ---------------------------------------------------------------------------

const SEC_001 =
  "SEC-001: dangerouslySetInnerHTML is forbidden everywhere. Scenario text and query results are rendered as text, never as HTML.";
const ARCH_002 =
  "ARCH-002: only src/lib/config reads process.env. Use getServerConfig(), getPublicConfig() or @/lib/config/runtime, and pass values into pure code as parameters.";
const ARCH_002_REQUIRE =
  "ARCH-002: only src/lib/config reads the environment. Do not require() the process module.";
const ARCH_004_DYNAMIC =
  "ARCH-004: src/lib never loads src/app or src/components, not through import() or require() either.";
const ARCH_001_DYNAMIC =
  "ARCH-001: this directory is pure. Loading a UI, framework, Redis, Supabase, AI, network, DNS, child process or file system module, or src/lib/redis, src/lib/ai, src/lib/store or a config reader, through import() or require() is forbidden.";
const ARCH_001_GLOBAL =
  "ARCH-001: this directory is pure and must not touch the network (fetch, XMLHttpRequest, WebSocket, EventSource, navigator.sendBeacon).";
const ARCH_002_GLOBAL =
  "ARCH-002: only src/lib/config touches the process object. An alias (const p = process) would read the environment unseen. Use getServerConfig(), getPublicConfig() or @/lib/config/runtime, and pass values into pure code as parameters.";

// react/no-danger only sees JSX on DOM elements; these also catch a custom
// component prop and a props object handed to createElement.
const dangerSelectors = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: SEC_001 },
  { selector: "Property[key.name='dangerouslySetInnerHTML']", message: SEC_001 },
  { selector: "Property[key.value='dangerouslySetInnerHTML']", message: SEC_001 },
];

// An unescaped slash would end the regular expression inside an esquery selector.
const forSelector = (/** @type {string} */ regexSource) =>
  regexSource.replaceAll("/", String.raw`\/`);

// import("x") and require("x"), which no-restricted-imports does not see.
const loadSelectors = (/** @type {string} */ regexSource, /** @type {string} */ message) => [
  { selector: `ImportExpression[source.value=/${forSelector(regexSource)}/]`, message },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/${forSelector(regexSource)}/]`,
    message,
  },
];

const GLOBAL_OBJECTS = ["globalThis", "global", "window", "self"];
// The esquery form of "one of the global objects", for [object.name=…] and [init.name=…].
const GLOBAL_OBJECT = `/^(${GLOBAL_OBJECTS.join("|")})$/`;

// The bare identifier `process` (no-restricted-globals). src/ has no other use
// for it: NODE_ENV comes from src/lib/config/runtime.ts.
const processGlobal = [{ name: "process", message: ARCH_002_GLOBAL }];

const processEnvSelectors = [
  // process.env, process.env.X, process?.env
  { selector: "MemberExpression[object.name='process'][property.name='env']", message: ARCH_002 },
  // process["env"]
  { selector: "MemberExpression[object.name='process'][property.value='env']", message: ARCH_002 },
  // globalThis.process.env and friends
  {
    selector: "MemberExpression[object.property.name='process'][property.name='env']",
    message: ARCH_002,
  },
  {
    selector: "MemberExpression[object.property.name='process'][property.value='env']",
    message: ARCH_002,
  },
  // const { env } = process
  {
    selector: "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
    message: ARCH_002,
  },
  // globalThis.process, global["process"]: no-restricted-globals only sees the
  // bare identifier, and an alias of the object reads the environment unseen.
  {
    selector: `MemberExpression[object.name=${GLOBAL_OBJECT}][property.name='process']`,
    message: ARCH_002_GLOBAL,
  },
  {
    selector: `MemberExpression[object.name=${GLOBAL_OBJECT}][property.value='process']`,
    message: ARCH_002_GLOBAL,
  },
  // const { process } = globalThis, const { process: p } = globalThis
  {
    selector: `VariableDeclarator[init.name=${GLOBAL_OBJECT}] > ObjectPattern > Property[key.name='process']`,
    message: ARCH_002_GLOBAL,
  },
  // const { "process": p } = globalThis
  {
    selector: `VariableDeclarator[init.name=${GLOBAL_OBJECT}] > ObjectPattern > Property[key.value='process']`,
    message: ARCH_002_GLOBAL,
  },
  // require("node:process") and import("node:process")
  ...loadSelectors("^(?:node:)?process$", ARCH_002_REQUIRE),
];

const ALIAS_APP_LAYER = "^@/(?:app|components)(?:/|$)";
const appLayerLoadSelectors = loadSelectors(
  `${ALIAS_APP_LAYER}|${RELATIVE_APP_LAYER}`,
  ARCH_004_DYNAMIC,
);

const PURE_LOAD = [
  `^(?:${PURE_FORBIDDEN_MODULES.join("|")})(?:/|$)`,
  "^@(?:supabase|ai-sdk)/",
  ALIAS_APP_LAYER,
  RELATIVE_APP_LAYER,
  ALIAS_IMPURE_LIB,
  RELATIVE_IMPURE_LIB,
  ALIAS_CONFIG_READER,
  RELATIVE_CONFIG_READER,
].join("|");

const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];
const NETWORK_GLOBAL = `/^(${NETWORK_GLOBALS.join("|")})$/`;

// no-restricted-globals only sees the bare identifier. These mirror the
// selectors for `process` above, spelling by spelling.
const networkGlobalSelectors = [
  // globalThis.fetch, window.WebSocket, self.EventSource, global.fetch
  `MemberExpression[object.name=${GLOBAL_OBJECT}][property.name=${NETWORK_GLOBAL}]`,
  // globalThis["fetch"], window["WebSocket"]
  `MemberExpression[object.name=${GLOBAL_OBJECT}][property.value=${NETWORK_GLOBAL}]`,
  // const { fetch } = globalThis, const { fetch: load } = window
  `VariableDeclarator[init.name=${GLOBAL_OBJECT}] > ObjectPattern > Property[key.name=${NETWORK_GLOBAL}]`,
  // const { "fetch": load } = self
  `VariableDeclarator[init.name=${GLOBAL_OBJECT}] > ObjectPattern > Property[key.value=${NETWORK_GLOBAL}]`,
  // navigator.sendBeacon, navigator["sendBeacon"], const { sendBeacon } = navigator
  "MemberExpression[property.name='sendBeacon']",
  "MemberExpression[property.value='sendBeacon']",
  "VariableDeclarator > ObjectPattern > Property[key.name='sendBeacon']",
  "VariableDeclarator > ObjectPattern > Property[key.value='sendBeacon']",
].map((selector) => ({ selector, message: ARCH_001_GLOBAL }));

const pureSelectors = [...loadSelectors(PURE_LOAD, ARCH_001_DYNAMIC), ...networkGlobalSelectors];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // The local plugin behind boundaries/resolved-imports. No `files`: it is
  // registered for every file, CommonJS included, and sets no rule itself.
  { name: "rules/plugins", plugins: { boundaries } },

  // SEC-001: everywhere, including scripts, tests, config files and CommonJS.
  {
    name: "rules/sec-001",
    files: ALL_CODE,
    rules: {
      "no-restricted-syntax": ["error", ...dangerSelectors],
    },
  },
  {
    name: "rules/sec-001-react",
    files: ALL_PLUGIN_CODE,
    rules: {
      "react/no-danger": "error",
    },
  },

  // ARCH-002: all of src except src/lib/config. Test files are included: a test
  // passes an environment record instead of reading the process.
  {
    name: "rules/arch-002",
    files: SRC,
    ignores: CONFIG_DIR,
    rules: {
      "no-restricted-syntax": ["error", ...dangerSelectors, ...processEnvSelectors],
      "no-restricted-imports": ["error", { paths: processModulePaths }],
      "no-restricted-globals": ["error", ...processGlobal],
    },
  },

  // ARCH-004: all of src/lib, test files included. It does not name
  // no-restricted-globals, so the `process` ban of rules/arch-002 stays in force
  // here, and src/lib/config stays free of it.
  {
    name: "rules/arch-004",
    files: LIB,
    rules: {
      "no-restricted-imports": restrictedImports({ processModule: true }),
      "boundaries/resolved-imports": resolvedImports({ pure: false }),
      "no-restricted-syntax": [
        "error",
        ...dangerSelectors,
        ...processEnvSelectors,
        ...appLayerLoadSelectors,
      ],
    },
  },

  // CODE-001, CODE-002: all of src/lib, test files included.
  {
    name: "rules/code-001-code-002",
    files: LIB_TYPED,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },

  // src/lib/config is the one reader of the environment (ARCH-002 does not
  // apply), but it is still part of src/lib (ARCH-004 does).
  {
    name: "rules/config-dir",
    files: CONFIG_DIR,
    rules: {
      "no-restricted-imports": restrictedImports({ processModule: false }),
      "boundaries/resolved-imports": resolvedImports({ pure: false }),
      "no-restricted-syntax": ["error", ...dangerSelectors, ...appLayerLoadSelectors],
    },
  },

  // ARCH-001: the pure directories, test files included.
  {
    name: "rules/arch-001",
    files: PURE_DIRS,
    rules: {
      "no-restricted-imports": restrictedImports({ processModule: true, pure: true }),
      "boundaries/resolved-imports": resolvedImports({ pure: true }),
      "no-restricted-globals": [
        "error",
        ...processGlobal,
        ...NETWORK_GLOBALS.map((name) => ({ name, message: ARCH_001_GLOBAL })),
      ],
      "no-restricted-syntax": [
        "error",
        ...dangerSelectors,
        ...processEnvSelectors,
        ...pureSelectors,
      ],
    },
  },

  // Must stay last: switches off every rule that would fight Prettier.
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated output of the test and quality tooling:
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    ".scannerwork/**",
  ]),
]);

export default eslintConfig;
