/**
 * One violating and one clean fixture for every rule that scripts/rules-check.mjs enforces.
 * The checks are pure, so a fixture is a path and a string.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkBypassGuards,
  checkCoverageConfigExists,
  checkCoverageThresholds,
  checkCspPolicy,
  checkGovernedLintRules,
  checkGuardSuites,
  checkEnvExample,
  checkExclusionsListed,
  checkHtmlSinks,
  checkInlineSuppressions,
  checkInputValidation,
  checkKeyBuilderExists,
  checkLiveSwitchNotScripted,
  checkModelId,
  checkModelModuleExists,
  checkNetworkGuardWired,
  checkNodeRuntime,
  checkRedisDiscipline,
  checkRouteLength,
  checkSecrets,
  checkSecurityWiring,
  checkServerSqlEngines,
  checkTestIsolation,
  checkTrackedEnvFiles,
  checkTsconfigStrict,
  ENGINE_DIRS,
  FILE_CHECKS,
  GOVERNED_ESLINT_BLOCKS,
  GOVERNED_ESLINT_RULES,
  GUARD_SUITES,
  IMPLEMENTED_RULES,
  isEnvFile,
  isRouteFile,
  isTestFile,
  parseEslintConfig,
  parseSonarProperties,
  parseVitestConfig,
  REPO_CHECKS,
  REQUIRED_TEST_INCLUDES,
} from "../../scripts/rules-check/checks.mjs";

import {
  FIXTURE_ESLINT_CONFIG,
  FIXTURE_GUARD_SUITE,
  FIXTURE_GUARD_SUITES,
  FIXTURE_NETWORK_GUARD_SETUP,
  FIXTURE_VITEST_CONFIG,
  glue,
  lines,
  REPO_ROOT,
  source,
  summarize,
} from "./helpers";

/** An in-memory repository view. */
function memoryRepo(files: Record<string, string>) {
  return {
    exists: (filePath: string) => filePath in files,
    read: (filePath: string) => files[filePath] ?? null,
    list: (dir: string) =>
      Object.keys(files)
        .filter((filePath) => dir === "" || filePath.startsWith(`${dir}/`))
        .sort(),
  };
}

const ROUTE = "src/app/api/explain/route.ts";
const IMPORT = glue("imp", "ort");

describe("path classification", () => {
  it("recognises route handlers, test files and real environment files", () => {
    expect(isRouteFile("src/app/api/scenarios/[slug]/route.ts")).toBe(true);
    expect(isRouteFile("src/app/auth/callback/route.ts")).toBe(true);
    expect(isRouteFile("src/lib/ai/route.ts")).toBe(false);
    expect(isTestFile("src/lib/runner/probe.test.ts")).toBe(true);
    expect(isTestFile("e2e/lab.spec.ts")).toBe(true);
    expect(isTestFile("tests/rules-check/helpers.ts")).toBe(true);
    expect(isTestFile("src/lib/runner/probe.ts")).toBe(false);
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("apps/web/.env.local")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
    expect(isEnvFile("src/lib/config/env.ts")).toBe(false);
  });

  it("registers a check for every implemented rule", () => {
    const registered = new Set([...FILE_CHECKS, ...REPO_CHECKS].map((check) => check.rule));
    expect([...registered].sort()).toEqual(IMPLEMENTED_RULES);
    expect(IMPLEMENTED_RULES).toEqual([
      "AI-001",
      "ARCH-003",
      "CODE-003",
      "QUAL-001",
      "QUAL-002",
      "REDIS-001",
      "REDIS-002",
      "RUN-001",
      "SEC-001",
      "SEC-002",
      "SEC-003",
      "SEC-004",
      "SEC-005",
      "TEST-001",
      "TEST-002",
    ]);
  });
});

describe("ARCH-003 route handlers are thin", () => {
  const body = (count: number) => lines(...Array.from({ length: count }, (_, i) => `// ${i}`));

  it("fails a route.ts longer than the limit", () => {
    const violations = checkRouteLength(source(ROUTE, body(81)), 80);
    expect(summarize(violations)).toEqual([`ARCH-003 ${ROUTE}:81`]);
    expect(violations[0]?.message).toContain("81 lines, the limit is 80");
  });

  it("passes at the limit and ignores other files", () => {
    expect(checkRouteLength(source(ROUTE, body(80)), 80)).toEqual([]);
    expect(checkRouteLength(source("src/lib/ai/explain.ts", body(500)), 80)).toEqual([]);
  });
});

describe("CODE-003 strict mode stays on", () => {
  it("fails when strict is off, missing, or undermined by a strict-family flag", () => {
    const off = lines("{", '  "compilerOptions": {', '    "strict": false', "  }", "}");
    expect(summarize(checkTsconfigStrict(source("tsconfig.json", off)))).toEqual([
      "CODE-003 tsconfig.json:3",
    ]);
    expect(checkTsconfigStrict(source("tsconfig.json", "{}"))).toHaveLength(1);
    const undermined = '{ "compilerOptions": { "strict": true, "strictNullChecks": false } }';
    expect(checkTsconfigStrict(source("tsconfig.json", undermined))[0]?.message).toContain(
      "strictNullChecks",
    );
    expect(checkTsconfigStrict(source("tsconfig.json", "{ not json"))[0]?.message).toContain(
      "cannot be parsed",
    );
  });

  it("passes a strict tsconfig with comments and trailing commas", () => {
    const strict = lines(
      "{",
      "  // comments are allowed in tsconfig.json",
      '  "compilerOptions": {',
      '    "strict": true, /* and so are trailing commas */',
      "  },",
      "}",
    );
    expect(checkTsconfigStrict(source("tsconfig.json", strict))).toEqual([]);
    expect(checkTsconfigStrict(source("e2e/tsconfig.json", "{}"))).toEqual([]);
  });
});

describe("SEC-001 nothing is rendered as HTML", () => {
  it("fails on dangerouslySetInnerHTML and on the DOM sinks", () => {
    const component = lines(
      "export function Cell({ html }: { html: string }) {",
      "  return <td dangerouslySetInnerHTML={{ __html: html }} />;",
      "}",
      "const props = { dangerouslySetInnerHTML: { __html: value } };",
      "element.innerHTML = value;",
      'element.insertAdjacentHTML("beforeend", value);',
      "document.write(value);",
    );
    expect(summarize(checkHtmlSinks(source("src/components/cell.tsx", component)))).toEqual([
      "SEC-001 src/components/cell.tsx:2",
      "SEC-001 src/components/cell.tsx:4",
      "SEC-001 src/components/cell.tsx:5",
      "SEC-001 src/components/cell.tsx:6",
      "SEC-001 src/components/cell.tsx:7",
    ]);
  });

  it("passes text rendering, a mention in a comment and a comparison", () => {
    const component = lines(
      "// never dangerouslySetInnerHTML={...}: results are text",
      "export const Cell = ({ text }: { text: string }) => <td>{text}</td>;",
      'if (element.innerHTML === "") reset();',
    );
    expect(checkHtmlSinks(source("src/components/cell.tsx", component))).toEqual([]);
  });
});

