/**
 * The checks behind every rule in rules.yaml that is enforced by scripts/rules-check.mjs.
 *
 * Every check is a pure function: a source (path plus content) or a read-only repository view
 * goes in, violations come out. Nothing here touches the file system, so each rule is unit-tested
 * with inline fixtures (tests/rules-check/). A check whose subject does not exist yet returns
 * nothing: the rules for API routes, Redis, the runner and the AI module pass vacuously today and
 * start to bite the moment those files appear.
 *
 * Path conventions the checks rely on (they are part of the rules, see the `check` hints in
 * rules.yaml): the Redis key builder is src/lib/redis/keys.ts, the Redis adapters live in
 * src/lib/redis/adapters/, the model id lives in src/lib/ai/model.ts, the policy builder is
 * src/lib/security/csp.ts, a bypass-guard test has "bypass-guard" in its file name, the Vitest
 * setup file that blocks real network calls is tests/setup/network-guard.setup.ts, the suites
 * that rules.yaml names as an enforcer are GUARD_SUITES, and the blocks of eslint.config.* that
 * may name a governed rule are GOVERNED_ESLINT_BLOCKS.
 */
import {
  bracePairs,
  findImports,
  isPackage,
  isUnder,
  lineOf,
  matchingBracket,
  resolveImport,
  scanSource,
  splitTopLevel,
} from "./text.mjs";

/**
 * @typedef {import("./schema.mjs").Violation} Violation
 * @typedef {import("./schema.mjs").ListedExclusion} ListedExclusion
 * @typedef {import("./text.mjs").Comment} Comment
 * @typedef {import("./text.mjs").ImportRef} ImportRef
 * @typedef {{
 *   path: string,
 *   content: string,
 *   readonly code: string,
 *   readonly comments: Comment[],
 *   readonly imports: ImportRef[],
 * }} Source
 * @typedef {{
 *   exists: (path: string) => boolean,
 *   read: (path: string) => string | null,
 *   list: (dir: string) => string[],
 * }} RepoView
 * @typedef {{
 *   routeMaxLines: number,
 *   coverageMin: { lines: number, branches: number },
 *   exclusions: ListedExclusion[] | null,
 *   skipDirs: readonly string[],
 * }} CheckContext
 * @typedef {{ tool: string, pattern: string, path: string, line: number }} ConfiguredExclusion
 */

export const KEY_BUILDER = "src/lib/redis/keys.ts";
export const REDIS_DIR = "src/lib/redis";
export const REDIS_ADAPTER_DIR = "src/lib/redis/adapters";
export const MODEL_MODULE = "src/lib/ai/model.ts";
export const CSP_MODULE = "src/lib/security/csp.ts";
export const PROXY_MODULE = "src/proxy.ts";
export const RUNNER_DIR = "src/lib/runner";
export const ESLINT_CONFIGS = ["eslint.config.mjs", "eslint.config.js", "eslint.config.ts"];
export const VITEST_CONFIGS = [
  "vitest.config.mts",
  "vitest.config.ts",
  "vitest.config.mjs",
  "vitest.config.js",
];
export const NEXT_CONFIGS = ["next.config.ts", "next.config.mjs", "next.config.js"];
export const SONAR_PROPERTIES = "sonar-project.properties";
/** Directories that must never execute SQL, so they never load a Postgres engine (SEC-004). */
export const SERVER_DIRS = ["src/app/api", "src/lib/ai", "src/lib/redis", "src/lib/store"];
/**
 * The one library directory that may load a Postgres engine (SEC-004). src/lib/runner is not in
 * this list on purpose: nothing stops server code from importing the runner, so a runner that
 * held an engine would put user SQL one import away from a route handler. The runner takes the
 * SqlEngine port as a parameter (`import type`); its integration tests are test files.
 */
export const ENGINE_DIRS = ["src/lib/engine"];
/** The Vitest setup file that blocks real network calls at run time (TEST-001). */
export const NETWORK_GUARD_SETUP = "tests/setup/network-guard.setup.ts";
export const PACKAGE_JSON = "package.json";
/** A route handler that imports from these uses Redis (REDIS-002). */
export const REDIS_USING_DIRS = ["src/lib/redis", "src/lib/ai", "src/lib/store"];

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(^|\/)(__snapshots__|__mocks__|__fixtures__|fixtures)\//;
const ROUTE_FILE = /^src\/app\/(.+\/)?route\.[cm]?[jt]sx?$/;
/**
 * The files of the App Router that Next.js hands `params` (and a page `searchParams`), to the
 * component and to `generateMetadata` / `generateViewport` alike: page, layout, template, default
 * and the metadata image files. The visitor chooses both, exactly as with a route handler.
 */
const SEGMENT_FILE =
  /^src\/app\/(.+\/)?(?:page|layout|template|default|icon|apple-icon|opengraph-image|twitter-image)\.[cm]?[jt]sx?$/;
const BINARY_FILE =
  /\.(ico|png|jpe?g|gif|webp|avif|bmp|woff2?|ttf|otf|eot|wasm|data|zip|gz|tgz|br|pdf|mp4|webm|mp3|tsbuildinfo)$/i;

/** @param {string} path */
export const isCodeFile = (path) => CODE_FILE.test(path);
/** @param {string} path */
export const isTestFile = (path) =>
  TEST_FILE.test(path) ||
  TEST_DIR.test(path) ||
  path.startsWith("tests/") ||
  path.startsWith("e2e/");
/** @param {string} path */
export const isRouteFile = (path) => ROUTE_FILE.test(path);
/** @param {string} path */
export const isSegmentFile = (path) => SEGMENT_FILE.test(path);
/** @param {string} path */
export const isBinaryFile = (path) => BINARY_FILE.test(path);
/** @param {string} path */
const isProductCode = (path) => path.startsWith("src/") && isCodeFile(path) && !isTestFile(path);
/** @param {string} path */
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A real environment file: `.env` or `.env.<anything>` except `.env.example`. The script never
 * reads one, it only ever looks at the name.
 * @param {string} path
 */
