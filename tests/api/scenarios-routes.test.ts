/**
 * The route files themselves: thin wiring over `@/lib/store/server`. The configuration, the
 * cookie jar of Next.js and `@supabase/ssr` are mocked, so no test reaches a Supabase project
 * (TEST-001) and the environment of whoever runs the tests cannot leak in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseServerEnv, type EnvRecord } from "@/lib/config/env";
import { resetRedisServices } from "@/lib/redis";
import { scenarioResponseSchema, storeErrorBodySchema } from "@/lib/store";

import { ALICE, createFakeSupabase, jsonRequest, sampleScenario } from "../store/fixtures";

const state = vi.hoisted(
  (): {
    env: Record<string, string | undefined>;
    jar: Map<string, string>;
    created: Array<{ url: string; key: string }>;
    client: unknown;
    cookiesFail: boolean;
  } => ({ env: {}, jar: new Map(), created: [], client: undefined, cookiesFail: false }),
);

vi.mock("@/lib/config/server", () => ({
  getServerConfig: () => parseServerEnv(state.env as EnvRecord),
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (state.cookiesFail) throw new Error("cookies() outside a request scope");
    return {
      getAll: () => [...state.jar].map(([name, value]) => ({ name, value, extra: "dropped" })),
      set: (name: string, value: string) => {
        if (name === "read-only") throw new Error("cookies can only be modified in a handler");
        state.jar.set(name, value);
      },
    };
  },
}));

interface CookieMethods {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (list: Array<{ name: string; value: string; options: object }>) => void;
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, options: { cookies: CookieMethods }) => {
    state.created.push({ url, key });
    // What the real client does on a token refresh: read the jar, write the new session back.
    const seen = options.cookies.getAll();
    options.cookies.setAll([
      { name: "sb-session", value: `refreshed:${seen.length}`, options: {} },
      { name: "read-only", value: "x", options: {} },
    ]);
    return state.client;
  },
}));

const SUPABASE_ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-for-tests",
  NEXT_PUBLIC_SITE_URL: "https://rls.example",
};

const SOME_ID = "10000000-0000-4000-8000-000000000001";
const idContext = { params: Promise.resolve({ id: SOME_ID }) };
const slugContext = { params: Promise.resolve({ slug: "some-slug" }) };

afterEach(() => {
  state.env = {};
  state.jar = new Map();
  state.created = [];
  state.client = undefined;
  state.cookiesFail = false;
  resetRedisServices();
});

function methodsOf(route: Record<string, unknown>): string[] {
  return Object.keys(route)
    .filter((name) => /^[A-Z]+$/.test(name))
    .sort();
}

describe("the scenario routes", () => {
  it("run on the Node.js runtime, dynamically, and export exactly their methods", async () => {
    const collection = await import("@/app/api/scenarios/route");
    const item = await import("@/app/api/scenarios/[id]/route");
    const bySlug = await import("@/app/api/scenarios/by-slug/[slug]/route");

    for (const route of [collection, item, bySlug]) {
      expect(route.runtime).toBe("nodejs");
      expect(route.dynamic).toBe("force-dynamic");
    }
    expect(methodsOf(collection)).toEqual(["GET", "POST"]);
    expect(methodsOf(item)).toEqual(["DELETE", "GET", "PATCH"]);
    expect(methodsOf(bySlug)).toEqual(["GET"]);
  });

  it("answer 503 with a clear notice with zero environment variables", async () => {
    const collection = await import("@/app/api/scenarios/route");
    const item = await import("@/app/api/scenarios/[id]/route");
    const bySlug = await import("@/app/api/scenarios/by-slug/[slug]/route");
    const body = { scenario: sampleScenario() };

    const responses = await Promise.all([
      collection.GET(jsonRequest("GET", "/api/scenarios")),
      collection.POST(jsonRequest("POST", "/api/scenarios", body)),
      item.GET(jsonRequest("GET", `/api/scenarios/${SOME_ID}`), idContext),
      item.PATCH(jsonRequest("PATCH", `/api/scenarios/${SOME_ID}`, body), idContext),
      item.DELETE(jsonRequest("DELETE", `/api/scenarios/${SOME_ID}`), idContext),
      bySlug.GET(jsonRequest("GET", "/api/scenarios/by-slug/some-slug"), slugContext),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      const parsed = storeErrorBodySchema.parse(await response.json());
      expect(parsed.error.code).toBe("not_configured");
      expect(parsed.error.message).toMatch(/Sharing is not configured/);
    }
    expect(state.created).toEqual([]);
  });

  it("build one Supabase client per request from the cookies, with the anon key", async () => {
    state.env = SUPABASE_ENV;
    state.jar.set("sb-session", "token");
    const supabase = createFakeSupabase();
    supabase.user = ALICE;
    state.client = supabase.client;
    const { POST } = await import("@/app/api/scenarios/route");
    const { GET } = await import("@/app/api/scenarios/by-slug/[slug]/route");

    const created = await POST(
      jsonRequest("POST", "/api/scenarios", { scenario: sampleScenario(), visibility: "unlisted" }),
    );
    const { scenario } = scenarioResponseSchema.parse(await created.json());
    const read = await GET(jsonRequest("GET", `/api/scenarios/by-slug/${scenario.slug}`), {
      params: Promise.resolve({ slug: scenario.slug }),
    });

    expect(created.status).toBe(201);
    expect(read.status).toBe(200);
    expect(state.created).toEqual([
      { url: "https://project.supabase.example", key: "anon-key-for-tests" },
      { url: "https://project.supabase.example", key: "anon-key-for-tests" },
    ]);
    // A refreshed session is written back; a jar that cannot be written does not fail the request.
    expect(state.jar.get("sb-session")).toBe("refreshed:1");
  });

  it("validate the route parameter", async () => {
    state.env = SUPABASE_ENV;
    const supabase = createFakeSupabase();
    state.client = supabase.client;
    const { GET } = await import("@/app/api/scenarios/[id]/route");

    const response = await GET(jsonRequest("GET", "/api/scenarios/1%20or%201=1"), {
      params: Promise.resolve({ id: "1 or 1=1" }),
    });

    expect(response.status).toBe(404);
    expect(supabase.statements).toEqual([]);
  });
});

describe("GET /auth/callback", () => {
  it("exchanges the code and redirects to a path on the site", async () => {
    state.env = SUPABASE_ENV;
    const supabase = createFakeSupabase();
    state.client = supabase.client;
    const { GET, runtime } = await import("@/app/auth/callback/route");

    const response = await GET(
      new Request("http://internal:3000/auth/callback?code=abc&next=%2Fs%2Fsome-slug%3Ftab%3D1"),
    );

    expect(runtime).toBe("nodejs");
    expect(supabase.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://rls.example/s/some-slug?tab=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    "https://evil.example/lab",
    "//evil.example/lab",
    "/\\evil.example/lab",
    "/\t/evil.example/lab",
    "\\\\evil.example",
    "javascript:alert(1)",
    "https://rls.example@evil.example/",
    "/auth/callback?next=/lab",
    "lab",
    "",
  ])("refuses the open redirect %j and lands on /lab", async (next) => {
    state.env = SUPABASE_ENV;
    state.client = createFakeSupabase().client;
    const { GET } = await import("@/app/auth/callback/route");

    const response = await GET(
      new Request(`https://rls.example/auth/callback?code=abc&next=${encodeURIComponent(next)}`),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://rls.example/lab");
  });

  it("falls back to the origin of the request when no site URL is configured", async () => {
    state.env = { ...SUPABASE_ENV, NEXT_PUBLIC_SITE_URL: undefined };
    state.client = createFakeSupabase().client;
    const { GET } = await import("@/app/auth/callback/route");

    const response = await GET(
      new Request("http://localhost:3000/auth/callback?code=abc&next=https%3A%2F%2Fevil.example"),
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/lab");
  });

  it("reports a failure as a query parameter, never as a redirect elsewhere", async () => {
    const { GET } = await import("@/app/auth/callback/route");
    const at = (query: string) => GET(new Request(`https://rls.example/auth/callback${query}`));
    const location = async (response: Promise<Response>) =>
      (await response).headers.get("location");

    expect(await location(at("?code=abc"))).toBe(
      "https://rls.example/lab?auth_error=not_configured",
    );

    state.env = SUPABASE_ENV;
    const supabase = createFakeSupabase();
    state.client = supabase.client;
    expect(await location(at("?next=%2Flab"))).toBe(
      "https://rls.example/lab?auth_error=missing_code",
    );
    expect(await location(at("?error=access_denied&error_description=no"))).toBe(
      "https://rls.example/lab?auth_error=provider_error",
    );
    expect(await location(at(`?code=${"x".repeat(2000)}`))).toBe(
      "https://rls.example/lab?auth_error=missing_code",
    );

    supabase.exchangeCodeForSession.mockResolvedValueOnce({ error: { name: "AuthApiError" } });
    expect(await location(at("?code=abc&next=%2Flab%3Fauth_error%3Dold"))).toBe(
      "https://rls.example/lab?auth_error=exchange_failed",
    );
    supabase.exchangeCodeForSession.mockRejectedValueOnce(new Error("network"));
    expect(await location(at("?code=abc"))).toBe(
      "https://rls.example/lab?auth_error=exchange_failed",
    );
    expect(await location(at("?code=abc&next=%2Flab%3Fauth_error%3Dold"))).toBe(
      "https://rls.example/lab",
    );
  });
});

describe("POST /auth/signout", () => {
  it("signs this browser out and redirects with 303", async () => {
    state.env = SUPABASE_ENV;
    const supabase = createFakeSupabase();
    state.client = supabase.client;
    const route = await import("@/app/auth/signout/route");

    const response = await route.POST(
      new Request("https://rls.example/auth/signout?next=%2F%2Fevil.example", { method: "POST" }),
    );

    expect(methodsOf(route)).toEqual(["POST"]);
    expect(supabase.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://rls.example/");
  });

  it("ignores a cross-site post, survives a failing sign-out, and works unconfigured", async () => {
    const { POST } = await import("@/app/auth/signout/route");
    const post = (headers: Record<string, string> = {}) =>
      POST(new Request("https://rls.example/auth/signout?next=/lab", { method: "POST", headers }));

    expect((await post()).headers.get("location")).toBe("https://rls.example/lab");

    state.env = SUPABASE_ENV;
    const supabase = createFakeSupabase();
    state.client = supabase.client;
    await post({ "sec-fetch-site": "cross-site" });
    expect(supabase.signOut).not.toHaveBeenCalled();

    supabase.signOut.mockRejectedValueOnce(new Error("network"));
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(303);
  });
});

describe("resolveRequestUserId (the per-user limit of /api/explain)", () => {
  it("is undefined without Supabase, without a session, and when anything fails", async () => {
    const { resolveRequestUserId } = await import("@/lib/store/server/next");

    expect(await resolveRequestUserId()).toBeUndefined();
    expect(state.created).toEqual([]);

    state.env = SUPABASE_ENV;
    const supabase = createFakeSupabase();
    state.client = supabase.client;
    expect(await resolveRequestUserId()).toBeUndefined();

    supabase.user = ALICE;
    expect(await resolveRequestUserId()).toBe(ALICE);

    supabase.authOutage = true;
    expect(await resolveRequestUserId()).toBeUndefined();

    state.cookiesFail = true;
    expect(await resolveRequestUserId()).toBeUndefined();
  });

  it("is wired into the explain route", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../../src/app/api/explain/route.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("resolveUserId: resolveRequestUserId");
  });
});

describe("loadSharedScenario (for the /s/[slug] Server Component)", () => {
  it("reads through the same path as the by-slug route and never throws a known failure", async () => {
    const { loadSharedScenario } = await import("@/lib/store/server/next");
    const { parseScenarioSlugParams } = await import("@/lib/store/server");
    const load = (slug: unknown) => loadSharedScenario(parseScenarioSlugParams({ slug }));

    expect(await load("alice-unlisted")).toEqual({ status: "not_configured" });
    expect(await load("../x")).toEqual({ status: "not_found" });

    state.env = SUPABASE_ENV;
    const supabase = createFakeSupabase();
    state.client = supabase.client;
    supabase.seed({ slug: "alice-unlisted", owner: ALICE, visibility: "unlisted" });
    supabase.seed({ slug: "garbage", owner: ALICE, visibility: "public", payload: [] });

    expect(await load("alice-unlisted")).toMatchObject({
      status: "ok",
      scenario: { slug: "alice-unlisted", ownedByMe: false },
    });
    expect(await load("nobody-has-this")).toEqual({ status: "not_found" });
    expect(await load("garbage")).toEqual({ status: "corrupt" });

    supabase.failWith = { code: "", message: "fetch failed" };
    expect(await load("another-slug")).toEqual({ status: "unavailable" });
    // The first answer came from the cache this time: the database is down and it still works.
    expect(await load("alice-unlisted")).toMatchObject({ status: "ok" });
  });
});