describe("SEC-002 external input is validated with zod", () => {
  it("fails a route that reads the body without parsing it", () => {
    const route = lines(
      'import { explain } from "@/lib/ai/explain";',
      "export async function POST(request: Request) {",
      "  const body = await request.json();",
      "  return Response.json(await explain(body));",
      "}",
    );
    expect(summarize(checkInputValidation(source(ROUTE, route)))).toEqual([`SEC-002 ${ROUTE}:3`]);
  });

  it("fails a route that uses query or route parameters unparsed, and JSON.parse is no excuse", () => {
    const query = lines(
      "export async function GET(request: NextRequest) {",
      '  const slug = request.nextUrl.searchParams.get("slug");',
      "  return Response.json(JSON.parse(slug));",
      "}",
    );
    expect(summarize(checkInputValidation(source(ROUTE, query)))).toEqual([`SEC-002 ${ROUTE}:2`]);
    const params = lines(
      "export async function GET(_request: Request, context: RouteContext) {",
      "  const { slug } = await context.params;",
      "  return Response.json(await load(slug));",
      "}",
    );
    expect(checkInputValidation(source(ROUTE, params))).toHaveLength(1);
  });

  describe("params and searchParams of the App Router segment files", () => {
    const slugPage = lines(
      'import { loadShared } from "@/lib/store/shared";',
      "export default async function SharedPage({ params }: { params: Promise<{ slug: string }> }) {",
      "  const { slug } = await params;",
      "  return <pre>{await loadShared(slug)}</pre>;",
      "}",
    );

    it.each([
      "src/app/s/[slug]/page.tsx",
      "src/app/s/[slug]/layout.tsx",
      "src/app/s/[slug]/template.tsx",
      "src/app/@modal/s/[slug]/default.tsx",
      "src/app/s/[slug]/opengraph-image.tsx",
      "src/app/s/[slug]/page.jsx",
    ])("fails %s when it uses params unparsed", (file) => {
      expect(summarize(checkInputValidation(source(file, slugPage)))).toEqual([
        `SEC-002 ${file}:2`,
      ]);
    });

    it("fails searchParams of a page and params of generateMetadata", () => {
      const search = lines(
        "export default async function LabPage(props: PageProps) {",
        "  const query = await props.searchParams;",
        "  return <Lab scenario={query.scenario} />;",
        "}",
      );
      const violations = checkInputValidation(source("src/app/lab/page.tsx", search));
      expect(summarize(violations)).toEqual(["SEC-002 src/app/lab/page.tsx:2"]);
      expect(violations[0]?.message).toMatch(/query parameters/);

      const metadata = lines(
        'import type { Metadata } from "next";',
        "export async function generateMetadata({ params }: Props): Promise<Metadata> {",
        "  return { title: (await params).slug };",
        "}",
        "export default function SharedPage() {",
        "  return null;",
        "}",
      );
      const found = checkInputValidation(source("src/app/s/[slug]/page.tsx", metadata));
      expect(summarize(found)).toEqual(["SEC-002 src/app/s/[slug]/page.tsx:2"]);
      expect(found[0]?.message).toMatch(/route parameters/);
    });

    it("passes a zod parse, a parse* function from src/lib, and a page without parameters", () => {
      const withSchema = slugPage.replace("await params;", "slugSchema.parse(await params);");
      expect(checkInputValidation(source("src/app/s/[slug]/page.tsx", withSchema))).toEqual([]);
      const withValidator = lines(
        'import { parseSlug } from "@/lib/store/slug";',
        "export default async function SharedPage({ params }: Props) {",
        "  const slug = parseSlug((await params).slug);",
        "  return <pre>{slug}</pre>;",
        "}",
      );
      expect(checkInputValidation(source("src/app/s/[slug]/page.tsx", withValidator))).toEqual([]);
      expect(
        checkInputValidation(
          source("src/app/page.tsx", "export default function Home() {\n  return null;\n}\n"),
        ),
      ).toEqual([]);
    });

    it("stays scoped to the segment files: a component or a library module may name params", () => {
      for (const file of [
        "src/components/lab/panel.tsx",
        "src/app/s/[slug]/shared-view.tsx",
        "src/app/s/[slug]/error.tsx",
        "src/lib/store/shared.ts",
      ]) {
        expect(checkInputValidation(source(file, slugPage)), file).toEqual([]);
      }
    });
  });

  it("fails library and UI code that reads storage or JSON unparsed", () => {
    const store = lines(
      "export function load(key: string) {",
      "  const raw = localStorage.getItem(key);",
      "  return raw === null ? null : (JSON.parse(raw) as Scenario);",
      "}",
    );
    expect(summarize(checkInputValidation(source("src/lib/store/local.ts", store)))).toEqual([
      "SEC-002 src/lib/store/local.ts:2",
    ]);
  });

  it("passes a zod parse, a parse* function from src/lib, and files without input", () => {
    const withSchema = lines(
      'import { explainRequestSchema } from "@/lib/ai/schema";',
      "export async function POST(request: Request) {",
      "  const parsed = explainRequestSchema.safeParse(await request.json());",
      "  return Response.json(parsed.success);",
      "}",
    );
    expect(checkInputValidation(source(ROUTE, withSchema))).toEqual([]);
    const withValidator = lines(
      'import { parseExplainRequest } from "@/lib/ai/schema";',
      "export async function POST(request: Request) {",
      "  return Response.json(parseExplainRequest(await request.json()));",
      "}",
    );
    expect(checkInputValidation(source(ROUTE, withValidator))).toEqual([]);
    expect(
      checkInputValidation(source(ROUTE, "export const GET = () => Response.json({});")),
    ).toEqual([]);
  });

  it("does not accept a validator that is imported but never called, or that is not from src/lib", () => {
    const unused = lines(
      'import { parseExplainRequest } from "@/lib/ai/schema";',
      "export const POST = async (request: Request) => Response.json(await request.json());",
    );
    expect(checkInputValidation(source(ROUTE, unused))).toHaveLength(1);
    const foreign = lines(
      'import { parseBody } from "some-package";',
      "export const POST = async (request: Request) => parseBody(await request.json());",
    );
    expect(checkInputValidation(source(ROUTE, foreign))).toHaveLength(1);
    const builtin = "export const POST = async (r: Request) => parseInt(await r.json(), 10);";
    expect(checkInputValidation(source(ROUTE, builtin))).toHaveLength(1);
  });

  it.each([
    ["request.text()", "  const sql = await request.text();"],
    [
      "request.arrayBuffer()",
      "  const sql = new TextDecoder().decode(await request.arrayBuffer());",
    ],
    ["request.blob()", "  const sql = await (await request.blob()).slice(0, 10).toString();"],
    ["request.bytes()", "  const sql = String(await request.bytes());"],
    ["request.headers.get(", '  const sql = request.headers.get("x-sql") ?? "";'],
    ["(await headers()).get(", '  const sql = (await headers()).get("x-sql") ?? "";'],
    ["request.cookies.get(", '  const sql = request.cookies.get("sql")?.value ?? "";'],
    ["(await cookies()).get(", '  const sql = (await cookies()).get("sql")?.value ?? "";'],
  ])("fails a route that uses %s unvalidated, and passes once it parses", (_name, read) => {
    const route = lines(
      'import { explain } from "@/lib/ai/explain";',
      "export async function POST(request: NextRequest) {",
      read,
      "  return Response.json(await explain(sql));",
      "}",
    );
    expect(summarize(checkInputValidation(source(ROUTE, route)))).toEqual([`SEC-002 ${ROUTE}:3`]);
    const parsed = route.replace("await explain(sql)", "await explain(sqlSchema.parse(sql))");
    expect(checkInputValidation(source(ROUTE, parsed))).toEqual([]);
  });

  it("treats a response body, a header and document.cookie in library and UI code as input too", () => {
    const client = lines(
      "export async function load(url: string) {",
      "  const response = await fetch(url);",
      '  const retry = response.headers.get("Retry-After");',
      "  return { retry, body: await response.text() };",
      "}",
    );
    expect(summarize(checkInputValidation(source("src/lib/ai/client.ts", client)))).toEqual([
      "SEC-002 src/lib/ai/client.ts:3",
    ]);
    const cookie = "export const theme = document.cookie.split(';')[0];";
    expect(checkInputValidation(source("src/components/theme.tsx", cookie))).toHaveLength(1);
    // Writing a header, copying headers and rendering text are not reads.
    const writes = lines(
      "const requestHeaders = new Headers(request.headers);",
      'requestHeaders.set("x-nonce", nonce);',
      'response.headers.set("Retry-After", "1");',
      "const label = node.textContent;",
    );
    expect(checkInputValidation(source("src/proxy.ts", writes))).toEqual([]);
  });

  it("leaves test files alone", () => {
    const test = "const body = await response.json();";
    expect(checkInputValidation(source("src/lib/ai/explain.test.ts", test))).toEqual([]);
  });

  describe("a Server Function is an input boundary", () => {
    const ACTIONS = "src/app/lab/actions.ts";
    const unvalidated = lines(
      '"use server";',
      "",
      'import { saveScenario } from "@/lib/store/scenarios";',
      "",
      "export async function save(formData: FormData) {",
      '  return saveScenario(String(formData.get("sql")));',
      "}",
      "",
      "export async function direct(input: { sql: string }) {",
      "  return saveScenario(input.sql);",
      "}",
    );

    it('fails a "use server" file that uses its arguments unvalidated, FormData or typed object', () => {
      const violations = checkInputValidation(source(ACTIONS, unvalidated));
      expect(summarize(violations)).toEqual([`SEC-002 ${ACTIONS}:1`]);
      expect(violations[0]?.message).toMatch(/arguments of a Server Function/);
      // The typed signature alone is no validation: types vanish at run time.
      const typedOnly = lines(
        '"use server";',
        'import { saveScenario } from "@/lib/store/scenarios";',
        "export const direct = async (input: { sql: string }) => saveScenario(input.sql);",
      );
      expect(summarize(checkInputValidation(source(ACTIONS, typedOnly)))).toEqual([
        `SEC-002 ${ACTIONS}:1`,
      ]);
      const single = lines(
        "'use server';",
        'import { saveScenario } from "@/lib/store/scenarios";',
        "export const direct = async input => saveScenario(input);",
      );
      expect(checkInputValidation(source("src/components/lab/actions.ts", single))).toHaveLength(1);
    });

    it("fails a function-level directive, wherever the file lives", () => {
      const inline = lines(
        'import { saveScenario } from "@/lib/store/scenarios";',
        "export default function Page() {",
        "  async function save(formData: FormData) {",
        '    "use server";',
        "    await saveScenario(formData);",
        "  }",
        "  return <form action={save} />;",
        "}",
      );
      expect(summarize(checkInputValidation(source("src/app/lab/page.tsx", inline)))).toEqual([
        "SEC-002 src/app/lab/page.tsx:4",
      ]);
    });

    it("passes once the arguments are parsed, and a Server Function that takes none", () => {
      const parsed = unvalidated
        .replace('String(formData.get("sql"))', 'sqlSchema.parse(formData.get("sql"))')
        .replace("saveScenario(input.sql)", "saveScenario(inputSchema.parse(input).sql)");
      expect(parsed).not.toBe(unvalidated);
      expect(checkInputValidation(source(ACTIONS, parsed))).toEqual([]);
      const withValidator = lines(
        '"use server";',
        'import { parseScenarioInput } from "@/lib/scenario/schema";',
        'import { saveScenario } from "@/lib/store/scenarios";',
        "export async function direct(input: unknown) {",
        "  return saveScenario(parseScenarioInput(input));",
        "}",
      );
      expect(checkInputValidation(source(ACTIONS, withValidator))).toEqual([]);
      const noInput = lines(
        '"use server";',
        'import { signOut } from "@/lib/store/session";',
        "export async function leave() {",
        "  await signOut();",
        "}",
        "export const again = async () => signOut();",
      );
      expect(checkInputValidation(source(ACTIONS, noInput))).toEqual([]);
      // The words in a string or a comment are not a directive.
      const prose = lines(
        '// "use server" would make this an endpoint',
        'export const hint = "use server";',
        "export async function load(id: string) {",
        "  return id;",
        "}",
      );
      expect(checkInputValidation(source("src/lib/store/hint.ts", prose))).toEqual([]);
    });

    it.each([
      ["formData.get(", '  const sql = String(formData.get("sql"));'],
      ["formData.getAll(", '  const sql = formData.getAll("sql").join(";");'],
      ["Object.fromEntries(formData)", "  const { sql } = Object.fromEntries(formData);"],
      ["url.searchParams.get(", '  const sql = new URL(href).searchParams.get("sql") ?? "";'],
      ["prevFormData.entries(", "  const sql = [...prevFormData.entries()].join();"],
    ])("treats %s as a read in any product file, and passes once it parses", (_name, read) => {
      const file = "src/lib/store/form.ts";
      const content = lines(
        "export function readSql(formData: FormData, prevFormData: FormData, href: string) {",
        read,
        "  return sql;",
        "}",
      );
      expect(summarize(checkInputValidation(source(file, content)))).toEqual([`SEC-002 ${file}:2`]);
      const parsed = content.replace("return sql;", "return sqlSchema.parse(sql);");
      expect(checkInputValidation(source(file, parsed))).toEqual([]);
    });

    it("does not mistake other maps for form data", () => {
      const other = lines(
        "export const pick = (cache: Map<string, string>, params: Set<string>) =>",
        '  cache.get("a") ?? [...params.values()].join();',
      );
      expect(checkInputValidation(source("src/lib/store/cache.ts", other))).toEqual([]);
    });
  });
});