export function isEnvFile(path) {
  const name = baseName(path);
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

/**
 * Wraps a file for the checks. Comments and imports are computed once, on first use.
 * @param {string} path repo-relative, POSIX separators
 * @param {string} content
 * @returns {Source}
 */
export function makeSource(path, content) {
  /** @type {import("./text.mjs").ScannedSource | null} */
  let scanned = null;
  /** @type {ImportRef[] | null} */
  let imports = null;
  const scan = () => {
    scanned ??= isCodeFile(path) ? scanSource(content) : { code: content, comments: [] };
    return scanned;
  };
  return {
    path,
    content,
    get code() {
      return scan().code;
    },
    get comments() {
      return scan().comments;
    },
    get imports() {
      imports ??= isCodeFile(path) ? findImports(scan().code) : [];
      return imports;
    },
  };
}

/**
 * One violation per match of `pattern` in `text`.
 * @param {string} rule
 * @param {string} path
 * @param {string} text
 * @param {RegExp} pattern a global regular expression
 * @param {(match: RegExpMatchArray) => string | null} message null skips the match
 * @returns {Violation[]}
 */
function eachMatch(rule, path, text, pattern, message) {
  /** @type {Violation[]} */
  const violations = [];
  for (const match of text.matchAll(pattern)) {
    const textOfMessage = message(match);
    if (textOfMessage !== null) {
      violations.push({ rule, path, line: lineOf(text, match.index), message: textOfMessage });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// ARCH-003: route handlers are thin
// ---------------------------------------------------------------------------------------------

/**
 * @param {Source} source
 * @param {number} maxLines
 * @returns {Violation[]}
 */
export function checkRouteLength(source, maxLines) {
  if (!isRouteFile(source.path)) return [];
  const lines = source.content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxLines) return [];
  return [
    {
      rule: "ARCH-003",
      path: source.path,
      line: maxLines + 1,
      message: `route handler has ${lines.length} lines, the limit is ${maxLines}: parse, call src/lib, respond, and move everything else into src/lib`,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// CODE-003: TypeScript strict mode stays on
// ---------------------------------------------------------------------------------------------

const STRICT_FAMILY = [
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

/**
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkTsconfigStrict(source) {
  if (source.path !== "tsconfig.json") return [];
  const { path, content } = source;
  /** @param {string} key */
  const lineOfKey = (key) => {
    const index = content.indexOf(`"${key}"`);
    return index === -1 ? 1 : lineOf(content, index);
  };
  /** @type {unknown} */
  let parsed;
  try {
    // tsconfig.json is JSON with comments and trailing commas.
    parsed = JSON.parse(scanSource(content).code.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return [{ rule: "CODE-003", path, line: 1, message: "tsconfig.json cannot be parsed" }];
  }
  const options =
    typeof parsed === "object" && parsed !== null
      ? /** @type {Record<string, unknown>} */ (
          /** @type {Record<string, unknown>} */ (parsed).compilerOptions ?? {}
        )
      : {};
  /** @type {Violation[]} */
  const violations = [];
  if (options.strict !== true) {
    violations.push({
      rule: "CODE-003",
      path,
      line: lineOfKey("strict"),
      message: "compilerOptions.strict must be true: TypeScript strict mode stays on",
    });
  }
  for (const flag of STRICT_FAMILY) {
    if (options[flag] === false) {
      violations.push({
        rule: "CODE-003",
        path,
        line: lineOfKey(flag),
        message: `compilerOptions.${flag} is switched off, which takes a part of strict mode away`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// SEC-001: nothing is rendered as HTML
// ---------------------------------------------------------------------------------------------

const HTML_SINKS = [
  { pattern: /\bdangerouslySetInnerHTML\s*[=:]/g, name: "dangerouslySetInnerHTML" },
  {
    pattern: /\.\s*(?:innerHTML|outerHTML)\s*=(?!=)/g,
    name: "an innerHTML or outerHTML assignment",
  },
  { pattern: /\.\s*insertAdjacentHTML\s*\(/g, name: "insertAdjacentHTML" },
  { pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/g, name: "document.write" },
];

/**
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkHtmlSinks(source) {
  if (!source.path.startsWith("src/") || !isCodeFile(source.path)) return [];
  return HTML_SINKS.flatMap(({ pattern, name }) =>
    eachMatch(
      "SEC-001",
      source.path,
      source.code,
      pattern,
      () =>
        `${name} is forbidden: scenario text and query results are rendered as text, never as HTML`,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// SEC-002: external input is validated with zod
// ---------------------------------------------------------------------------------------------

/** `"use client"` as the first statement of the file: the module is a Client Component boundary. */
const USE_CLIENT_FILE = /^\s*(["'`])use client\1/;
/** `"use server"` as a statement, at the top of the file or of a function body: a Server Function. */
const USE_SERVER = /(?:^|[{;\n])\s*(["'`])use server\1/;
/** The opening bracket of the parameter list of an async function, method or arrow. */
const ASYNC_PARAMETERS =
  /\basync\b\s*(?:function\b\s*\*?\s*[\w$]*\s*|(?!function\b)[\w$]+\s*)?(?:<[^>()]*>\s*)?\(/g;
/** `async value => …`: one parameter without brackets. */
const ASYNC_SINGLE_PARAMETER = /\basync\s+(?!function\b)[\w$]+\s*=>/;

/**
 * A Server Function is an HTTP endpoint: whoever calls it chooses every argument, a FormData
 * included, whatever the TypeScript signature says. The index of the "use server" directive when
 * the file has one and an async function that takes anything, otherwise -1. A file whose Server
 * Functions take no argument reads no input.
 * @param {string} code
 */
function serverFunctionInput(code) {
  const directive = USE_SERVER.exec(code);
  if (directive === null) return -1;
  const at = directive.index + directive[0].indexOf("use server") - 1;
  if (ASYNC_SINGLE_PARAMETER.test(code)) return at;
  for (const match of code.matchAll(ASYNC_PARAMETERS)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(code, open);
    if (close === -1 || code.slice(open + 1, close).trim() !== "") return at;
  }
  return -1;
}

const INPUT_READS = [
  {
    pattern: /\.\s*(?:json|formData|text|arrayBuffer|blob|bytes)\s*\(\s*\)/,
    name: "a request or response body",
  },
  // formData.get("sql"), url.searchParams.getAll("id"), Object.fromEntries(formData)
  {
    pattern:
      /(?<![\w$])[\w$]*(?:formData|FormData|searchParams|SearchParams)\s*\.\s*(?:get|getAll|entries|values)\s*\(|\bfromEntries\s*\(\s*[\w$.]*(?:formData|FormData|searchParams|SearchParams)\b/,
    name: "form data or query parameters",
  },
  { pattern: /\bJSON\s*\.\s*parse\s*\(/, name: "JSON.parse" },
  { pattern: /\b(?:localStorage|sessionStorage)\s*\.\s*getItem\s*\(/, name: "browser storage" },
  // request.headers.get("x"), (await headers()).get("x"), headers().get("x")
  {
    pattern: /\.\s*headers\s*\.\s*get\s*\(|\bheaders\s*\(\s*\)\s*\)?\s*\.\s*get\s*\(/,
    name: "a request or response header",
  },
  // request.cookies.get("x"), (await cookies()).get("x"), document.cookie
  {
    pattern:
      /\.\s*cookies\s*\.\s*get\s*\(|\bcookies\s*\(\s*\)\s*\)?\s*\.\s*get\s*\(|\bdocument\s*\.\s*cookie\b/,
    name: "a cookie",
  },
];
/**
 * In a route handler and in a segment file (isSegmentFile) the bare words count: `params` and
 * `searchParams` are handed in by Next.js under exactly these names, and the visitor chooses them.
 */
const ROUTE_INPUT_READS = [
  { pattern: /\bsearchParams\b/, name: "query parameters" },
  { pattern: /\bparams\b/, name: "route parameters" },
];
const ZOD_PARSE =
  /(?<!\b(?:JSON|Date|URL|Number|path|qs|querystring)\s*)\.\s*(?:safeParse|parse|safeParseAsync|parseAsync)\s*\(/;
const VALIDATOR_NAME = /^(?:parse|validate|safeParse)(?![a-z])(?!Int$|Float$)/;

/**
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkInputValidation(source) {
  const { path, code } = source;
  if (!isProductCode(path)) return [];
  const reads =
    isRouteFile(path) || isSegmentFile(path) ? [...INPUT_READS, ...ROUTE_INPUT_READS] : INPUT_READS;
  const hits = reads.flatMap((read) => {
    const match = read.pattern.exec(code);
    return match === null ? [] : [{ name: read.name, index: match.index }];
  });
  const serverFunction = serverFunctionInput(code);
  if (serverFunction !== -1) {
    hits.push({
      name: 'the arguments of a Server Function ("use server": the caller chooses every argument, a FormData included, whatever the signature says)',
      index: serverFunction,
    });
  }
  const hit = hits.sort((a, b) => a.index - b.index)[0];
  if (hit === undefined) return [];
  if (ZOD_PARSE.test(code)) return [];
  const callsLibValidator = source.imports.some(
    (ref) =>
      !ref.typeOnly &&
      isUnder(resolveImport(path, ref.specifier), "src/lib") &&
      ref.names.some(
        (name) => VALIDATOR_NAME.test(name) && new RegExp(`\\b${name}\\s*\\(`).test(code),
      ),
  );
  if (callsLibValidator) return [];
  return [
    {
      rule: "SEC-002",
      path,
      line: lineOf(code, hit.index),
      message: `reads ${hit.name} without validating it: parse it with a zod schema (safeParse or parse) or call a parse* / validate* function from src/lib`,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// SEC-003: no secrets in the repository
// ---------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  { name: "an Anthropic API key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "a Supabase access token", pattern: /\bsbp_[A-Za-z0-9]{32,}/g },
  { name: "a Supabase secret key", pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  {
    name: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g,
  },
  { name: "a SonarQube token", pattern: /\bsq[upa]_[a-f0-9]{40}\b/g },
  { name: "a private key block", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
];
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.(eyJ[A-Za-z0-9_-]{5,})\.[A-Za-z0-9_-]{5,}/g;
const REDIS_URL_WITH_PASSWORD = /\brediss?:\/\/([^\s:@/'"`]*):([^\s@/'"`]+)@([^\s/:'"`?#]+)/g;
const PLACEHOLDER_PASSWORD =
  /^(?:[<[{$%].*|\*+|x+|\.+|password|passwd|pass|secret|changeme|redacted|your[-_\w]*)$/i;
/** Loopback, and the names RFC 2606 and RFC 6761 reserve: no real credential can belong to one. */
const RESERVED_HOST =
  /^(?:127\.0\.0\.1|(?:.+\.)?(?:localhost|example|test|invalid)|(?:.+\.)?example\.(?:com|org|net))$/i;

/** @param {string} payload base64url */
function jwtPayloadText(payload) {
  try {
    return Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Looks for strings that have the shape of a credential. The message names the kind and never
 * repeats the value.
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkSecrets(source) {
  const { path, content } = source;
  if (isBinaryFile(path) || isEnvFile(path)) return [];
  const violations = SECRET_PATTERNS.flatMap(({ name, pattern }) =>
    eachMatch(
      "SEC-003",
      path,
      content,
      pattern,
      () => `looks like ${name}: remove it and rotate it`,
    ),
  );
  violations.push(
    ...eachMatch("SEC-003", path, content, JWT, (match) =>
      jwtPayloadText(match[1] ?? "").includes("service_role")
        ? "looks like a Supabase service_role JWT: remove it and rotate it"
        : null,
    ),
    ...eachMatch("SEC-003", path, content, REDIS_URL_WITH_PASSWORD, (match) =>
      PLACEHOLDER_PASSWORD.test(match[2] ?? "") || RESERVED_HOST.test(match[3] ?? "")
        ? null
        : "looks like a Redis URL with a password: remove it, or use a placeholder such as <password>",
    ),
  );
  return violations.sort((a, b) => a.line - b.line);
}

/**
 * `.env.example` documents the variables and carries no values.
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkEnvExample(source) {
  if (baseName(source.path) !== ".env.example") return [];
  /** @type {Violation[]} */
  const violations = [];
  source.content.split("\n").forEach((text, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(text);
    if (match === null) return;
    const value = (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "" && !value.startsWith("#")) {
      violations.push({
        rule: "SEC-003",
        path: source.path,
        line: index + 1,
        message: `${match[1]} has a value: .env.example documents variables and leaves every value empty`,
      });
    }
  });
  return violations;
}

/**
 * @param {readonly string[]} trackedPaths paths git tracks or has staged
 * @returns {Violation[]}
 */
export function checkTrackedEnvFiles(trackedPaths) {
  return trackedPaths.filter(isEnvFile).map((path) => ({
    rule: "SEC-003",
    path,
    line: 1,
    message: "an environment file is tracked by git: only .env.example belongs in the repository",
  }));
}

// ---------------------------------------------------------------------------------------------
// SEC-004: the server never executes user SQL
// ---------------------------------------------------------------------------------------------

const SQL_ENGINE_PACKAGES = [
  "@electric-sql/pglite",
  "pg",
  "pg-pool",
  "pg-promise",
  "pg-native",
  "postgres",
  "@vercel/postgres",
  "@neondatabase/serverless",
];

/**
 * Where a value import of a Postgres engine is allowed, as an allow-list: the engine directory
 * (ENGINE_DIRS) and client-side modules, which say so with a file-level "use client". Everything
 * else under src/ is refused, and three places are refused whatever else is true: a route
 * handler, the server directories, and any file with a "use server" directive.
 *
 * The list is closed under imports, which is what makes it a proof and not a sample: a module
 * that may hold an engine is either under src/lib/engine, and importing anything from there is
 * itself refused outside the list, or it is a "use client" module, of which the server only ever
 * gets a reference it cannot call. So no chain of value imports leads from server code to an
 * engine, however many hops it has. src/lib/runner is outside the list for exactly that reason.
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkServerSqlEngines(source) {
  const { path, code } = source;
  if (!isProductCode(path)) return [];
  const serverAction = USE_SERVER.test(code);
  const serverPlace = isRouteFile(path) || SERVER_DIRS.some((dir) => isUnder(path, dir));
  const allowed =
    !serverAction &&
    !serverPlace &&
    (ENGINE_DIRS.some((dir) => isUnder(path, dir)) || USE_CLIENT_FILE.test(code));
  if (allowed) return [];
  /** @type {Violation[]} */
  const violations = [];
  for (const ref of source.imports) {
    if (ref.typeOnly) continue;
    const engine = SQL_ENGINE_PACKAGES.find((name) => isPackage(ref.specifier, name));
    const viaEngineDir = isUnder(resolveImport(path, ref.specifier), "src/lib/engine");
    if (engine === undefined && !viaEngineDir) continue;
    /** @type {string} */
    let message;
    if (serverAction) {
      message = `a file with a "use server" directive imports ${ref.specifier}: a Server Function runs on the server, and the server never loads a Postgres engine or executes user SQL`;
    } else if (serverPlace) {
      message = `server code imports ${ref.specifier}: user SQL runs only in the browser, the server never loads a Postgres engine`;
    } else {
      message = `${ref.specifier} is imported outside the places that may load a Postgres engine (${ENGINE_DIRS.join(", ")}, a module that starts with "use client", a test): without the directive this module can run on the server. Use a type-only import, or mark the client module with "use client"`;
      if (isUnder(path, RUNNER_DIR)) {
        message += `. ${RUNNER_DIR} never holds an engine, because server code may import the runner: take the SqlEngine port as a parameter and let a "use client" module or the worker in src/lib/engine pass the engine in`;
      }
    }
    violations.push({ rule: "SEC-004", path, line: ref.line, message });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// SEC-005: the strict production CSP and the security headers stay on
// ---------------------------------------------------------------------------------------------

const DIRECTIVE_TOKEN = /["'`]([a-z]+-src(?:-elem|-attr)?)["'`]|\b(scriptSrc|styleSrc)\w*/g;

/**
 * True when the statement that holds `index` is guarded by a positive `isDev` test: either an
 * enclosing `if (… isDev …) {` block or a ternary / `&&` on the same statement.
 * @param {string} code
 * @param {number} index
 */
function isDevGuarded(code, index) {
  /** @param {string} header */
  const positiveDevTest = (header) =>
    /\bisDev\b/.test(header) &&
    !/!\s*(?:[\w$.]+\.)?isDev\b/.test(header) &&
    !/\bisDev\s*(?:===?\s*false|!==?\s*true)/.test(header);
  /** @param {number} position */
  const statementStart = (position) => {
    for (let i = position - 1; i >= 0; i -= 1) {
      if (code[i] === ";" || code[i] === "{" || code[i] === "}") return i + 1;
    }
    return 0;
  };
  const ownStatement = code.slice(statementStart(index), index);
  if (/\bisDev\s*(?:\?|&&)/.test(ownStatement) && positiveDevTest(ownStatement)) return true;
  /** @type {boolean[]} */
  const blocks = [];
  for (let i = 0; i < index; i += 1) {
    if (code[i] === "{") {
      const header = code.slice(statementStart(i), i);
      blocks.push(/\bif\s*\(/.test(header) && !/\belse\b/.test(header) && positiveDevTest(header));
    } else if (code[i] === "}") {
      blocks.pop();
    }
  }
  return blocks.includes(true);
}

/**
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkCspPolicy(source) {
  const { path, code } = source;
  if (path === PROXY_MODULE || NEXT_CONFIGS.includes(path)) {
    return eachMatch(
      "SEC-005",
      path,
      code,
      /'unsafe-(?:eval|inline|hashes)'/g,
      (match) => `${match[0]} written outside ${CSP_MODULE}: every policy is built there`,
    );
  }
  if (path !== CSP_MODULE) return [];
  const evalViolations = eachMatch("SEC-005", path, code, /'unsafe-eval'/g, (match) =>
    isDevGuarded(code, match.index ?? 0)
      ? null
      : "'unsafe-eval' outside an `if (isDev)` guard: the production policy must never allow it",
  );
  const inlineViolations = eachMatch("SEC-005", path, code, /'unsafe-inline'/g, (match) => {
    const before = [...code.slice(0, match.index ?? 0).matchAll(DIRECTIVE_TOKEN)].pop();
    const directive = before?.[1] ?? before?.[2] ?? "";
    return /^style/i.test(directive)
      ? null
      : `'unsafe-inline' next to ${directive === "" ? "an unknown directive" : directive}: it is tolerated for style-src only, never for scripts`;
  });
  return [...evalViolations, ...inlineViolations].sort((a, b) => a.line - b.line);
}

/**
 * @param {RepoView} repo
 * @returns {Violation[]}
 */
export function checkSecurityWiring(repo) {
  const nextConfig = NEXT_CONFIGS.find((path) => repo.exists(path));
  if (!repo.exists(CSP_MODULE)) {
    if (!repo.exists(PROXY_MODULE) && nextConfig === undefined) return [];
    return [
      { rule: "SEC-005", path: CSP_MODULE, line: 1, message: "the policy builder is missing" },
    ];
  }
  /** @type {Violation[]} */
  const violations = [];
  if (!/\bbuildDocumentCsp\s*\(/.test(scanSource(repo.read(PROXY_MODULE) ?? "").code)) {
    violations.push({
      rule: "SEC-005",
      path: PROXY_MODULE,
      line: 1,
      message: "the proxy must set the document policy with buildDocumentCsp() on every response",
    });
  }
  const nextConfigCode = scanSource(
    nextConfig === undefined ? "" : (repo.read(nextConfig) ?? ""),
  ).code;
  if (!/\bbuildStaticSecurityHeaders\s*\(/.test(nextConfigCode)) {
    violations.push({
      rule: "SEC-005",
      path: nextConfig ?? "next.config.ts",
      line: 1,
      message: "next.config must send buildStaticSecurityHeaders() on every path",
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// RUN-001: the bypass-guard tests exist once the runner exists
// ---------------------------------------------------------------------------------------------

const BYPASS_GUARD_TEST = /bypass[-_]?guard[^/]*\.test\.[cm]?tsx?$/i;
const DISABLED_TEST =
  /\b(?:describe|it|test)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\b|\bx(?:it|describe|test)\s*\(/g;

/**
 * @param {RepoView} repo
 * @returns {Violation[]}
 */
export function checkBypassGuards(repo) {
  const runnerFiles = repo.list(RUNNER_DIR);
  if (!runnerFiles.some((path) => isCodeFile(path) && !isTestFile(path))) return [];
  const guards = [...runnerFiles, ...repo.list("tests")].filter((path) =>
    BYPASS_GUARD_TEST.test(path),
  );
  if (guards.length === 0) {
    return [
      {
        rule: "RUN-001",
        path: RUNNER_DIR,
        line: 1,
        message:
          "the runner exists but no bypass-guard test does: add a *bypass-guard*.test.ts under src/lib/runner or tests/ that proves probes never run as a superuser, an owner or a BYPASSRLS role",
      },
    ];
  }
  return guards.flatMap((path) =>
    suiteProblems("RUN-001", path, repo.read(path) ?? "", "bypass-guard"),
  );
}

/**
 * What switches a suite off from the inside: `.skip`, `.todo`, `.only` and friends, or no test at
 * all.
 * @param {string} rule
 * @param {string} path
 * @param {string} content
 * @param {string} what names the suite in the message
 * @returns {Violation[]}
 */
function suiteProblems(rule, path, content, what) {
  const code = scanSource(content).code;
  const problems = eachMatch(
    rule,
    path,
    code,
    DISABLED_TEST,
    (match) => `${match[0].replace(/\s+/g, "")} switches a ${what} test off or narrows the suite`,
  );
  if (!/\b(?:it|test)\s*(?:\.\s*each\s*\([^)]*\)\s*)?\(/.test(code)) {
    problems.push({ rule, path, line: 1, message: `the ${what} suite has no test` });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// TEST-001: no real network or model calls in tests
// ---------------------------------------------------------------------------------------------

const URL_LITERAL = String.raw`(?:https?|wss?):\/\/[^"'\`\s]*`;
/** The callee and the opening bracket of something that talks to the network. */
const NETWORK_CALL_HEAD = String.raw`\b(?:fetch|goto|axios(?:\s*\.\s*\w+)?|request\s*\.\s*(?:get|post|put|patch|delete|head|fetch)|https?\s*\.\s*(?:request|get)|new\s+(?:WebSocket|EventSource))\s*\(\s*(?:new\s+URL\s*\(\s*)?`;
/** `const BASE = "https://…"`, also wrapped in `new URL(`, with or without a type annotation. */
const URL_CONSTANT = new RegExp(
  String.raw`\b(?:const|let|var)\s+([\w$]+)(?:\s*:\s*[\w$.]+)?\s*=\s*(?:new\s+URL\s*\(\s*)?["'\`](${URL_LITERAL})["'\`]`,
  "g",
);
const LOOPBACK_URL =
  /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/?#]|$)/i;
const MODEL_PROVIDERS = ["@ai-sdk/anthropic", "@anthropic-ai/sdk"];
const LIVE_TEST_GUARD = /RUN_LIVE_AI_TESTS|runLiveAiTests/;
/**
 * A write to the live switch: `process.env.RUN_LIVE_AI_TESTS = …`, `env["RUN_LIVE_AI_TESTS"] ||= …`,
 * `vi.stubEnv("RUN_LIVE_AI_TESTS", …)`, `Object.assign(process.env, { RUN_LIVE_AI_TESTS: … })`.
 * Reading it (`=== "1"`) and handing it to a child process as a property are not writes.
 */
const LIVE_SWITCH_WRITES = [
  /(?:\.\s*|\[\s*["'`])RUN_LIVE_AI_TESTS(?:["'`]\s*\])?\s*(?:=(?![=>])|\?\?=|\|\|=|&&=)/g,
  /\bstubEnv\s*\(\s*["'`]RUN_LIVE_AI_TESTS["'`]/g,
  /\bObject\s*\.\s*assign\s*\(\s*process\s*\.\s*env\b[^;]*?\bRUN_LIVE_AI_TESTS\b/g,
];
const LIVE_SWITCH_WRITTEN =
  "a test file sets RUN_LIVE_AI_TESTS: the switch that lets tests reach a real host belongs to whoever starts the run (RUN_LIVE_AI_TESTS=1 npm test), never to the code under test";
const REAL_ADDRESS =
  "a test reaches a real network address: tests are hermetic, mock the call or use a loopback URL";

/**
 * The static, fast layer of TEST-001. It sees a URL literal handed to a network call, directly, as
 * `new URL("…")`, or through a constant of the same file (`fetch(BASE)`, `fetch(BASE + "/v1")`,
 * `` fetch(`${BASE}/v1`) ``). An address assembled at run time is not visible to it; the Vitest
 * setup file NETWORK_GUARD_SETUP blocks that one when the test runs.
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkTestIsolation(source) {
  const { path, code } = source;
  if (!isTestFile(path) || !isCodeFile(path)) return [];
  const literalCall = new RegExp(`${NETWORK_CALL_HEAD}["'\`](${URL_LITERAL})`, "g");
  const violations = eachMatch("TEST-001", path, code, literalCall, (match) =>
    LOOPBACK_URL.test(match[1] ?? "") ? null : REAL_ADDRESS,
  );
  const remoteConstants = [...code.matchAll(URL_CONSTANT)]
    .filter((match) => !LOOPBACK_URL.test(match[2] ?? ""))
    .map((match) => (match[1] ?? "").replace(/\$/g, String.raw`\$`));
  if (remoteConstants.length > 0) {
    const names = `(?:${[...new Set(remoteConstants)].join("|")})`;
    const constantCall = new RegExp(
      `${NETWORK_CALL_HEAD}(?:\`\\$\\{\\s*${names}\\b|${names}(?![\\w$]))`,
      "g",
    );
    violations.push(
      ...eachMatch(
        "TEST-001",
        path,
        code,
        constantCall,
        () => `${REAL_ADDRESS} (the URL comes from a constant of this file)`,
      ),
    );
  }
  for (const pattern of LIVE_SWITCH_WRITES) {
    violations.push(...eachMatch("TEST-001", path, code, pattern, () => LIVE_SWITCH_WRITTEN));
  }
  for (const ref of source.imports) {
    const provider = MODEL_PROVIDERS.find((name) => isPackage(ref.specifier, name));
    if (provider === undefined || ref.typeOnly) continue;
    const mocked = new RegExp(`\\bvi\\s*\\.\\s*(?:mock|doMock)\\s*\\(\\s*["'\`]${provider}["'\`]`);
    if (mocked.test(code) || LIVE_TEST_GUARD.test(code)) continue;
    violations.push({
      rule: "TEST-001",
      path,
      line: ref.line,
      message: `a test imports the real model provider ${provider}: mock it, or put the test behind RUN_LIVE_AI_TESTS=1`,
    });
  }
  return violations.sort((a, b) => a.line - b.line);
}

const INSTALL_WITH_PROCESS_ENV = /^installNetworkGuard\s*\(\s*process\s*\.\s*env\s*\)/;

/**
 * The run-time layer of TEST-001 stays wired: vitest.config registers the network guard as a setup
 * file and does not set the live switch itself, and the setup file still installs the guard, with
 * `process.env` and nothing else as the record the switch is read from.
 * @param {RepoView} repo
 * @returns {Violation[]}
 */
export function checkNetworkGuardWired(repo) {
  const configPath = VITEST_CONFIGS.find((path) => repo.exists(path));
  if (configPath === undefined) return [];
  /** @type {Violation[]} */
  const violations = [];
  const configText = repo.read(configPath) ?? "";
  const config = parseVitestConfig(configText);
  violations.push(
    ...eachMatch(
      "TEST-001",
      configPath,
      scanSource(configText).code,
      /\bRUN_LIVE_AI_TESTS\b/g,
      () =>
        "the Vitest configuration names RUN_LIVE_AI_TESTS: the live switch comes from the environment of whoever starts the run, the configuration never sets it",
    ),
  );
  const registered = config.setupFiles.some(
    (entry) => entry.pattern.replace(/^\.\//, "") === NETWORK_GUARD_SETUP,
  );
  if (!registered) {
    violations.push({
      rule: "TEST-001",
      path: configPath,
      line: config.setupFiles[0]?.line ?? 1,
      message: `test.setupFiles must contain "./${NETWORK_GUARD_SETUP}": it blocks real network calls from tests at run time`,
    });
  }
  const setup = repo.read(NETWORK_GUARD_SETUP);
  if (setup === null) {
    violations.push({
      rule: "TEST-001",
      path: NETWORK_GUARD_SETUP,
      line: 1,
      message: "the network guard setup file is missing",
    });
  } else {
    const code = scanSource(setup).code;
    for (const call of ["installNetworkGuard", "failOnBlockedAttempts"]) {
      if (!new RegExp(`\\b${call}\\s*\\(`).test(code)) {
        violations.push({
          rule: "TEST-001",
          path: NETWORK_GUARD_SETUP,
          line: 1,
          message: `the network guard setup file no longer calls ${call}(): the guard is installed before every test file and fails a test that tried a real network call`,
        });
      }
    }
    violations.push(
      ...eachMatch("TEST-001", NETWORK_GUARD_SETUP, code, /\binstallNetworkGuard\s*\(/g, (match) =>
        INSTALL_WITH_PROCESS_ENV.test(code.slice(match.index ?? 0))
          ? null
          : "installNetworkGuard( must be called as installNetworkGuard(process.env): any other record could switch the guard off for every test",
      ),
    );
  }
  return violations;
}

/**
 * No npm script and no lint-staged command sets the live switch: `RUN_LIVE_AI_TESTS=1 vitest run`
 * as the test script would lift the network guard for every run, CI included.
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkLiveSwitchNotScripted(source) {
  const { path, content } = source;
  if (path !== PACKAGE_JSON) return [];
  const manifest = readManifest(content);
  if (manifest === null) return []; // QUAL-002 reports a package.json that cannot be parsed
  return manifestCommands(manifest)
    .filter((command) => /\bRUN_LIVE_AI_TESTS\s*=/.test(command))
    .map((command) => ({
      rule: "TEST-001",
      path,
      line: lineOfJsonText(content, command),
      message:
        "a script sets RUN_LIVE_AI_TESTS: live tests are started by hand (RUN_LIVE_AI_TESTS=1 npm test), no script lifts the network guard",
    }));
}

/**
 * @typedef {{ scripts?: Record<string, unknown>, "lint-staged"?: Record<string, unknown> }} Manifest
 * @param {string} content the text of package.json
 * @returns {Manifest | null}
 */
function readManifest(content) {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every command of `scripts` and `lint-staged`.
 * @param {Manifest} manifest
 * @returns {string[]}
 */
function manifestCommands(manifest) {
  return [
    ...Object.values(manifest.scripts ?? {}),
    ...Object.values(manifest["lint-staged"] ?? {}).flat(),
  ].filter((command) => typeof command === "string");
}

/**
 * The line of a string value inside JSON text.
 * @param {string} content
 * @param {string} text
 */
function lineOfJsonText(content, text) {
  const index = content.indexOf(JSON.stringify(text).slice(1, -1));
  return index === -1 ? 1 : lineOf(content, index);
}

// ---------------------------------------------------------------------------------------------
// TEST-002 and QUAL-001: what vitest.config says
// ---------------------------------------------------------------------------------------------

/**
 * The inside of the first `key: [` or `key: {` after `from`, with its position.
 * @param {string} code
 * @param {string} key
 * @param {"[" | "{"} open
 * @returns {{ inner: string, start: number, end: number } | null}
 */
function blockAfterKey(code, key, open) {
  const pattern = new RegExp(`(?<![\\w$.])${key}\\s*:\\s*\\${open}`, "g");
  const match = pattern.exec(code);
  if (match === null) return null;
  const openIndex = match.index + match[0].length - 1;
  const end = matchingBracket(code, openIndex);
  if (end === -1) return null;
  return { inner: code.slice(openIndex + 1, end), start: openIndex + 1, end };
}

/**
 * The elements of an array literal as written, string and template literals unquoted.
 * @param {string} code
 * @param {{ inner: string, start: number } | null} block
 * @param {(raw: string) => string[]} [resolve] expands identifiers and `${…}` placeholders
 * @returns {{ pattern: string, line: number }[]}
 */
function arrayElements(code, block, resolve) {
  if (block === null) return [];
  return splitTopLevel(block.inner).flatMap((part) => {
    const line = lineOf(code, block.start + part.index);
    const values = resolve ? resolve(part.text) : [unquote(part.text)];
    return values.map((pattern) => ({ pattern, line }));
  });
}

/** @param {string} raw */
function unquote(raw) {
  const match = /^(["'`])([\s\S]*)\1$/.exec(raw);
  return match ? (match[2] ?? "") : raw;
}

/**
 * `setupFiles: ["a", "b"]` or `setupFiles: "a"`.
 * @param {string} code
 * @returns {{ pattern: string, line: number }[]}
 */
function setupFilesOf(code) {
  const list = arrayElements(code, blockAfterKey(code, "setupFiles", "["));
  if (list.length > 0) return list;
  const single = /(?<![\w$.])setupFiles\s*:\s*(["'`])([^"'`\n]+)\1/.exec(code);
  return single === null ? [] : [{ pattern: single[2] ?? "", line: lineOf(code, single.index) }];
}

/**
 * @param {string} content the text of vitest.config.*
 */
export function parseVitestConfig(content) {
  const code = scanSource(content).code;
  const coverage = blockAfterKey(code, "coverage", "{");
  const coverageCode = coverage === null ? "" : coverage.inner;
  const coverageOffset = coverage === null ? 0 : coverage.start;
  /** @param {string} key */
  const coverageArray = (key) => {
    const block = blockAfterKey(coverageCode, key, "[");
    return arrayElements(code, block && { ...block, start: block.start + coverageOffset });
  };
  const outside =
    coverage === null
      ? code
      : code.slice(0, coverage.start) +
        coverage.inner.replace(/[^\n]/g, " ") +
        code.slice(coverage.end);

  /** @type {{ metric: string, value: number, line: number }[]} */
  const thresholds = [];
  const thresholdBlock = blockAfterKey(coverageCode, "thresholds", "{");
  if (thresholdBlock !== null) {
    const metric = /(?<![\w$])["']?(lines|branches)["']?\s*:\s*(-?\d+(?:\.\d+)?)/g;
    for (const match of thresholdBlock.inner.matchAll(metric)) {
      thresholds.push({
        metric: match[1] ?? "",
        value: Number(match[2]),
        line: lineOf(code, coverageOffset + thresholdBlock.start + match.index),
      });
    }
  }
  return {
    hasCoverage: coverage !== null,
    coverageLine: coverage === null ? 1 : lineOf(code, coverage.start),
    coverageInclude: coverageArray("include"),
    coverageExclude: coverageArray("exclude"),
    testInclude: arrayElements(outside, blockAfterKey(outside, "include", "[")),
    testExclude: arrayElements(outside, blockAfterKey(outside, "exclude", "[")),
    setupFiles: setupFilesOf(outside),
    thresholds,
  };
}

/**
 * @param {Source} source
 * @param {{ lines: number, branches: number }} minimum
 * @returns {Violation[]}
 */
export function checkCoverageThresholds(source, minimum) {
  if (!VITEST_CONFIGS.includes(source.path)) return [];
  const { path } = source;
  const config = parseVitestConfig(source.content);
  if (!config.hasCoverage) {
    return [{ rule: "TEST-002", path, line: 1, message: "the coverage block is missing" }];
  }
  /** @type {Violation[]} */
  const violations = [];
  if (!config.coverageInclude.some((entry) => entry.pattern === "src/lib/**")) {
    violations.push({
      rule: "TEST-002",
      path,
      line: config.coverageLine,
      message: 'coverage.include must contain "src/lib/**": the threshold covers the whole library',
    });
  }
  for (const metric of /** @type {const} */ (["lines", "branches"])) {
    const found = config.thresholds.filter((entry) => entry.metric === metric);
    if (found.length === 0) {
      violations.push({
        rule: "TEST-002",
        path,
        line: config.coverageLine,
        message: `coverage.thresholds.${metric} is missing, it must be at least ${minimum[metric]}`,
      });
    }
    for (const entry of found) {
      if (entry.value < minimum[metric]) {
        violations.push({
          rule: "TEST-002",
          path,
          line: entry.line,
          message: `coverage threshold ${metric}: ${entry.value} is below the required ${minimum[metric]}`,
        });
      }
    }
  }
  return violations;
}

/**
 * @param {RepoView} repo
 * @returns {Violation[]}
 */
export function checkCoverageConfigExists(repo) {
  if (VITEST_CONFIGS.some((path) => repo.exists(path))) return [];
  if (!repo.list("src/lib").some((path) => isCodeFile(path))) return [];
  return [
    {
      rule: "TEST-002",
      path: "vitest.config.mts",
      line: 1,
      message: "src/lib exists but no Vitest config enforces its coverage thresholds",
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// REDIS-001: one key builder, every write has a TTL
// ---------------------------------------------------------------------------------------------

const REDIS_WRITE =
  /\.\s*(set|setex|psetex|setnx|getset|mset|msetnx|hset|hmset|hsetnx|hincrby|incr|incrby|incrbyfloat|decr|decrby|append|lpush|rpush|sadd|zadd|pfadd|xadd)\s*\(/g;
const TTL_ARGUMENT = /["'`](?:PX|EX|PXAT|EXAT|KEEPTTL)["'`]/i;
const EXPIRE_EVIDENCE = /p?expire(?:at)?\b/i;
const LUA_WRITE =
  /redis\s*\.\s*p?call\s*\(\s*["'](SET|INCR|INCRBY|DECR|ZADD|HSET|HINCRBY|LPUSH|RPUSH|SADD|APPEND)["']/gi;

/**
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkRedisDiscipline(source) {
  const { path } = source;
  const isLua = path.endsWith(".lua");
  if (!path.startsWith("src/") || isTestFile(path) || (!isCodeFile(path) && !isLua)) return [];
  const code = source.code;
  /** @type {Violation[]} */
  const violations = [];

  if (path !== KEY_BUILDER) {
    violations.push(
      ...eachMatch(
        "REDIS-001",
        path,
        code,
        /rlsleak:/g,
        () =>
          `a literal "rlsleak:" key outside ${KEY_BUILDER}: every key comes from the key builder`,
      ),
    );
  }

  const inRedisDir = isUnder(path, REDIS_DIR);
  const importsIoredis = source.imports.some((ref) => isPackage(ref.specifier, "ioredis"));
  if (!inRedisDir) {
    for (const ref of source.imports) {
      if (isPackage(ref.specifier, "ioredis") && !ref.typeOnly) {
        violations.push({
          rule: "REDIS-001",
          path,
          line: ref.line,
          message: `ioredis imported outside ${REDIS_DIR}: use the ports, only the Redis adapters talk to the client`,
        });
      }
    }
    return violations;
  }

  const inAdapterDir = isUnder(path, REDIS_ADAPTER_DIR);
  if (!inAdapterDir) {
    violations.push(
      ...eachMatch(
        "REDIS-001",
        path,
        code,
        REDIS_WRITE,
        (match) =>
          `.${match[1]}( outside ${REDIS_ADAPTER_DIR}: writes belong in an adapter, where the contract tests check the TTL`,
      ),
    );
    return violations;
  }

  const hasExpire = EXPIRE_EVIDENCE.test(code) || TTL_ARGUMENT.test(code);
  if (importsIoredis) {
    for (const match of code.matchAll(REDIS_WRITE)) {
      const command = match[1] ?? "";
      const open = match.index + match[0].length - 1;
      const close = matchingBracket(code, open);
      const args = close === -1 ? "" : code.slice(open, close);
      const ttlInCall = command === "setex" || command === "psetex" || TTL_ARGUMENT.test(args);
      if (command === "set" ? !ttlInCall : !ttlInCall && !hasExpire) {
        violations.push({
          rule: "REDIS-001",
          path,
          line: lineOf(code, match.index),
          message:
            command === "set"
              ? '.set( without "PX" or "EX": every Redis key has a TTL'
              : `.${command}( in a file that never sets an expiry: every Redis key has a TTL`,
        });
      }
    }
  }
  if (!hasExpire) {
    violations.push(
      ...eachMatch(
        "REDIS-001",
        path,
        code,
        LUA_WRITE,
        (match) =>
          `Lua ${String(match[1]).toUpperCase()} in a script that never sets an expiry: every Redis key has a TTL`,
      ),
    );
  }
  return violations.sort((a, b) => a.line - b.line);
}

/**
 * @param {RepoView} repo
 * @returns {Violation[]}
 */
export function checkKeyBuilderExists(repo) {
  if (repo.exists(KEY_BUILDER)) return [];
  if (!repo.list(REDIS_DIR).some((path) => isCodeFile(path) && !isTestFile(path))) return [];
  return [
    {
      rule: "REDIS-001",
      path: KEY_BUILDER,
      line: 1,
      message: `${REDIS_DIR} exists without the key builder: every key is built in ${KEY_BUILDER} as rlsleak:{env}:{purpose}:{id}`,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// REDIS-002: routes that use Redis declare the Node.js runtime
// ---------------------------------------------------------------------------------------------

const RUNTIME_EXPORT = /\bexport\s+const\s+runtime\b[^=\n]*=\s*(["'`])([\w-]+)\1/;

/**
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkNodeRuntime(source) {
  const { path, code } = source;
  if (!isRouteFile(path) || isTestFile(path)) return [];
  const redisImport = source.imports.find(
    (ref) =>
      !ref.typeOnly &&
      (isPackage(ref.specifier, "ioredis") ||
        REDIS_USING_DIRS.some((dir) => isUnder(resolveImport(path, ref.specifier), dir))),
  );
  if (redisImport === undefined) return [];
  const runtime = RUNTIME_EXPORT.exec(code);
  if (runtime !== null && runtime[2] === "nodejs") return [];
  return [
    {
      rule: "REDIS-002",
      path,
      line: runtime === null ? redisImport.line : lineOf(code, runtime.index),
      message:
        runtime === null
          ? `imports ${redisImport.specifier}, which uses Redis over TCP: add \`export const runtime = "nodejs"\``
          : `runtime is "${runtime[2]}" but ${redisImport.specifier} uses Redis over TCP: it must be "nodejs"`,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// AI-001: the model id lives in one module
// ---------------------------------------------------------------------------------------------

const MODEL_ID = /\bclaude-(?:opus|sonnet|haiku|fable|instant|\d)[\w.-]*/g;

/**
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkModelId(source) {
  const { path } = source;
  if (!path.startsWith("src/") || path === MODEL_MODULE || isTestFile(path) || isBinaryFile(path)) {
    return [];
  }
  return eachMatch(
    "AI-001",
    path,
    source.code,
    MODEL_ID,
    (match) => `model id ${match[0]} outside ${MODEL_MODULE}: import it from there`,
  );
}

/**
 * @param {RepoView} repo
 * @returns {Violation[]}
 */
export function checkModelModuleExists(repo) {
  if (repo.exists(MODEL_MODULE)) return [];
  if (!repo.list("src/lib/ai").some((path) => isCodeFile(path) && !isTestFile(path))) return [];
  return [
    {
      rule: "AI-001",
      path: MODEL_MODULE,
      line: 1,
      message: "src/lib/ai exists without model.ts: the model id is defined there and nowhere else",
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// QUAL-001: every exclusion is listed in rules.yaml with a reason
// ---------------------------------------------------------------------------------------------

const REASON = /--\s*\S.{9,}/;
const SUPPRESSIONS = [
  {
    marker: /^\s*eslint-disable(?:-next-line|-line)?\b(.*)$/,
    name: "eslint-disable",
    ok: (/** @type {string} */ rest) => REASON.test(rest),
  },
  {
    marker: /^\s*@ts-expect-error\b(.*)$/,
    name: "@ts-expect-error",
    ok: (/** @type {string} */ rest) => /\S.{9,}/.test(rest.replace(/^[\s:–-]+/, "")),
  },
  {
    marker: /^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:next|if|else|file|start)\b(.*)$/,
    name: "a coverage ignore hint",
    ok: (/** @type {string} */ rest) => REASON.test(rest),
  },
];
const BANNED_SUPPRESSION = /^\s*@ts-(ignore|nocheck)\b/;
const SONAR_SUPPRESSION = /\bNOSONAR\b(.*)$/;

/**
 * An inline suppression is an exclusion too. It may exist, but it says why, in the same comment.
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkInlineSuppressions(source) {
  const { path } = source;
  if (!isCodeFile(path)) return [];
  /** @type {Violation[]} */
  const violations = [];
  for (const comment of source.comments) {
    const body = comment.text.replace(/^\/\/|^\/\*+|\*\/$/g, "");
    body.split("\n").forEach((text, offset) => {
      const line = comment.line + offset;
      const cleaned = text.replace(/^\s*\*\s?/, "");
      const banned = BANNED_SUPPRESSION.exec(cleaned);
      if (banned !== null) {
        violations.push({
          rule: "QUAL-001",
          path,
          line,
          message: `@ts-${banned[1]} hides every error on its target: use @ts-expect-error with a written reason`,
        });
        return;
      }
      for (const { marker, name, ok } of SUPPRESSIONS) {
        const match = marker.exec(cleaned);
        if (match !== null && !ok(match[1] ?? "")) {
          violations.push({
            rule: "QUAL-001",
            path,
            line,
            message: `${name} without a written reason: add "-- why" to the same comment`,
          });
        }
      }
      const sonar = SONAR_SUPPRESSION.exec(cleaned);
      if (sonar !== null && !/\S.{9,}/.test(sonar[1] ?? "")) {
        violations.push({
          rule: "QUAL-001",
          path,
          line,
          message: "a Sonar suppression without a written reason: say why on the same line",
        });
      }
    });
  }
  return violations;
}

/**
 * Drops closing brackets at the end of `text` that were opened before it began, as in `X }]`.
 * @param {string} text
 */
function trimUnbalancedClosers(text) {
  const pairs = /** @type {Record<string, string>} */ ({ "}": "{", "]": "[", ")": "(" });
  let result = text.trimEnd();
  for (;;) {
    const close = result.slice(-1);
    const open = pairs[close];
    if (open === undefined) return result;
    if (result.split(close).length <= result.split(open).length) return result;
    result = result.slice(0, -1).trimEnd();
  }
}

/**
 * The ignore patterns and switched-off rules of eslint.config.*. Identifiers that name an array
 * or a string constant of the same file are followed; anything else is reported as written.
 * @param {string} content
 * @returns {{ tool: string, pattern: string, line: number }[]}
 */
export function parseEslintConfig(content) {
  const code = scanSource(content).code;
  /** @type {Map<string, string>} */
  const strings = new Map();
  /** @type {Map<string, string>} */
  const arrays = new Map();
  for (const match of code.matchAll(/\bconst\s+([\w$]+)\s*=\s*/g)) {
    const at = match.index + match[0].length;
    const first = code.charAt(at);
    if (first === "[") {
      const end = matchingBracket(code, at);
      if (end !== -1) arrays.set(match[1] ?? "", code.slice(at + 1, end));
    } else if (first === '"' || first === "'" || first === "`") {
      const end = code.indexOf(first, at + 1);
      if (end !== -1) strings.set(match[1] ?? "", code.slice(at + 1, end));
    }
  }
  /**
   * @param {string} raw
   * @param {number} [depth]
   * @returns {string[]}
   */
  const resolve = (raw, depth = 0) => {
    const name = raw.replace(/^\.\.\./, "").trim();
    const array = arrays.get(name);
    if (array !== undefined && depth < 5) {
      return splitTopLevel(array).flatMap((part) => resolve(part.text, depth + 1));
    }
    return [unquote(name).replace(/\$\{([\w$]+)\}/g, (whole, id) => strings.get(id) ?? whole)];
  };

  /** @type {{ tool: string, pattern: string, line: number }[]} */
  const found = [];
  for (const match of code.matchAll(/\bglobalIgnores\s*\(\s*|(?<![\w$.])ignores\s*:\s*/g)) {
    const at = match.index + match[0].length;
    const line = lineOf(code, match.index);
    if (code.charAt(at) === "[") {
      const end = matchingBracket(code, at);
      const block = { inner: end === -1 ? "" : code.slice(at + 1, end), start: at + 1 };
      for (const entry of arrayElements(code, block, resolve))
        found.push({ tool: "eslint", ...entry });
    } else {
      const restOfLine = /^[^\n]*/.exec(code.slice(at))?.[0] ?? "";
      const expression = trimUnbalancedClosers(splitTopLevel(restOfLine)[0]?.text ?? "");
      for (const pattern of resolve(expression)) found.push({ tool: "eslint", pattern, line });
    }
  }
  const rulesOff = [
    // "rule-name": "off" | 0 | ["off", …] | [0, …]
    /(["'])([@\w/-]+)\1\s*:\s*(?:\[\s*)?(?:(["'])off\3|0(?=\s*[,\]}\n]))/g,
    // ruleName: "off" | ["off", …]
    /(?<![\w$."'-])()([\w$]+)\s*:\s*(?:\[\s*)?(["'])off\3/g,
  ];
  for (const pattern of rulesOff) {
    for (const match of code.matchAll(pattern)) {
      found.push({
        tool: "eslint-rule-off",
        pattern: match[2] ?? "",
        line: lineOf(code, match.index),
      });
    }
  }
  return found;
}

const SONAR_EXCLUSION_KEYS = new Map([
  ["sonar.exclusions", "sonar"],
  ["sonar.coverage.exclusions", "sonar-coverage"],
  ["sonar.cpd.exclusions", "sonar-cpd"],
  ["sonar.test.exclusions", "sonar-test"],
]);

/**
 * @param {string} content the text of sonar-project.properties
 * @returns {{ tool: string, pattern: string, line: number }[]}
 */
export function parseSonarProperties(content) {
  /** @type {{ tool: string, pattern: string, line: number }[]} */
  const found = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    let text = (lines[index] ?? "").trim();
    while (text.endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      text = text.slice(0, -1) + (lines[index] ?? "").trim();
    }
    if (text === "" || text.startsWith("#") || text.startsWith("!")) continue;
    const match = /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(text);
    if (match === null) continue;
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    const tool = SONAR_EXCLUSION_KEYS.get(key);
    if (tool !== undefined) {
      for (const pattern of value.split(",").map((part) => part.trim())) {
        if (pattern !== "") found.push({ tool, pattern, line });
      }
    } else if (/^sonar\.issue\.(?:ignore|enforce)\./.test(key) && value !== "") {
      found.push({ tool: "sonar-issue", pattern: `${key}=${value}`, line });
    }
  }
  return found;
}

/** Which configuration file an exclusion tool belongs to, for the stale-entry check. */
const TOOL_FILES = new Map([
  ["eslint", ESLINT_CONFIGS],
  ["eslint-rule-off", ESLINT_CONFIGS],
  ["vitest", VITEST_CONFIGS],
  ["vitest-coverage", VITEST_CONFIGS],
  ["sonar", [SONAR_PROPERTIES]],
  ["sonar-coverage", [SONAR_PROPERTIES]],
  ["sonar-cpd", [SONAR_PROPERTIES]],
  ["sonar-test", [SONAR_PROPERTIES]],
  ["sonar-issue", [SONAR_PROPERTIES]],
]);

/**
 * Compares what the tools are configured to skip with what rules.yaml lists, in both directions:
 * an unlisted exclusion is a violation, and so is a listed one the tool no longer has.
 * `.prettierignore` is exempt: formatting is not a quality measurement.
 * @param {RepoView} repo
 * @param {CheckContext} context
 * @returns {Violation[]}
 */
export function checkExclusionsListed(repo, context) {
  // null: rules.yaml did not pass its schema, which is already a violation. Comparing against a
  // list that could not be read would only bury that message under one line per exclusion.
  const listedExclusions = context.exclusions;
  if (listedExclusions === null) return [];
  /** @type {ConfiguredExclusion[]} */
  const configured = [];
  /** @type {Set<string>} */
  const presentFiles = new Set();
  /**
   * @param {readonly string[]} candidates
   * @param {(content: string) => { tool: string, pattern: string, line: number }[]} parse
   */
  const collect = (candidates, parse) => {
    for (const path of candidates) {
      const content = repo.read(path);
      if (content === null) continue;
      presentFiles.add(path);
      for (const entry of parse(content)) configured.push({ ...entry, path });
    }
  };
  collect(ESLINT_CONFIGS, parseEslintConfig);
  collect(VITEST_CONFIGS, (content) => {
    const config = parseVitestConfig(content);
    return [
      ...config.testExclude.map((entry) => ({ tool: "vitest", ...entry })),
      ...config.coverageExclude.map((entry) => ({ tool: "vitest-coverage", ...entry })),
    ];
  });
  collect([SONAR_PROPERTIES], parseSonarProperties);
  for (const dir of context.skipDirs) {
    configured.push({
      tool: "rules-check",
      pattern: dir,
      path: "scripts/rules-check/repo.mjs",
      line: 1,
    });
  }

  const key = (/** @type {string} */ tool, /** @type {string} */ pattern) =>
    `${tool}\u0000${pattern}`;
  const listed = new Set(listedExclusions.map((entry) => key(entry.tool, entry.pattern)));
  const active = new Set(configured.map((entry) => key(entry.tool, entry.pattern)));

  /** @type {Violation[]} */
  const violations = [];
  /** @type {Set<string>} */
  const reported = new Set();
  for (const entry of configured) {
    const id = key(entry.tool, entry.pattern);
    if (listed.has(id) || reported.has(id)) continue;
    reported.add(id);
    violations.push({
      rule: "QUAL-001",
      path: entry.path,
      line: entry.line,
      message: `exclusion "${entry.pattern}" (${entry.tool}) is not listed in rules.yaml: add it under exclusions with tool, pattern and a written reason`,
    });
  }
  for (const entry of listedExclusions) {
    const files = entry.tool === "rules-check" ? null : TOOL_FILES.get(entry.tool);
    const comparable =
      entry.tool === "rules-check" || files?.some((path) => presentFiles.has(path));
    if (comparable && !active.has(key(entry.tool, entry.pattern))) {
      violations.push({
        rule: "QUAL-001",
        path: "rules.yaml",
        line: entry.line,
        message: `exclusion "${entry.pattern}" (${entry.tool}) is listed but the tool no longer has it: remove the stale entry`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// QUAL-002: the lint rules that carry a rules.yaml id stay errors, and a warning fails lint
// ---------------------------------------------------------------------------------------------

/** The ESLint rules behind ARCH-001, ARCH-002, ARCH-004, CODE-001, CODE-002 and SEC-001. */
export const GOVERNED_ESLINT_RULES = [
  "no-restricted-imports",
  "boundaries/resolved-imports",
  "no-restricted-syntax",
  "no-restricted-globals",
  "react/no-danger",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-non-null-assertion",
];
const MAX_WARNINGS_ZERO = /--max-warnings(?:\s+|=)0(?!\d)/;

/**
 * The blocks of eslint.config.* that may name a governed rule, by their `name`, with the governed
 * rules each one sets. Flat config replaces the options of a rule instead of merging them: any
 * other block that names one of these rules for some path, even as "error", silently drops what
 * the named blocks ban there. A new selector or import ban goes into the shared lists the named
 * blocks are composed from; a new block goes into this list and into tests/eslint/boundaries.test.ts.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const GOVERNED_ESLINT_BLOCKS = {
  "rules/sec-001": ["no-restricted-syntax"],
  "rules/sec-001-react": ["react/no-danger"],
  "rules/arch-002": ["no-restricted-syntax", "no-restricted-imports", "no-restricted-globals"],
  "rules/arch-004": [
    "no-restricted-imports",
    "boundaries/resolved-imports",
    "no-restricted-syntax",
  ],
  "rules/code-001-code-002": [
    "@typescript-eslint/no-explicit-any",
    "@typescript-eslint/no-non-null-assertion",
  ],
  "rules/config-dir": [
    "no-restricted-imports",
    "boundaries/resolved-imports",
    "no-restricted-syntax",
  ],
  "rules/arch-001": [
    "no-restricted-imports",
    "boundaries/resolved-imports",
    "no-restricted-globals",
    "no-restricted-syntax",
  ],
};

/**
 * The Vitest suites rules.yaml names as an enforcer. Deleting one, skipping it or taking its
 * directory out of `test.include` switches the rule off without any other tool noticing.
 */
export const GUARD_SUITES = [
  {
    path: "tests/eslint/boundaries.test.ts",
    rules: "ARCH-001, ARCH-002, ARCH-004, CODE-001, CODE-002, SEC-001 and QUAL-002",
  },
  { path: "tests/setup/network-guard.test.ts", rules: "TEST-001" },
  { path: "tests/hooks/governance.test.ts", rules: "GIT-002, SEC-003 and DOD-10" },
];
/** What `test.include` of vitest.config.* has to contain: the unit tests and the suites under tests/. */
export const REQUIRED_TEST_INCLUDES = ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"];
/** The npm scripts that run the suites, and what each one must start with. */
const TEST_SCRIPTS = [
  { name: "test", command: /^vitest\s+run(?=\s|$)/, needs: null },
  { name: "test:coverage", command: /^vitest\s+run(?=\s|$)/, needs: "--coverage" },
];
/** Flags that change how a run is reported, never which tests run or what they must reach. */
const HARMLESS_VITEST_FLAG =
  /^--(?:coverage|silent|passWithNoTests|no-file-parallelism|bail=\d+|reporter=[\w./-]+|outputFile(?:\.\w+)?=[\w./-]+)$/;

/**
 * What the text of the configuration can show. That every rule really reports an error in every
 * scope is proven by tests/eslint/boundaries.test.ts, which loads the configuration.
 * @param {Source} source
 * @returns {Violation[]}
 */
export function checkGovernedLintRules(source) {
  const { path, content } = source;
  if (ESLINT_CONFIGS.includes(path)) {
    const names = GOVERNED_ESLINT_RULES.map((name) => name.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"));
    const weakened = new RegExp(
      `(["'\`])(${names.join("|")})\\1\\s*:\\s*(?:\\[\\s*)?(?:(["'\`])(off|warn)\\3|([01])(?=\\s*[,\\]}\\n]))`,
      "g",
    );
    const downgraded = eachMatch("QUAL-002", path, source.code, weakened, (match) => {
      const level = match[4] ?? (match[5] === "0" ? "off" : "warn");
      return `${match[2]} is set to "${level}": it enforces a rule of rules.yaml and stays "error" in every scope`;
    });
    return [...downgraded, ...checkGovernedBlocks(path, source.code, names)].sort(
      (a, b) => a.line - b.line,
    );
  }
  if (path !== PACKAGE_JSON) return [];
  const manifest = readManifest(content);
  if (manifest === null) {
    return [{ rule: "QUAL-002", path, line: 1, message: "package.json cannot be parsed" }];
  }
  /** @param {string} text */
  const lineOfText = (text) => lineOfJsonText(content, text);
  /** @type {Violation[]} */
  const violations = [];
  const lint = manifest.scripts?.lint;
  if (typeof lint !== "string" || !/\beslint\b/.test(lint)) {
    violations.push({
      rule: "QUAL-002",
      path,
      line: 1,
      message: 'scripts.lint must run ESLint: "eslint --max-warnings 0"',
    });
  }
  for (const command of manifestCommands(manifest)) {
    for (const part of command.split(/&&|\|\||;/)) {
      if (/^\s*(?:npx\s+)?eslint\b/.test(part) && !MAX_WARNINGS_ZERO.test(part)) {
        violations.push({
          rule: "QUAL-002",
          path,
          line: lineOfText(command),
          message: `"${part.trim()}" runs ESLint without --max-warnings 0: a rule downgraded to a warning would pass`,
        });
      }
    }
  }
  for (const { name, command, needs } of TEST_SCRIPTS) {
    const script = manifest.scripts?.[name];
    const wanted = needs === null ? "vitest run" : `vitest run ${needs}`;
    if (typeof script !== "string") {
      violations.push({
        rule: "QUAL-002",
        path,
        line: 1,
        message: `scripts.${name} is missing: it must be "${wanted}", which runs every suite of vitest.config`,
      });
      continue;
    }
    // Leading NAME=value pairs are the environment of the command, not the command.
    const bare = script.trim().replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, "");
    const flags = bare.replace(command, "").trim().split(/\s+/).filter(Boolean);
    const narrowing = flags.filter((flag) => !HARMLESS_VITEST_FLAG.test(flag));
    if (!command.test(bare) || narrowing.length > 0 || (needs !== null && !flags.includes(needs))) {
      violations.push({
        rule: "QUAL-002",
        path,
        line: lineOfText(script),
        message: `scripts.${name} is "${script}": it must be "${wanted}" plus reporting flags at most. A file filter, --exclude, --dir, --config, --project, -t or a --coverage.* override decides which suites run and what they must reach, and that is the job of vitest.config, where the rules check reads it`,
      });
    }
  }
  return violations;
}

/**
 * A governed rule is named inside the blocks of GOVERNED_ESLINT_BLOCKS and nowhere else.
 * @param {string} path
 * @param {string} code the configuration without comments
 * @param {readonly string[]} names the governed rule names, escaped for a regular expression
 * @returns {Violation[]}
 */
function checkGovernedBlocks(path, code, names) {
  const ruleKey = new RegExp(`(["'\`])(${names.join("|")})\\1\\s*:`, "g");
  const keys = [...code.matchAll(ruleKey)].map((match) => ({
    rule: match[2] ?? "",
    index: match.index,
  }));
  if (keys.length === 0) return []; // a configuration without governed rules: nothing to guard yet
  const pairs = bracePairs(code);
  /** The innermost `{…}` around an index. @param {number} index */
  const enclosing = (index) =>
    pairs.filter(([open, close]) => open < index && index < close).sort((a, b) => b[0] - a[0])[0];
  /** @type {{ name: string, index: number, open: number, close: number }[]} */
  const named = [];
  for (const match of code.matchAll(/(?<![\w$.])name\s*:\s*(["'`])(rules\/[\w-]+)\1/g)) {
    const block = enclosing(match.index);
    if (block !== undefined) {
      named.push({ name: match[2] ?? "", index: match.index, open: block[0], close: block[1] });
    }
  }
  /** @type {Violation[]} */
  const violations = [];
  /** @param {number} index @param {string} message */
  const report = (index, message) =>
    violations.push({ rule: "QUAL-002", path, line: lineOf(code, index), message });

  for (const [name, rules] of Object.entries(GOVERNED_ESLINT_BLOCKS)) {
    const found = named.filter((block) => block.name === name);
    if (found.length === 0) {
      report(0, `the block named "${name}" is missing: it sets ${rules.join(", ")}`);
    }
    for (const extra of found.slice(1)) {
      report(
        extra.index,
        `a second block is named "${name}": flat config lets the later one replace the rule options of the first`,
      );
    }
    const block = found[0];
    if (block === undefined) continue;
    for (const rule of rules) {
      if (
        !keys.some((key) => key.rule === rule && block.open < key.index && key.index < block.close)
      ) {
        report(block.index, `the block "${name}" no longer sets ${rule}`);
      }
    }
  }
  // Only the first block of a name is a home: a second one is the override this check exists for.
  const homes = Object.keys(GOVERNED_ESLINT_BLOCKS).flatMap((name) => {
    const first = named.find((block) => block.name === name);
    return first === undefined ? [] : [first];
  });
  for (const key of keys) {
    const home = homes.find(
      (block) =>
        block.open < key.index &&
        key.index < block.close &&
        (GOVERNED_ESLINT_BLOCKS[block.name] ?? []).includes(key.rule),
    );
    if (home === undefined) {
      report(
        key.index,
        `${key.rule} is set outside the named blocks (${Object.keys(GOVERNED_ESLINT_BLOCKS).join(", ")}): flat config replaces rule options instead of merging them, so this block silently drops every ban of rules.yaml for the files it matches. Add the selector or the path to the shared lists the named blocks are composed from`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// QUAL-002: the suites that rules.yaml names as an enforcer cannot be switched off quietly
// ---------------------------------------------------------------------------------------------

/**
 * A small glob matcher for `test.exclude` patterns: `**`, `*`, `?` and `{a,b}`.
 * @param {string} rawGlob
 */
function globToRegExp(rawGlob) {
  const glob = rawGlob.replace(/^\.\//, "");
  let pattern = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob.charAt(i + 1) === "*") {
      pattern += glob.charAt(i + 2) === "/" ? "(?:.*/)?" : ".*";
      i += glob.charAt(i + 2) === "/" ? 2 : 1;
    } else if (ch === "*") {
      pattern += "[^/]*";
    } else if (ch === "?") {
      pattern += "[^/]";
    } else if (ch === "{" && glob.includes("}", i)) {
      braces += 1;
      pattern += "(?:";
    } else if (ch === "}" && braces > 0) {
      braces -= 1;
      pattern += ")";
    } else if (ch === "," && braces > 0) {
      pattern += "|";
    } else {
      pattern += ch.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * The guard suites exist, hold tests, are not skipped or narrowed, are collected by `test.include`
 * and are not taken out again by `test.exclude`.
 * @param {RepoView} repo
 * @returns {Violation[]}
 */
export function checkGuardSuites(repo) {
  const configPath = VITEST_CONFIGS.find((path) => repo.exists(path));
  if (configPath === undefined) return [];
  /** @type {Violation[]} */
  const violations = [];
  const config = parseVitestConfig(repo.read(configPath) ?? "");
  const included = config.testInclude.map((entry) => entry.pattern.replace(/^\.\//, ""));
  for (const pattern of REQUIRED_TEST_INCLUDES) {
    if (!included.includes(pattern)) {
      violations.push({
        rule: "QUAL-002",
        path: configPath,
        line: config.testInclude[0]?.line ?? 1,
        message: `test.include must contain "${pattern}": without it the suites that enforce rules.yaml are never collected and \`npm test\` stays green`,
      });
    }
  }
  for (const suite of GUARD_SUITES) {
    const content = repo.read(suite.path);
    if (content === null) {
      violations.push({
        rule: "QUAL-002",
        path: suite.path,
        line: 1,
        message: `the suite is missing: rules.yaml names it as the enforcer of ${suite.rules}`,
      });
      continue;
    }
    violations.push(...suiteProblems("QUAL-002", suite.path, content, "guard-suite"));
    for (const entry of config.testExclude) {
      if (globToRegExp(entry.pattern).test(suite.path)) {
        violations.push({
          rule: "QUAL-002",
          path: configPath,
          line: entry.line,
          message: `test.exclude "${entry.pattern}" takes ${suite.path} out of the run: it enforces ${suite.rules}`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ rule: string, applies: (path: string) => boolean, run: (source: Source, context: CheckContext) => Violation[] }} FileCheck
 * @typedef {{ rule: string, triggers: (path: string) => boolean, run: (repo: RepoView, context: CheckContext) => Violation[] }} RepoCheck
 */

/** @param {string} path */
const underSrc = (path) => path.startsWith("src/");
/** @param {readonly string[]} names */
const oneOf = (names) => (/** @type {string} */ path) => names.includes(path);

/** Checks that look at one file. `applies` is a cheap path filter; the check itself decides. @type {FileCheck[]} */
export const FILE_CHECKS = [
  {
    rule: "ARCH-003",
    applies: isRouteFile,
    run: (source, context) => checkRouteLength(source, context.routeMaxLines),
  },
  { rule: "CODE-003", applies: oneOf(["tsconfig.json"]), run: checkTsconfigStrict },
  { rule: "SEC-001", applies: underSrc, run: checkHtmlSinks },
  { rule: "SEC-002", applies: underSrc, run: checkInputValidation },
  { rule: "SEC-003", applies: () => true, run: checkSecrets },
  { rule: "SEC-003", applies: (path) => baseName(path) === ".env.example", run: checkEnvExample },
  { rule: "SEC-004", applies: underSrc, run: checkServerSqlEngines },
  {
    rule: "SEC-005",
    applies: oneOf([CSP_MODULE, PROXY_MODULE, ...NEXT_CONFIGS]),
    run: checkCspPolicy,
  },
  { rule: "TEST-001", applies: isTestFile, run: checkTestIsolation },
  { rule: "TEST-001", applies: oneOf([PACKAGE_JSON]), run: checkLiveSwitchNotScripted },
  {
    rule: "TEST-002",
    applies: oneOf(VITEST_CONFIGS),
    run: (source, context) => checkCoverageThresholds(source, context.coverageMin),
  },
  { rule: "REDIS-001", applies: underSrc, run: checkRedisDiscipline },
  { rule: "REDIS-002", applies: isRouteFile, run: checkNodeRuntime },
  { rule: "AI-001", applies: underSrc, run: checkModelId },
  { rule: "QUAL-001", applies: isCodeFile, run: checkInlineSuppressions },
  {
    rule: "QUAL-002",
    applies: oneOf([...ESLINT_CONFIGS, PACKAGE_JSON]),
    run: checkGovernedLintRules,
  },
];

/** Checks that need more than one file. In fast mode one runs only when a given path triggers it. @type {RepoCheck[]} */
export const REPO_CHECKS = [
  {
    rule: "SEC-005",
    triggers: oneOf([CSP_MODULE, PROXY_MODULE, ...NEXT_CONFIGS]),
    run: checkSecurityWiring,
  },
  {
    rule: "RUN-001",
    triggers: (path) => isUnder(path, RUNNER_DIR) || BYPASS_GUARD_TEST.test(path),
    run: checkBypassGuards,
  },
  {
    rule: "TEST-001",
    triggers: oneOf([...VITEST_CONFIGS, NETWORK_GUARD_SETUP]),
    run: checkNetworkGuardWired,
  },
  { rule: "TEST-002", triggers: oneOf(VITEST_CONFIGS), run: checkCoverageConfigExists },
  {
    rule: "QUAL-002",
    triggers: oneOf([...VITEST_CONFIGS, ...GUARD_SUITES.map((suite) => suite.path)]),
    run: checkGuardSuites,
  },
  { rule: "REDIS-001", triggers: (path) => isUnder(path, REDIS_DIR), run: checkKeyBuilderExists },
  { rule: "AI-001", triggers: (path) => isUnder(path, "src/lib/ai"), run: checkModelModuleExists },
  {
    rule: "QUAL-001",
    triggers: oneOf(["rules.yaml", SONAR_PROPERTIES, ...ESLINT_CONFIGS, ...VITEST_CONFIGS]),
    run: checkExclusionsListed,
  },
];

/** SEC-003 also has a part that needs git: the names of tracked environment files. */
export const GIT_CHECK_RULE = "SEC-003";

/** Every rule id this script can enforce. rules.yaml must mark exactly these as script-enforced. */
export const IMPLEMENTED_RULES = [
  ...new Set([...FILE_CHECKS, ...REPO_CHECKS].map((check) => check.rule)),
].sort();