describe("SEC-003 no secrets in the repository", () => {
  const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (role: string) =>
    [
      base64url({ alg: "HS256", typ: "JWT" }),
      base64url({ role, iss: "supabase" }),
      "c2lnbmF0dXJl",
    ].join(".");
  const secrets: [string, string][] = [
    ["an Anthropic API key", glue("sk", "-ant-", "api03-", "Ab1".repeat(10))],
    ["a Supabase access token", glue("sb", "p_", "0123456789abcdef".repeat(3))],
    ["a Supabase secret key", glue("sb", "_secret_", "Zx9".repeat(8))],
    ["a GitHub token", glue("gh", "p_", "A1b2C3".repeat(6))],
    ["a SonarQube token", glue("sq", "u_", "0123456789".repeat(4))],
    ["a private key block", glue("-----BEGIN RSA ", "PRIVATE KEY", "-----")],
    ["a Supabase service_role JWT", jwt("service_role")],
    [
      "a Redis URL with a password",
      glue("redis", "s://default:", "hunter2hunter2", "@", "eu1-cache.upstash.io:6379"),
    ],
  ];

  it.each(secrets)("finds %s and never repeats it", (name, secret) => {
    const content = lines("# notes", `value = "${secret}"`);
    const violations = checkSecrets(source("docs/notes.md", content));
    expect(summarize(violations)).toEqual(["SEC-003 docs/notes.md:2"]);
    expect(violations[0]?.message).toContain(name);
    expect(violations[0]?.message).not.toContain(secret);
  });

  it("passes prose about keys, an anon JWT, placeholders and reserved hosts", () => {
    const harmless = lines(
      glue("Keys start with sk", "-ant-", " and tokens with sb", "p_."),
      `anon: ${jwt("anon")}`,
      glue("REDIS_URL=redis", "s://default:", "<password>", "@", "your-db.upstash.io:6379"),
      glue("REDIS_URL=redis", "s://default:", "${REDIS_PASSWORD}", "@", "cache.internal:6379"),
      glue("redis", "://user:", "anything-goes", "@", "localhost:6379"),
      glue("redis", "s://user:", "anything-goes", "@", "cache.example.com:6379"),
      "redis://localhost:6379",
    );
    expect(checkSecrets(source("docs/DEPLOY.md", harmless))).toEqual([]);
  });

  it("skips binary files by name", () => {
    const secret = glue("sk", "-ant-", "api03-", "Ab1".repeat(10));
    expect(checkSecrets(source("public/logo.png", secret))).toEqual([]);
  });

  it("fails a value in .env.example without echoing it, and passes empty values", () => {
    const filled = lines("# comment", "REDIS_URL=", "ANTHROPIC_MODEL=some-model", 'QUOTED=""');
    const violations = checkEnvExample(source(".env.example", filled));
    expect(summarize(violations)).toEqual(["SEC-003 .env.example:3"]);
    expect(violations[0]?.message).toContain("ANTHROPIC_MODEL");
    expect(violations[0]?.message).not.toContain("some-model");
    const empty = lines("# comment", "REDIS_URL=", "export OTHER=", "WITH_NOTE= # optional");
    expect(checkEnvExample(source(".env.example", empty))).toEqual([]);
    expect(checkEnvExample(source("docs/example.md", "A=1"))).toEqual([]);
  });

  it("fails a tracked environment file by name and passes .env.example", () => {
    const tracked = [".env.example", "src/app/page.tsx", ".env.local", "apps/web/.env"];
    expect(summarize(checkTrackedEnvFiles(tracked))).toEqual([
      "SEC-003 .env.local:1",
      "SEC-003 apps/web/.env:1",
    ]);
    expect(checkTrackedEnvFiles([".env.example"])).toEqual([]);
  });
});

describe("SEC-004 the server never executes user SQL", () => {
  it("fails server code that imports a Postgres engine or the engine directory", () => {
    const route = lines(
      'import { PGlite } from "@electric-sql/pglite";',
      'import { Pool } from "pg";',
      'import { createEngine } from "@/lib/engine/pglite";',
      'const live = await import("@electric-sql/pglite/live");',
    );
    expect(summarize(checkServerSqlEngines(source(ROUTE, route)))).toEqual([
      `SEC-004 ${ROUTE}:1`,
      `SEC-004 ${ROUTE}:2`,
      `SEC-004 ${ROUTE}:3`,
      `SEC-004 ${ROUTE}:4`,
    ]);
    for (const filePath of [
      "src/lib/ai/explain.ts",
      "src/lib/redis/adapters/redis.ts",
      "src/lib/store/supabase.ts",
      "src/app/auth/callback/route.ts",
    ]) {
      expect(checkServerSqlEngines(source(filePath, 'import pg from "pg";'))).toHaveLength(1);
    }
    const relative = 'import { run } from "../engine/worker/client";';
    expect(checkServerSqlEngines(source("src/lib/ai/explain.ts", relative))).toHaveLength(1);
  });

  it("fails a Server Function that loads an engine, wherever the file lives (FA-4, P3)", () => {
    const action = lines(
      '"use server";',
      "",
      'import { PGlite } from "@electric-sql/pglite";',
      "",
      "export async function runSql(sql: string) {",
      "  const db = new PGlite();",
      "  return db.query(sql);",
      "}",
    );
    for (const filePath of [
      "src/app/lab/actions.ts",
      "src/components/lab/actions.ts",
      "src/lib/engine/actions.ts",
      "src/lib/runner/actions.ts",
    ]) {
      const violations = checkServerSqlEngines(source(filePath, action));
      expect(summarize(violations)).toEqual([`SEC-004 ${filePath}:3`]);
      expect(violations[0]?.message).toMatch(/"use server" directive/);
    }
    const inline = lines(
      'import { createEngine } from "@/lib/engine/pglite";',
      "export default function Page() {",
      "  async function runSql(sql: string) {",
      "    'use server';",
      "    return (await createEngine()).query(sql);",
      "  }",
      "  return <form action={runSql} />;",
      "}",
    );
    expect(summarize(checkServerSqlEngines(source("src/app/lab/page.tsx", inline)))).toEqual([
      "SEC-004 src/app/lab/page.tsx:1",
    ]);
    // A client module cannot also be a Server Function file; the server directive wins.
    const both = lines(
      '"use client";',
      'import { x } from "@/lib/engine/pglite";',
      "async function a() {",
      '  "use server";',
      "}",
    );
    expect(checkServerSqlEngines(source("src/app/lab/both.tsx", both))).toHaveLength(1);
  });

  it("is an allow-list: outside the engine and client modules nothing loads an engine", () => {
    expect(ENGINE_DIRS).toEqual(["src/lib/engine"]);
    const engine = 'import { createEngine } from "@/lib/engine/pglite";';
    for (const filePath of [
      "src/lib/runner/run.ts",
      "src/lib/runner/probes/select.ts",
      "src/lib/checks/registry.ts",
      "src/app/lab/page.tsx",
      "src/app/layout.tsx",
      "src/proxy.ts",
      "src/instrumentation.ts",
      "src/components/lab/panel.tsx",
      "src/lib/export/sql.ts",
      "src/lib/security/csp.ts",
    ]) {
      const violations = checkServerSqlEngines(source(filePath, engine));
      expect(summarize(violations), filePath).toEqual([`SEC-004 ${filePath}:1`]);
      expect(violations[0]?.message).toMatch(/outside the places that may load a Postgres engine/);
    }
    const direct = 'const { PGlite } = await import("@electric-sql/pglite");';
    expect(checkServerSqlEngines(source("src/app/lab/page.tsx", direct))).toHaveLength(1);
    expect(
      checkServerSqlEngines(source("src/app/lab/page.tsx", 'const pg = require("pg");')),
    ).toHaveLength(1);
  });

  it("passes a client module, with comments before the directive, and a string that is not a directive", () => {
    const client = lines(
      "// The lab runs in the browser.",
      '"use client";',
      "",
      'import { createPgliteWorkerClient } from "@/lib/engine/worker/create-worker";',
    );
    expect(checkServerSqlEngines(source("src/app/lab/lab.tsx", client))).toEqual([]);
    expect(checkServerSqlEngines(source("src/components/lab/panel.tsx", client))).toEqual([]);
    const data = lines(
      '"use client";',
      'import { createEngine } from "@/lib/engine/pglite";',
      'export const hint = "use server";',
      'export const hints = ["use server", "use client"];',
    );
    expect(checkServerSqlEngines(source("src/components/lab/hint.tsx", data))).toEqual([]);
    // "use client" further down is an expression, not a directive.
    const late = lines('import { createEngine } from "@/lib/engine/pglite";', '"use client";');
    expect(checkServerSqlEngines(source("src/components/lab/late.tsx", late))).toHaveLength(1);
  });

  it("keeps the engine out of the runner, so that no server import of the runner reaches one (FA-4, P3)", () => {
    // The reviewer's chain: a runner module that holds an engine, and a route one import away.
    const exec = lines(
      'import { PGlite } from "@electric-sql/pglite";',
      "export async function exec(sql: string) {",
      "  const db = new PGlite();",
      "  return db.query(sql);",
      "}",
    );
    const route = lines(
      'import { exec } from "@/lib/runner/exec";',
      'import { sqlSchema } from "@/lib/scenario/schema";',
      "export async function POST(request: Request) {",
      "  return Response.json(await exec(sqlSchema.parse(await request.json())));",
      "}",
    );
    const violations = checkServerSqlEngines(source("src/lib/runner/exec.ts", exec));
    expect(summarize(violations)).toEqual(["SEC-004 src/lib/runner/exec.ts:1"]);
    expect(violations[0]?.message).toMatch(/take the SqlEngine port as a parameter/);
    // The route itself imports nothing forbidden; the chain is cut where the engine would enter.
    expect(checkServerSqlEngines(source(ROUTE, route))).toEqual([]);
    // The same through the engine directory and through a dynamic import.
    for (const load of [
      'import { createEngine } from "../engine/pglite";',
      'const { PGlite } = await import("@electric-sql/pglite");',
      'export { createEngine } from "@/lib/engine/pglite";',
    ]) {
      expect(checkServerSqlEngines(source("src/lib/runner/run.ts", load)), load).toHaveLength(1);
    }
    // What the runner does instead: the port as a type, the engine as a parameter.
    const port = lines(
      'import type { SqlEngine } from "@/lib/engine/port";',
      "export const run = (engine: SqlEngine, sql: string) => engine.query(sql);",
    );
    expect(checkServerSqlEngines(source("src/lib/runner/run.ts", port))).toEqual([]);
    // Its integration tests against real PGlite are test files.
    expect(checkServerSqlEngines(source("src/lib/runner/run.test.ts", exec))).toEqual([]);
    expect(checkServerSqlEngines(source("tests/runner/golden.test.ts", exec))).toEqual([]);
  });

  it("passes the browser side, type-only imports, tests and look-alike packages", () => {
    const engine = 'import { PGlite } from "@electric-sql/pglite";';
    expect(checkServerSqlEngines(source("src/lib/engine/pglite.ts", engine))).toEqual([]);
    expect(checkServerSqlEngines(source("src/lib/engine/worker/worker.ts", engine))).toEqual([]);
    expect(checkServerSqlEngines(source("src/lib/store/supabase.test.ts", engine))).toEqual([]);
    const typeOnly = 'import type { Results } from "@electric-sql/pglite";';
    expect(checkServerSqlEngines(source("src/lib/ai/explain.ts", typeOnly))).toEqual([]);
    const lookAlike = 'import x from "pgsql-ast-parser";';
    expect(checkServerSqlEngines(source("src/lib/ai/explain.ts", lookAlike))).toEqual([]);
  });
});

describe("SEC-005 the strict production CSP stays on", () => {
  const CSP = "src/lib/security/csp.ts";
  const policy = (scriptExtras: string, guard: string) =>
    lines(
      "// Development adds 'unsafe-eval'; a comment never counts.",
      "export function build(options: { isDev: boolean; nonce: string }) {",
      `  const scriptSrc = ["'self'", \`'nonce-\${options.nonce}'\`${scriptExtras}];`,
      `  ${guard} {`,
      `    scriptSrc.push("'unsafe-eval'");`,
      "  }",
      "  return [",
      '    ["script-src", scriptSrc],',
      `    ["style-src", ["'self'", "'unsafe-inline'"]],`,
      "  ];",
      "}",
    );

  it("passes the real shape: eval under an isDev guard, inline for styles only", () => {
    expect(checkCspPolicy(source(CSP, policy("", "if (options.isDev)")))).toEqual([]);
    const ternary = `const extra = options.isDev ? ["'unsafe-eval'"] : [];`;
    expect(checkCspPolicy(source(CSP, ternary))).toEqual([]);
  });

  it("fails 'unsafe-eval' without a guard, under a negated guard and in an else branch", () => {
    expect(summarize(checkCspPolicy(source(CSP, policy("", "if (true)"))))).toEqual([
      `SEC-005 ${CSP}:5`,
    ]);
    expect(checkCspPolicy(source(CSP, policy("", "if (!options.isDev)")))).toHaveLength(1);
    const elseBranch = lines(
      "if (options.isDev) {",
      "  relax();",
      "} else {",
      `  scriptSrc.push("'unsafe-eval'");`,
      "}",
    );
    expect(summarize(checkCspPolicy(source(CSP, elseBranch)))).toEqual([`SEC-005 ${CSP}:4`]);
    const negatedTernary = `const extra = !options.isDev ? ["'unsafe-eval'"] : [];`;
    expect(checkCspPolicy(source(CSP, negatedTernary))).toHaveLength(1);
  });

  it("fails 'unsafe-inline' for scripts", () => {
    const violations = checkCspPolicy(
      source(CSP, policy(`, "'unsafe-inline'"`, "if (options.isDev)")),
    );
    expect(summarize(violations)).toEqual([`SEC-005 ${CSP}:3`]);
    expect(violations[0]?.message).toContain("scriptSrc");
    const literal = `const directives = [["script-src", ["'self'", "'unsafe-inline'"]]];`;
    expect(checkCspPolicy(source(CSP, literal))[0]?.message).toContain("script-src");
  });

  it("fails a policy written outside the policy module", () => {
    const proxy = `response.headers.set("Content-Security-Policy", "script-src 'unsafe-inline'");`;
    expect(summarize(checkCspPolicy(source("src/proxy.ts", proxy)))).toEqual([
      "SEC-005 src/proxy.ts:1",
    ]);
    expect(checkCspPolicy(source("next.config.ts", `const csp = "'unsafe-eval'";`))).toHaveLength(
      1,
    );
    expect(checkCspPolicy(source("src/app/page.tsx", `const text = "'unsafe-eval'";`))).toEqual([]);
  });

  it("checks that the proxy and next.config still send the headers", () => {
    const wired = {
      [CSP]: "export const x = 1;",
      "src/proxy.ts": "const policy = buildDocumentCsp({ nonce, isDev });",
      "next.config.ts": "headers: buildStaticSecurityHeaders({ isDev }),",
    };
    expect(checkSecurityWiring(memoryRepo(wired))).toEqual([]);
    expect(checkSecurityWiring(memoryRepo({}))).toEqual([]);

    const unwired = {
      ...wired,
      "src/proxy.ts": "// buildDocumentCsp( only in a comment",
      "next.config.ts": "export default {};",
    };
    expect(summarize(checkSecurityWiring(memoryRepo(unwired)))).toEqual([
      "SEC-005 src/proxy.ts:1",
      "SEC-005 next.config.ts:1",
    ]);
    const deleted = { "src/proxy.ts": wired["src/proxy.ts"] };
    expect(summarize(checkSecurityWiring(memoryRepo(deleted)))).toEqual([`SEC-005 ${CSP}:1`]);
  });
});

describe("RUN-001 the bypass-guard tests exist once the runner exists", () => {
  const guard = lines(
    'describe("bypass guards", () => {',
    '  it("never runs a probe as the superuser", async () => {});',
    '  it("never runs a probe as the table owner", async () => {});',
    "});",
  );

  it("passes while there is no runner, and once a guard suite exists", () => {
    expect(checkBypassGuards(memoryRepo({ "src/lib/engine/x.ts": "" }))).toEqual([]);
    expect(checkBypassGuards(memoryRepo({ "src/lib/runner/probe.test.ts": "" }))).toEqual([]);
    const beside = { "src/lib/runner/run.ts": "", "src/lib/runner/bypass-guard.test.ts": guard };
    expect(checkBypassGuards(memoryRepo(beside))).toEqual([]);
    const inTests = { "src/lib/runner/run.ts": "", "tests/runner/bypass_guards.test.ts": guard };
    expect(checkBypassGuards(memoryRepo(inTests))).toEqual([]);
  });

  it("fails when the runner has code and no guard suite", () => {
    const repo = memoryRepo({ "src/lib/runner/run.ts": "", "src/lib/runner/run.test.ts": guard });
    expect(summarize(checkBypassGuards(repo))).toEqual(["RUN-001 src/lib/runner:1"]);
  });

  it("fails a guard suite that is skipped, narrowed or empty", () => {
    const skipped = guard.replace("it(", "it.skip(");
    const focused = guard.replace("describe(", "describe.only(");
    const empty = 'describe("bypass guards", () => {});\n';
    for (const content of [skipped, focused, empty]) {
      const repo = memoryRepo({
        "src/lib/runner/run.ts": "",
        "src/lib/runner/bypass-guard.test.ts": content,
      });
      expect(summarize(checkBypassGuards(repo))).toHaveLength(1);
    }
  });
});

describe("TEST-001 no real network or model calls in tests", () => {
  const TEST = "src/lib/ai/explain.test.ts";
  const call = (name: string, url: string) => glue(name, '("', url, '");');

  it("fails a call to a real address", () => {
    const content = lines(
      call(glue("await fet", "ch"), "https://api.anthropic.com/v1/messages"),
      call(glue("await page.go", "to"), "https://example.com/"),
      call(glue("await request.po", "st"), "http://10.0.0.5/api"),
      call(glue("new Web", "Socket"), "wss://stream.example.org"),
    );
    expect(summarize(checkTestIsolation(source(TEST, content)))).toEqual([
      `TEST-001 ${TEST}:1`,
      `TEST-001 ${TEST}:2`,
      `TEST-001 ${TEST}:3`,
      `TEST-001 ${TEST}:4`,
    ]);
    expect(checkTestIsolation(source("e2e/lab.spec.ts", content))).toHaveLength(4);
  });

  it("passes loopback URLs, relative navigation, URLs that are only data, and product code", () => {
    const content = lines(
      call(glue("await fet", "ch"), "http://localhost:3100/api/health"),
      call(glue("await fet", "ch"), "http://127.0.0.1:3100/"),
      call(glue("await page.go", "to"), "/lab"),
      'const request = new Request("https://rls.example.com/api/explain");',
      'expect(config.siteUrl).toBe("https://rls.example.com");',
    );
    expect(checkTestIsolation(source(TEST, content))).toEqual([]);
    const product = call(glue("await fet", "ch"), "https://api.anthropic.com/v1/messages");
    expect(checkTestIsolation(source("src/lib/ai/explain.ts", product))).toEqual([]);
  });

  it("fails a real address that reaches the call through a constant or new URL()", () => {
    const REMOTE = glue("https", "://api.anthropic.com");
    const FETCH = glue("await fet", "ch");
    const content = lines(
      glue('const BASE = "', REMOTE, '";'),
      glue("const TYPED: string = '", REMOTE, "/v1';"),
      glue('const PARSED = new URL("', REMOTE, '/v1");'),
      glue(FETCH, "(`${BASE}/v1/messages`);"),
      glue(FETCH, '(BASE + "/v1/messages");'),
      glue(FETCH, "(BASE);"),
      glue(FETCH, "(TYPED, { method: 'POST' });"),
      glue(FETCH, "(PARSED);"),
      glue(FETCH, '(new URL("', REMOTE, '/v1"));'),
      glue(FETCH, "(new URL(BASE));"),
      glue("await page.go", "to(BASE);"),
      glue("https.requ", 'est("', REMOTE, '/v1");'),
      glue("new Web", "Socket(BASE);"),
    );
    expect(summarize(checkTestIsolation(source(TEST, content)))).toEqual(
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((line) => `TEST-001 ${TEST}:${line}`),
    );
  });

  it("passes a loopback constant, a constant that is only data, and a longer name", () => {
    const REMOTE = glue("https", "://rls.example.com");
    const FETCH = glue("await fet", "ch");
    const content = lines(
      glue('const BASE = "http', '://127.0.0.1:3100";'),
      glue('const SITE = "', REMOTE, '";'),
      glue(FETCH, "(`${BASE}/api/health`);"),
      glue(FETCH, "(BASE);"),
      glue(FETCH, "(SITE_PATH);"),
      "expect(config.siteUrl).toBe(SITE);",
      "const request = new Request(SITE);",
    );
    expect(checkTestIsolation(source(TEST, content))).toEqual([]);
  });

  it("fails a test that imports the real provider, unless it is mocked or behind the live flag", () => {
    const providerImport = glue(IMPORT, ' { anthropic } from "@ai-sdk/anthropic";');
    expect(summarize(checkTestIsolation(source(TEST, providerImport)))).toEqual([
      `TEST-001 ${TEST}:1`,
    ]);
    const mocked = lines(
      providerImport,
      'vi.mock("@ai-sdk/anthropic", () => ({ anthropic: fake }));',
    );
    expect(checkTestIsolation(source(TEST, mocked))).toEqual([]);
    const live = lines(providerImport, "describe.runIf(config.runLiveAiTests)('live', () => {});");
    expect(checkTestIsolation(source(TEST, live))).toEqual([]);
    const typeOnly = glue(IMPORT, ' type { AnthropicProvider } from "@ai-sdk/anthropic";');
    expect(checkTestIsolation(source(TEST, typeOnly))).toEqual([]);
  });
});

describe("TEST-001 the live switch is never set from inside", () => {
  const TEST = "src/lib/ai/explain.test.ts";
  // Assembled at run time: this file is a test file too, and the check reads it.
  const SWITCH = glue("RUN_LIVE", "_AI_TESTS");

  it.each([
    ["an assignment", glue("process.env.", SWITCH, ' = "1";')],
    ["a bracket assignment", glue('process.env["', SWITCH, '"] = "true";')],
    ["a logical assignment", glue("env.", SWITCH, ' ||= "1";')],
    ["vi.stubEnv", glue('vi.stubEnv("', SWITCH, '", "1");')],
    ["Object.assign", glue("Object.assign(process.env, { ", SWITCH, ': "1" });')],
  ])("fails %s in a test file, a setup file and a Playwright spec", (_name, write) => {
    const content = lines('import { it } from "vitest";', write);
    for (const file of [TEST, "tests/setup/dom.setup.ts", "e2e/lab.spec.ts"]) {
      const violations = checkTestIsolation(source(file, content));
      expect(summarize(violations), file).toEqual([`TEST-001 ${file}:2`]);
      expect(violations[0]?.message).toMatch(/belongs to whoever starts the run/);
    }
    expect(checkTestIsolation(source("src/lib/config/server.ts", content))).toEqual([]);
  });

  it("passes reading the switch, prose about it, and handing it to a child process", () => {
    const content = lines(
      glue("const live = process.env.", SWITCH, ' === "1";'),
      glue("describe.runIf(process.env.", SWITCH, " == '1')('live', () => {});"),
      glue('const hint = "run it with ', SWITCH, '=1 npm test";'),
      glue("spawnSync(node, args, { env: { ...process.env, ", SWITCH, ': "" } });'),
      glue("const pick = (env: Env) => env.", SWITCH, ";"),
    );
    expect(checkTestIsolation(source(TEST, content))).toEqual([]);
  });

  it("fails a script or a lint-staged command that sets it", () => {
    const manifest = (test: string, staged: string) =>
      JSON.stringify({ scripts: { test }, "lint-staged": { "*.ts": [staged] } }, null, 2);
    const lifted = glue(SWITCH, "=1 vitest run");
    expect(
      summarize(checkLiveSwitchNotScripted(source("package.json", manifest(lifted, "eslint")))),
    ).toEqual(["TEST-001 package.json:3"]);
    expect(
      summarize(
        checkLiveSwitchNotScripted(
          source(
            "package.json",
            manifest("vitest run", glue("cross-env ", SWITCH, "=true vitest")),
          ),
        ),
      ),
    ).toEqual(["TEST-001 package.json:7"]);
    expect(
      checkLiveSwitchNotScripted(source("package.json", manifest("vitest run", "eslint"))),
    ).toEqual([]);
    expect(checkLiveSwitchNotScripted(source("apps/web/package.json", lifted))).toEqual([]);
    expect(checkLiveSwitchNotScripted(source("package.json", "{ not json"))).toEqual([]);
    const check = FILE_CHECKS.find((entry) => entry.run === checkLiveSwitchNotScripted);
    expect(check?.rule).toBe("TEST-001");
    expect(check?.applies("package.json")).toBe(true);
  });
});

describe("TEST-001 the run-time network guard stays wired", () => {
  const SETUP = "tests/setup/network-guard.setup.ts";
  const healthy = {
    "vitest.config.mts": FIXTURE_VITEST_CONFIG,
    [SETUP]: FIXTURE_NETWORK_GUARD_SETUP,
  };

  it("passes the fixture, a single-string setupFiles, and a repository without Vitest", () => {
    expect(checkNetworkGuardWired(memoryRepo(healthy))).toEqual([]);
    const single = FIXTURE_VITEST_CONFIG.replace(
      'setupFiles: ["./tests/setup/network-guard.setup.ts"]',
      'setupFiles: "tests/setup/network-guard.setup.ts"',
    );
    expect(single).not.toBe(FIXTURE_VITEST_CONFIG);
    expect(checkNetworkGuardWired(memoryRepo({ ...healthy, "vitest.config.mts": single }))).toEqual(
      [],
    );
    expect(checkNetworkGuardWired(memoryRepo({}))).toEqual([]);
  });

  it("reads setupFiles", () => {
    expect(parseVitestConfig(FIXTURE_VITEST_CONFIG).setupFiles).toEqual([
      { pattern: "./tests/setup/network-guard.setup.ts", line: 12 },
    ]);
  });

  it("fails a config that dropped the setup file, or lists another one, or comments it out", () => {
    const dropped = FIXTURE_VITEST_CONFIG.replace(/^ {4}setupFiles: .*\n/m, "");
    const other = FIXTURE_VITEST_CONFIG.replace("network-guard.setup.ts", "dom.setup.ts");
    const commented = FIXTURE_VITEST_CONFIG.replace("    setupFiles:", "    // setupFiles:");
    for (const config of [dropped, other, commented]) {
      expect(config).not.toBe(FIXTURE_VITEST_CONFIG);
      const violations = checkNetworkGuardWired(
        memoryRepo({ ...healthy, "vitest.config.mts": config }),
      );
      expect(violations.map((violation) => violation.rule)).toEqual(["TEST-001"]);
      expect(violations[0]?.path).toBe("vitest.config.mts");
      expect(violations[0]?.message).toMatch(/setupFiles must contain/);
    }
  });

  it("fails a missing setup file and one that no longer installs the guard or fails the test", () => {
    expect(
      summarize(checkNetworkGuardWired(memoryRepo({ "vitest.config.mts": FIXTURE_VITEST_CONFIG }))),
    ).toEqual([`TEST-001 ${SETUP}:1`]);
    const gutted = lines("// installNetworkGuard(process.env);", "export {};");
    const messages = checkNetworkGuardWired(memoryRepo({ ...healthy, [SETUP]: gutted })).map(
      (violation) => violation.message,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/no longer calls installNetworkGuard\(\)/);
    expect(messages[1]).toMatch(/no longer calls failOnBlockedAttempts\(\)/);
  });

  it("fails a setup file that hands the guard anything but process.env", () => {
    for (const call of [
      glue("installNetworkGuard({ RUN_LIVE", '_AI_TESTS: "1" });'),
      "installNetworkGuard({ ...process.env, ...overrides });",
      "installNetworkGuard(liveEnv);",
      "installNetworkGuard(process.env.CI ? live : process.env);",
    ]) {
      const setup = FIXTURE_NETWORK_GUARD_SETUP.replace("installNetworkGuard(process.env);", call);
      expect(setup).not.toBe(FIXTURE_NETWORK_GUARD_SETUP);
      const violations = checkNetworkGuardWired(memoryRepo({ ...healthy, [SETUP]: setup }));
      expect(summarize(violations), call).toEqual([`TEST-001 ${SETUP}:4`]);
      expect(violations[0]?.message).toMatch(/installNetworkGuard\(process\.env\)/);
    }
    // A second call with another record is refused as well; the first one decides at run time,
    // and nobody should have to know that.
    const twice = FIXTURE_NETWORK_GUARD_SETUP.replace(
      "installNetworkGuard(process.env);",
      "installNetworkGuard(process.env);\ninstallNetworkGuard(other);",
    );
    expect(summarize(checkNetworkGuardWired(memoryRepo({ ...healthy, [SETUP]: twice })))).toEqual([
      `TEST-001 ${SETUP}:5`,
    ]);
  });

  it("fails a Vitest configuration that sets the live switch itself", () => {
    const withEnv = FIXTURE_VITEST_CONFIG.replace(
      "  test: {",
      glue("  test: {\n    env: { RUN_LIVE", '_AI_TESTS: "1" },'),
    );
    expect(withEnv).not.toBe(FIXTURE_VITEST_CONFIG);
    const violations = checkNetworkGuardWired(
      memoryRepo({ ...healthy, "vitest.config.mts": withEnv }),
    );
    expect(summarize(violations)).toEqual(["TEST-001 vitest.config.mts:5"]);
    // A comment about the switch is fine: the real configuration has one.
    const commented = FIXTURE_VITEST_CONFIG.replace(
      "  test: {",
      glue("  test: {\n    // lifted only by RUN_LIVE", "_AI_TESTS=1"),
    );
    expect(
      checkNetworkGuardWired(memoryRepo({ ...healthy, "vitest.config.mts": commented })),
    ).toEqual([]);
  });

  it("runs in fast mode when the config or the setup file is edited", () => {
    const check = REPO_CHECKS.find((entry) => entry.run === checkNetworkGuardWired);
    expect(check?.rule).toBe("TEST-001");
    expect(check?.triggers("vitest.config.mts")).toBe(true);
    expect(check?.triggers(SETUP)).toBe(true);
    expect(check?.triggers("src/lib/utils.ts")).toBe(false);
  });
});

describe("QUAL-002 the governed lint rules stay errors and a warning fails lint", () => {
  const ERROR_ENTRY = '["error", { paths: [] }]';
  /**
   * One named block per entry of GOVERNED_ESLINT_BLOCKS, each governed rule on a line of its own.
   * `keep` leaves a rule out; a block without rules is left out as a whole.
   */
  const namedBlocks = (
    entryFor: (rule: string, block: string) => string = () => ERROR_ENTRY,
    keep: (rule: string, block: string) => boolean = () => true,
  ) =>
    Object.entries(GOVERNED_ESLINT_BLOCKS)
      .map(([block, rules]): [string, string[]] => [
        block,
        rules.filter((rule) => keep(rule, block)),
      ])
      .filter(([, rules]) => rules.length > 0)
      .flatMap(([block, rules]) => [
        "  {",
        `    name: "${block}",`,
        '    files: ["src/**/*.ts"],',
        "    rules: {",
        ...rules.map((rule) => `      "${rule}": ${entryFor(rule, block)},`),
        "    },",
        "  },",
      ]);
  const config = (blocks: string[], tail: string[] = []) =>
    lines("export default defineConfig([", ...blocks, ...tail, "]);");
  const healthy = config(namedBlocks());
  const lint = (content: string) => checkGovernedLintRules(source("eslint.config.mjs", content));

  it("passes the healthy fixture, the real configuration and a configuration without governed rules", () => {
    expect(lint(healthy)).toEqual([]);
    expect(lint(readFileSync(path.join(REPO_ROOT, "eslint.config.mjs"), "utf8"))).toEqual([]);
    expect(lint(FIXTURE_ESLINT_CONFIG)).toEqual([]);
  });

  it("fails a governed rule that is switched off or downgraded, in every spelling", () => {
    for (const name of GOVERNED_ESLINT_RULES) {
      const home = Object.entries(GOVERNED_ESLINT_BLOCKS).find(([, rules]) =>
        rules.includes(name),
      )?.[0];
      for (const level of ['"warn"', "'off'", "1", "0", '["warn", { paths: [] }]', "[1, {}]"]) {
        const content = config(
          namedBlocks((rule, block) => (rule === name && block === home ? level : ERROR_ENTRY)),
        );
        const violations = lint(content);
        expect(violations, `${name}: ${level}`).toHaveLength(1);
        expect(violations[0]?.rule).toBe("QUAL-002");
        expect(content.split("\n")[(violations[0]?.line ?? 0) - 1]).toContain(
          `"${name}": ${level}`,
        );
        expect(violations[0]?.message).toContain(`${name} is set to`);
      }
    }
  });

  it("passes errors, other rules and comments", () => {
    const fine = config(namedBlocks(), [
      "  {",
      "    rules: {",
      '      "no-console": "warn",',
      '      // "no-restricted-syntax": "off",',
      "    },",
      "  },",
    ]);
    expect(lint(fine)).toEqual([]);
    const numeric = config(namedBlocks((rule) => (rule === "react/no-danger" ? "2" : ERROR_ENTRY)));
    expect(lint(numeric)).toEqual([]);
    expect(
      checkGovernedLintRules(
        source("src/lib/x.ts", config([], ['{ rules: { "react/no-danger": "off" } }'])),
      ),
    ).toEqual([]);
  });

  it("fails a governed rule that a later block re-declares for a sub-path, even as an error", () => {
    // Flat config replaces rule options: this block drops ARCH-001, ARCH-002 and SEC-001 there.
    const override = [
      "  {",
      '    files: ["src/app/docs/**", "src/lib/runner/probes/**"],',
      "    rules: {",
      '      "no-restricted-imports": ["error", { paths: ["left-pad"] }],',
      '      "no-restricted-syntax": ["error", { selector: "DebuggerStatement", message: "no" }],',
      '      "no-restricted-globals": ["error", "event"],',
      "    },",
      "  },",
    ];
    const content = config(namedBlocks(), override);
    const first = healthy.split("\n").length - 1; // the line of the override's opening brace
    const violations = lint(content);
    expect(summarize(violations)).toEqual(
      [3, 4, 5].map((offset) => `QUAL-002 eslint.config.mjs:${first + offset}`),
    );
    for (const violation of violations) {
      expect(violation.message).toMatch(/is set outside the named blocks/);
      expect(violation.message).toMatch(/replaces rule options instead of merging/);
    }
  });

  it("fails the same override as a constant, under an unknown name, and under a name used twice", () => {
    const asConstant = lines(
      'const docs = { files: ["src/app/docs/**"], rules: { "no-restricted-syntax": ["error"] } };',
      healthy.trimEnd().replace(/\]\);$/, "  docs,\n]);"),
    );
    expect(summarize(lint(asConstant))).toEqual(["QUAL-002 eslint.config.mjs:1"]);

    const unknownName = config(namedBlocks(), [
      '  { name: "rules/docs", files: ["src/app/docs/**"], rules: { "no-restricted-globals": ["error"] } },',
    ]);
    const unknown = lint(unknownName);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toMatch(/no-restricted-globals is set outside the named blocks/);

    const twice = config(namedBlocks(), [
      '  { name: "rules/arch-002", files: ["src/app/docs/**"], rules: { "no-restricted-syntax": ["error"] } },',
    ]);
    const messages = lint(twice).map((violation) => violation.message);
    expect(messages).toHaveLength(2);
    expect(messages.join("\n")).toMatch(/a second block is named "rules\/arch-002"/);
    expect(messages.join("\n")).toMatch(/no-restricted-syntax is set outside the named blocks/);

    // A governed rule in the wrong named block is outside its home too.
    const misplaced = config(
      namedBlocks().map((row) =>
        row.includes('name: "rules/sec-001-react"')
          ? `${row}\n    extra: { "no-restricted-imports": ["error"] },`
          : row,
      ),
    );
    expect(lint(misplaced)).toHaveLength(1);
  });

  it("fails a named block that disappeared or lost one of its rules", () => {
    const withoutBlock = config(
      namedBlocks(undefined, (_rule, block) => block !== "rules/arch-001"),
    );
    expect(lint(withoutBlock).map((violation) => violation.message)).toEqual([
      expect.stringMatching(/the block named "rules\/arch-001" is missing/),
    ]);
    const lostRule = config(
      namedBlocks(
        undefined,
        (rule, block) => !(block === "rules/arch-002" && rule === "no-restricted-globals"),
      ),
    );
    expect(lint(lostRule).map((violation) => violation.message)).toEqual([
      expect.stringMatching(/the block "rules\/arch-002" no longer sets no-restricted-globals/),
    ]);
  });

  it("fails an ESLint command that tolerates warnings, in scripts and in lint-staged", () => {
    const manifest = (lint: string, staged: string) =>
      JSON.stringify(
        {
          scripts: {
            lint,
            quality: `${lint} && tsc --noEmit`,
            test: "vitest run",
            "test:coverage": "vitest run --coverage",
          },
          "lint-staged": { "*.ts": ["prettier --write", staged] },
        },
        null,
        2,
      );
    const strict = "eslint --max-warnings 0";
    expect(
      checkGovernedLintRules(source("package.json", manifest(strict, `${strict} --fix`))),
    ).toEqual([]);
    expect(
      checkGovernedLintRules(source("package.json", manifest("eslint --max-warnings=0", strict))),
    ).toEqual([]);
    expect(
      summarize(checkGovernedLintRules(source("package.json", manifest("eslint", strict)))),
    ).toEqual(["QUAL-002 package.json:3", "QUAL-002 package.json:4"]);
    expect(
      summarize(checkGovernedLintRules(source("package.json", manifest(strict, "eslint --fix")))),
    ).toEqual(["QUAL-002 package.json:11"]);
    expect(
      checkGovernedLintRules(source("package.json", manifest("eslint --max-warnings 10", strict))),
    ).toHaveLength(2);
    expect(
      checkGovernedLintRules(source("package.json", manifest("biome lint", strict))),
    ).toHaveLength(1);
    expect(checkGovernedLintRules(source("package.json", "{ not json"))).toHaveLength(1);
    expect(
      checkGovernedLintRules(source("apps/web/package.json", manifest("eslint", "eslint"))),
    ).toEqual([]);
  });
});

describe("QUAL-002 the test scripts run every suite", () => {
  const manifest = (scripts: Record<string, string>) =>
    JSON.stringify({ scripts: { lint: "eslint --max-warnings 0", ...scripts } }, null, 2);
  const check = (scripts: Record<string, string>) =>
    checkGovernedLintRules(source("package.json", manifest(scripts)));
  const COVERAGE = "vitest run --coverage";

  it("passes the plain commands, reporting flags and an environment prefix", () => {
    expect(check({ test: "vitest run", "test:coverage": COVERAGE })).toEqual([]);
    expect(
      check({
        test: "vitest run --reporter=verbose --silent",
        "test:coverage":
          "CI=1 vitest run --coverage --reporter=junit --outputFile=reports/junit.xml",
      }),
    ).toEqual([]);
  });

  it.each([
    ["a file filter", "vitest run src"],
    ["--exclude", "vitest run --exclude tests/eslint/**"],
    ["--dir", "vitest run --dir src"],
    ["another config", "vitest run --config vitest.fast.config.mts"],
    ["a project", "vitest run --project unit"],
    ["a name filter", "vitest run -t config"],
    ["a threshold override", "vitest run --coverage.thresholds.lines=10"],
    ["watch mode instead of a run", "vitest"],
    ["something that is not Vitest", "echo ok"],
  ])("fails scripts.test with %s", (_name, test) => {
    const violations = check({ test, "test:coverage": COVERAGE });
    expect(summarize(violations)).toEqual(["QUAL-002 package.json:4"]);
    expect(violations[0]?.message).toContain(`scripts.test is "${test}"`);
  });

  it("fails a missing test script, and a coverage script without --coverage or with a narrower run", () => {
    expect(check({ "test:coverage": COVERAGE }).map((violation) => violation.message)).toEqual([
      expect.stringMatching(/scripts\.test is missing/),
    ]);
    expect(check({ test: "vitest run" }).map((violation) => violation.message)).toEqual([
      expect.stringMatching(/scripts\.test:coverage is missing/),
    ]);
    expect(check({ test: "vitest run", "test:coverage": "vitest run" })).toHaveLength(1);
    expect(
      check({ test: "vitest run", "test:coverage": "vitest run --coverage src/lib" }),
    ).toHaveLength(1);
  });
});

describe("QUAL-002 the suites that enforce rules.yaml cannot be switched off quietly", () => {
  const CONFIG = "vitest.config.mts";
  const BOUNDARIES = "tests/eslint/boundaries.test.ts";
  const healthy: Record<string, string> = {
    [CONFIG]: FIXTURE_VITEST_CONFIG,
    ...FIXTURE_GUARD_SUITES,
  };

  it("knows the suites and passes a healthy checkout, the real one included", () => {
    expect(GUARD_SUITES.map((suite) => suite.path)).toEqual([
      BOUNDARIES,
      "tests/setup/network-guard.test.ts",
      "tests/hooks/governance.test.ts",
    ]);
    expect(REQUIRED_TEST_INCLUDES).toEqual(["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"]);
    expect(checkGuardSuites(memoryRepo(healthy))).toEqual([]);
    expect(checkGuardSuites(memoryRepo({}))).toEqual([]);
    const real = Object.fromEntries(
      [CONFIG, ...GUARD_SUITES.map((suite) => suite.path)].map((file) => [
        file,
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
      ]),
    );
    expect(checkGuardSuites(memoryRepo(real))).toEqual([]);
  });

  it("reads test.include apart from coverage.include", () => {
    expect(parseVitestConfig(FIXTURE_VITEST_CONFIG).testInclude).toEqual([
      { pattern: "src/**/*.test.{ts,tsx}", line: 5 },
      { pattern: "tests/**/*.test.ts", line: 5 },
    ]);
  });

  it("fails a deleted suite", () => {
    for (const suite of GUARD_SUITES) {
      const rest = Object.fromEntries(
        Object.entries(healthy).filter(([file]) => file !== suite.path),
      );
      const violations = checkGuardSuites(memoryRepo(rest));
      expect(summarize(violations)).toEqual([`QUAL-002 ${suite.path}:1`]);
      expect(violations[0]?.message).toContain(suite.rules);
    }
  });

  it("fails a suite that is skipped, narrowed, or left without a test", () => {
    const skipped = lines('describe.skip("ARCH-001", () => {', '  it("bites", () => {});', "});");
    const focused = lines('describe.only("ARCH-001", () => {', '  it("bites", () => {});', "});");
    const todo = lines('it.todo("bites");', 'it("other", () => {});');
    for (const content of [skipped, focused, todo]) {
      const violations = checkGuardSuites(memoryRepo({ ...healthy, [BOUNDARIES]: content }));
      expect(violations.map((violation) => violation.rule)).toEqual(["QUAL-002"]);
      expect(violations[0]?.path).toBe(BOUNDARIES);
      expect(violations[0]?.message).toMatch(/switches a guard-suite test off/);
    }
    const empty = 'describe("ARCH-001", () => {});\n';
    expect(
      checkGuardSuites(memoryRepo({ ...healthy, [BOUNDARIES]: empty })).map(
        (violation) => violation.message,
      ),
    ).toEqual(["the guard-suite suite has no test"]);
    expect(checkGuardSuites(memoryRepo({ ...healthy, [BOUNDARIES]: FIXTURE_GUARD_SUITE }))).toEqual(
      [],
    );
  });

  it("fails a test.include that no longer collects the suites under tests/ or the unit tests", () => {
    const narrowed = FIXTURE_VITEST_CONFIG.replace(
      'include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"]',
      'include: ["src/**/*.test.{ts,tsx}"]',
    );
    expect(narrowed).not.toBe(FIXTURE_VITEST_CONFIG);
    const violations = checkGuardSuites(memoryRepo({ ...healthy, [CONFIG]: narrowed }));
    expect(summarize(violations)).toEqual([`QUAL-002 ${CONFIG}:5`]);
    expect(violations[0]?.message).toContain('"tests/**/*.test.ts"');

    const onlyTests = narrowed.replace("src/**/*.test.{ts,tsx}", "tests/**/*.test.ts");
    expect(checkGuardSuites(memoryRepo({ ...healthy, [CONFIG]: onlyTests }))[0]?.message).toContain(
      '"src/**/*.test.{ts,tsx}"',
    );

    const dropped = FIXTURE_VITEST_CONFIG.replace(/^ {4}include: .*\n/m, "");
    expect(checkGuardSuites(memoryRepo({ ...healthy, [CONFIG]: dropped }))).toHaveLength(2);
  });

  it.each([
    "tests/eslint/**",
    "tests/**",
    "**/boundaries.test.ts",
    "tests/{eslint,setup}/**",
    "./tests/eslint/*.test.ts",
  ])("fails test.exclude %j, which takes a suite out again", (pattern) => {
    const excluded = FIXTURE_VITEST_CONFIG.replace(
      'exclude: ["node_modules/**"]',
      `exclude: ["node_modules/**", "${pattern}"]`,
    );
    expect(excluded).not.toBe(FIXTURE_VITEST_CONFIG);
    const violations = checkGuardSuites(memoryRepo({ ...healthy, [CONFIG]: excluded }));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.path).toBe(CONFIG);
    expect(violations[0]?.message).toContain(`test.exclude "${pattern}"`);
  });

  it("leaves the real exclusions alone", () => {
    const excluded = FIXTURE_VITEST_CONFIG.replace(
      'exclude: ["node_modules/**"]',
      'exclude: ["node_modules/**", ".next/**", "e2e/**", "tests/fixtures/**"]',
    );
    expect(checkGuardSuites(memoryRepo({ ...healthy, [CONFIG]: excluded }))).toEqual([]);
  });

  it("runs in fast mode when the config or a suite is edited", () => {
    const check = REPO_CHECKS.find((entry) => entry.run === checkGuardSuites);
    expect(check?.rule).toBe("QUAL-002");
    expect(check?.triggers(CONFIG)).toBe(true);
    for (const suite of GUARD_SUITES) expect(check?.triggers(suite.path)).toBe(true);
    expect(check?.triggers("src/lib/utils.ts")).toBe(false);
  });
});

describe("TEST-002 coverage thresholds", () => {
  const CONFIG = "vitest.config.mts";
  const minimum = { lines: 80, branches: 80 };

  it("passes the fixture configuration", () => {
    expect(checkCoverageThresholds(source(CONFIG, FIXTURE_VITEST_CONFIG), minimum)).toEqual([]);
  });

  it("fails a lowered, missing or per-glob threshold", () => {
    const lowered = FIXTURE_VITEST_CONFIG.replace("branches: 80", "branches: 60");
    const violations = checkCoverageThresholds(source(CONFIG, lowered), minimum);
    expect(summarize(violations)).toEqual([`TEST-002 ${CONFIG}:10`]);
    expect(violations[0]?.message).toContain("branches: 60 is below the required 80");

    const missing = FIXTURE_VITEST_CONFIG.replace(", branches: 80", "");
    expect(checkCoverageThresholds(source(CONFIG, missing), minimum)[0]?.message).toContain(
      "coverage.thresholds.branches is missing",
    );
    const perGlob = FIXTURE_VITEST_CONFIG.replace(
      "branches: 80 }",
      'branches: 80, "src/lib/ai/**": { lines: 10 } }',
    );
    expect(checkCoverageThresholds(source(CONFIG, perGlob), minimum)).toHaveLength(1);
    const commentedOut = FIXTURE_VITEST_CONFIG.replace(
      "thresholds: { lines: 80, branches: 80 },",
      "// thresholds: { lines: 80, branches: 80 },",
    );
    expect(checkCoverageThresholds(source(CONFIG, commentedOut), minimum)).toHaveLength(2);
  });

  it("fails a narrowed scope and a missing coverage block, and honours a higher minimum", () => {
    const narrowed = FIXTURE_VITEST_CONFIG.replace('"src/lib/**"]', '"src/lib/runner/**"]');
    expect(checkCoverageThresholds(source(CONFIG, narrowed), minimum)[0]?.message).toContain(
      'coverage.include must contain "src/lib/**"',
    );
    const none = "export default defineConfig({ test: {} });";
    expect(checkCoverageThresholds(source(CONFIG, none), minimum)[0]?.message).toContain(
      "coverage block is missing",
    );
    const higher = { lines: 90, branches: 80 };
    expect(checkCoverageThresholds(source(CONFIG, FIXTURE_VITEST_CONFIG), higher)).toHaveLength(1);
    expect(checkCoverageThresholds(source("other.config.ts", none), minimum)).toEqual([]);
  });

  it("fails when src/lib exists and no Vitest config does", () => {
    expect(summarize(checkCoverageConfigExists(memoryRepo({ "src/lib/utils.ts": "" })))).toEqual([
      "TEST-002 vitest.config.mts:1",
    ]);
    expect(checkCoverageConfigExists(memoryRepo({}))).toEqual([]);
    const present = { "src/lib/utils.ts": "", "vitest.config.ts": "" };
    expect(checkCoverageConfigExists(memoryRepo(present))).toEqual([]);
  });
});

describe("REDIS-001 one key builder, every write has a TTL", () => {
  it("fails a literal key outside the key builder and passes inside it, in comments and in tests", () => {
    const literal = "const key = `rlsleak:${env}:cache:${hash}`;";
    expect(summarize(checkRedisDiscipline(source("src/lib/ai/cache.ts", literal)))).toEqual([
      "REDIS-001 src/lib/ai/cache.ts:1",
    ]);
    expect(checkRedisDiscipline(source("src/lib/redis/keys.ts", literal))).toEqual([]);
    expect(checkRedisDiscipline(source("src/lib/redis/keys.test.ts", literal))).toEqual([]);
    const comment = "/** Keys look like rlsleak:{env}:{purpose}:{id}. */\nexport const x = 1;";
    expect(checkRedisDiscipline(source("src/lib/config/env.ts", comment))).toEqual([]);
  });

  it("fails ioredis outside src/lib/redis and passes a type-only import", () => {
    const direct = 'import Redis from "ioredis";';
    expect(summarize(checkRedisDiscipline(source("src/lib/ai/explain.ts", direct)))).toEqual([
      "REDIS-001 src/lib/ai/explain.ts:1",
    ]);
    expect(checkRedisDiscipline(source(ROUTE, direct))).toHaveLength(1);
    const typeOnly = 'import type { Redis } from "ioredis";';
    expect(checkRedisDiscipline(source("src/lib/ai/explain.ts", typeOnly))).toEqual([]);
  });

  it("fails a write outside the adapters", () => {
    const limiter = lines(
      "export async function hit(client: Client, key: string) {",
      "  await client.incr(key);",
      "  await client.hset(key, { seen: 1 });",
      "}",
    );
    expect(summarize(checkRedisDiscipline(source("src/lib/redis/limiter.ts", limiter)))).toEqual([
      "REDIS-001 src/lib/redis/limiter.ts:2",
      "REDIS-001 src/lib/redis/limiter.ts:3",
    ]);
    const port = "export interface Cache { get(key: string): Promise<string | null>; }";
    expect(checkRedisDiscipline(source("src/lib/redis/ports.ts", port))).toEqual([]);
  });

  it("fails a Redis adapter write without a TTL and passes one with a TTL", () => {
    const ADAPTER = "src/lib/redis/adapters/redis-cache.ts";
    const header = 'import type { Redis } from "ioredis";';
    const noTtl = lines(
      header,
      "export const put = (r: Redis, k: string, v: string) => r.set(k, v);",
    );
    expect(summarize(checkRedisDiscipline(source(ADAPTER, noTtl)))).toEqual([
      `REDIS-001 ${ADAPTER}:2`,
    ]);
    const counter = lines(header, "export const bump = (r: Redis, k: string) => r.incr(k);");
    expect(checkRedisDiscipline(source(ADAPTER, counter))[0]?.message).toContain(".incr(");

    const withTtl = lines(
      header,
      "export const put = (r: Redis, k: string, v: string, ttlMs: number) =>",
      '  r.set(k, v, "PX", ttlMs);',
      "export const lock = (r: Redis, k: string, ttlMs: number) =>",
      '  r.set(k, "1", "PX", ttlMs, "NX");',
      "export async function bump(r: Redis, k: string, ttlMs: number) {",
      "  await r.incr(k);",
      "  await r.pexpire(k, ttlMs);",
      "}",
    );
    expect(checkRedisDiscipline(source(ADAPTER, withTtl))).toEqual([]);
    const memory =
      "export const put = (m: Map<string, string>, k: string, v: string) => m.set(k, v);";
    expect(checkRedisDiscipline(source("src/lib/redis/adapters/memory-cache.ts", memory))).toEqual(
      [],
    );
  });

  it("fails a Lua write without an expiry", () => {
    const LUA = "src/lib/redis/adapters/limiter.lua";
    const noExpiry = "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])\nreturn 1\n";
    expect(summarize(checkRedisDiscipline(source(LUA, noExpiry)))).toEqual([`REDIS-001 ${LUA}:1`]);
    const withExpiry = `${noExpiry}redis.call('PEXPIRE', KEYS[1], ARGV[3])\n`;
    expect(checkRedisDiscipline(source(LUA, withExpiry))).toEqual([]);
  });

  it("requires the key builder once src/lib/redis has code", () => {
    expect(checkKeyBuilderExists(memoryRepo({}))).toEqual([]);
    const without = memoryRepo({ "src/lib/redis/ports.ts": "" });
    expect(summarize(checkKeyBuilderExists(without))).toEqual([
      "REDIS-001 src/lib/redis/keys.ts:1",
    ]);
    const withBuilder = memoryRepo({ "src/lib/redis/ports.ts": "", "src/lib/redis/keys.ts": "" });
    expect(checkKeyBuilderExists(withBuilder)).toEqual([]);
  });
});

describe("REDIS-002 routes that use Redis declare the Node.js runtime", () => {
  const redisImport = 'import { handleExplain } from "@/lib/ai/route-logic";';
  const handler = "export const POST = (request: Request) => handleExplain(request);";

  it("fails a route without the runtime export, and one that says edge", () => {
    const missing = lines(redisImport, handler);
    expect(summarize(checkNodeRuntime(source(ROUTE, missing)))).toEqual([`REDIS-002 ${ROUTE}:1`]);
    const edge = lines(redisImport, 'export const runtime = "edge";', handler);
    const violations = checkNodeRuntime(source(ROUTE, edge));
    expect(summarize(violations)).toEqual([`REDIS-002 ${ROUTE}:2`]);
    expect(violations[0]?.message).toContain('"edge"');
    const commented = lines(redisImport, '// export const runtime = "nodejs";', handler);
    expect(checkNodeRuntime(source(ROUTE, commented))).toHaveLength(1);
    for (const specifier of [
      "@/lib/redis",
      "@/lib/store/supabase",
      "ioredis",
      "../../../lib/redis/cache",
    ]) {
      const content = lines(`import { x } from "${specifier}";`, handler);
      expect(checkNodeRuntime(source(ROUTE, content)), specifier).toHaveLength(1);
    }
  });

  it("passes with the export, without Redis, with a type-only import and outside route files", () => {
    const declared = lines(redisImport, "export const runtime = 'nodejs';", handler);
    expect(checkNodeRuntime(source(ROUTE, declared))).toEqual([]);
    const health = 'import { buildId } from "@/lib/config/server";\nexport const GET = () => ok();';
    expect(checkNodeRuntime(source("src/app/api/health/route.ts", health))).toEqual([]);
    const typeOnly = 'import type { Limiter } from "@/lib/redis/ports";';
    expect(checkNodeRuntime(source(ROUTE, typeOnly))).toEqual([]);
    expect(checkNodeRuntime(source("src/lib/ai/route-logic.ts", redisImport))).toEqual([]);
  });
});

describe("AI-001 the model id lives in one module", () => {
  const literal = 'export const DEFAULT_MODEL = "claude-opus-5";';

  it("fails a model id anywhere else under src", () => {
    expect(summarize(checkModelId(source("src/lib/ai/prompt.ts", literal)))).toEqual([
      "AI-001 src/lib/ai/prompt.ts:1",
    ]);
    for (const id of ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-latest"]) {
      expect(
        checkModelId(source("src/components/explain.tsx", `const m = "${id}";`)),
        id,
      ).toHaveLength(1);
    }
  });

  it("passes the model module, tests, comments, files outside src and other words", () => {
    expect(checkModelId(source("src/lib/ai/model.ts", literal))).toEqual([]);
    expect(checkModelId(source("src/lib/ai/model.test.ts", literal))).toEqual([]);
    expect(checkModelId(source("docs/DEPLOY.md", literal))).toEqual([]);
    expect(checkModelId(source("src/lib/ai/prompt.ts", `// e.g. claude-opus-5\n`))).toEqual([]);
    expect(checkModelId(source("src/lib/ai/prompt.ts", 'const who = "claude-code";'))).toEqual([]);
  });

  it("requires model.ts once src/lib/ai has code", () => {
    expect(checkModelModuleExists(memoryRepo({}))).toEqual([]);
    const without = memoryRepo({ "src/lib/ai/prompt.ts": "" });
    expect(summarize(checkModelModuleExists(without))).toEqual(["AI-001 src/lib/ai/model.ts:1"]);
    const withModule = memoryRepo({ "src/lib/ai/prompt.ts": "", "src/lib/ai/model.ts": "" });
    expect(checkModelModuleExists(withModule)).toEqual([]);
  });
});

describe("QUAL-001 every exclusion is listed with a reason", () => {
  const reason = "A written reason that is long enough.";
  const listed = [
    { tool: "eslint", pattern: ".next/**" },
    { tool: "eslint", pattern: "coverage/**" },
    { tool: "vitest", pattern: "node_modules/**" },
    { tool: "vitest-coverage", pattern: "src/lib/**/*.test.{ts,tsx}" },
    { tool: "rules-check", pattern: "node_modules" },
  ].map((entry, index) => ({ ...entry, reason, line: 100 + index }));
  const context = {
    routeMaxLines: 80,
    coverageMin: { lines: 80, branches: 80 },
    exclusions: listed,
    skipDirs: ["node_modules"],
  };
  const configs = {
    "eslint.config.mjs": FIXTURE_ESLINT_CONFIG,
    "vitest.config.mts": FIXTURE_VITEST_CONFIG,
  };

  it("passes when the tools and rules.yaml agree", () => {
    expect(checkExclusionsListed(memoryRepo(configs), context)).toEqual([]);
  });

  it("stays silent when rules.yaml could not be read, which is reported on its own", () => {
    expect(checkExclusionsListed(memoryRepo(configs), { ...context, exclusions: null })).toEqual(
      [],
    );
  });

  it("fails an exclusion that a tool has and rules.yaml does not list", () => {
    const repo = memoryRepo({
      ...configs,
      "eslint.config.mjs": FIXTURE_ESLINT_CONFIG.replace(
        '"coverage/**"',
        '"coverage/**", "src/legacy/**"',
      ),
      "vitest.config.mts": FIXTURE_VITEST_CONFIG.replace(
        '"src/lib/**/*.test.{ts,tsx}"',
        '"src/lib/**/*.test.{ts,tsx}", "src/lib/ai/**"',
      ),
    });
    const violations = checkExclusionsListed(repo, context);
    expect(summarize(violations)).toEqual([
      "QUAL-001 eslint.config.mjs:3",
      "QUAL-001 vitest.config.mts:9",
    ]);
    expect(violations[0]?.message).toContain('"src/legacy/**" (eslint) is not listed');
    expect(violations[1]?.message).toContain('"src/lib/ai/**" (vitest-coverage) is not listed');
  });

  it("fails a listed exclusion that the tool no longer has", () => {
    const stale = [...listed, { tool: "eslint", pattern: "gone/**", reason, line: 321 }];
    const violations = checkExclusionsListed(memoryRepo(configs), {
      ...context,
      exclusions: stale,
    });
    expect(summarize(violations)).toEqual(["QUAL-001 rules.yaml:321"]);
    expect(violations[0]?.message).toContain("remove the stale entry");
  });

  it("compares the skip list of the script itself", () => {
    const more = { ...context, skipDirs: ["node_modules", "vendor"] };
    expect(checkExclusionsListed(memoryRepo(configs), more)[0]?.message).toContain(
      '"vendor" (rules-check) is not listed',
    );
    const fewer = { ...context, skipDirs: [] };
    expect(summarize(checkExclusionsListed(memoryRepo(configs), fewer))).toEqual([
      "QUAL-001 rules.yaml:104",
    ]);
  });

  it("compares Sonar exclusions once the properties file exists, planned entries before that", () => {
    const planned = [
      ...listed,
      { tool: "sonar", pattern: "e2e/**", reason, line: 200 },
      { tool: "sonar-coverage", pattern: "src/app/**", reason, line: 201 },
      { tool: "coverage-scope", pattern: "src/app/**", reason, line: 202 },
    ];
    const plannedContext = { ...context, exclusions: planned };
    expect(checkExclusionsListed(memoryRepo(configs), plannedContext)).toEqual([]);

    const properties = lines(
      "sonar.projectKey=postgres-rls-leak-tester",
      "# a comment",
      "sonar.exclusions=e2e/**, \\",
      "  public/pglite/**",
      "sonar.coverage.exclusions=src/app/**",
      "sonar.issue.ignore.multicriteria.e1.ruleKey=typescript:S1234",
    );
    expect(parseSonarProperties(properties)).toEqual([
      { tool: "sonar", pattern: "e2e/**", line: 3 },
      { tool: "sonar", pattern: "public/pglite/**", line: 3 },
      { tool: "sonar-coverage", pattern: "src/app/**", line: 5 },
      {
        tool: "sonar-issue",
        pattern: "sonar.issue.ignore.multicriteria.e1.ruleKey=typescript:S1234",
        line: 6,
      },
    ]);
    const repo = memoryRepo({ ...configs, "sonar-project.properties": properties });
    expect(summarize(checkExclusionsListed(repo, plannedContext))).toEqual([
      "QUAL-001 sonar-project.properties:3",
      "QUAL-001 sonar-project.properties:6",
    ]);
  });

  it("reads ESLint ignores through constants, block ignores and switched-off rules", () => {
    const config = lines(
      'const EXT = "{ts,tsx}";',
      "const CONFIG_DIR = [`src/lib/config/**/*.${EXT}`];",
      'const GENERATED = ["generated/**", ...CONFIG_DIR];',
      "export default [",
      "  { files: SRC, ignores: CONFIG_DIR, rules: {} },",
      "  { ignores: GENERATED },",
      "  { ignores: computeIgnores() },",
      '  { rules: { "no-console": "off", "react/no-danger": 0, semi: ["off"], "max-depth": ["error", 0] } },',
      '  // { ignores: ["commented/**"] }',
      "];",
    );
    expect(parseEslintConfig(config)).toEqual([
      { tool: "eslint", pattern: "src/lib/config/**/*.{ts,tsx}", line: 5 },
      { tool: "eslint", pattern: "generated/**", line: 6 },
      { tool: "eslint", pattern: "src/lib/config/**/*.{ts,tsx}", line: 6 },
      { tool: "eslint", pattern: "computeIgnores()", line: 7 },
      { tool: "eslint-rule-off", pattern: "no-console", line: 8 },
      { tool: "eslint-rule-off", pattern: "react/no-danger", line: 8 },
      { tool: "eslint-rule-off", pattern: "semi", line: 8 },
    ]);
  });

  it("fails an inline suppression without a reason and forbids @ts-ignore", () => {
    const content = lines(
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "const a: any = 1;",
      "/* eslint-disable no-console */",
      "// @ts-expect-error",
      "const b: number = 'x';",
      "// @ts-ignore",
      "const c: number = 'y';",
      "/* v8 ignore next 3 */",
      "// @ts-nocheck",
      glue("const d = 1; // NOSO", "NAR"),
    );
    expect(summarize(checkInlineSuppressions(source("src/lib/x.ts", content)))).toEqual([
      "QUAL-001 src/lib/x.ts:1",
      "QUAL-001 src/lib/x.ts:3",
      "QUAL-001 src/lib/x.ts:4",
      "QUAL-001 src/lib/x.ts:6",
      "QUAL-001 src/lib/x.ts:8",
      "QUAL-001 src/lib/x.ts:9",
      "QUAL-001 src/lib/x.ts:10",
    ]);
  });

  it("passes suppressions that say why, prose about them, and strings", () => {
    const content = lines(
      "// eslint-disable-next-line no-console -- the CLI prints its result on purpose",
      "console.log(result);",
      "// @ts-expect-error: the fixture passes a number where a string is required",
      "parse(1);",
      "/* v8 ignore next 3 -- unreachable: the switch above is exhaustive */",
      glue("const d = legacy(); // NOSO", "NAR: the vendored parser needs this exact call"),
      "// We never use eslint-disable without a reason.",
      'const text = "// eslint-disable-next-line";',
      "/* v8 ignore stop */",
    );
    expect(checkInlineSuppressions(source("src/lib/x.ts", content))).toEqual([]);
    expect(checkInlineSuppressions(source("docs/notes.md", "// @ts-ignore"))).toEqual([]);
  });
});
