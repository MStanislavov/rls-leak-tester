/**
 * The `/api/scenarios` handlers with a MOCKED Supabase client and the in-memory Redis adapters
 * (rules.yaml TEST-001: no network). The real policies are proven in
 * `tests/store/migration.test.ts`; here the server's own first line of defence is.
 */
import { describe, expect, it, vi } from "vitest";

import { RATE_LIMITS, RedisUnavailableError } from "@/lib/redis";
import {
  scenarioListResponseSchema,
  scenarioResponseSchema,
  storeErrorBodySchema,
} from "@/lib/store";
import {
  SCENARIO_BODY_MAX_BYTES,
  handleCreateScenario,
  handleDeleteScenario,
  handleGetScenario,
  handleGetScenarioBySlug,
  handleListScenarios,
  handleUpdateScenario,
  parseScenarioIdParams,
  parseScenarioSlugParams,
  statusOfStoreError,
  type ParamResult,
} from "@/lib/store/server";

import { ALICE, BOB, createApiHarness, jsonRequest, sampleScenario } from "../store/fixtures";

const id = (value: string): ParamResult => parseScenarioIdParams({ id: value });
const slug = (value: string): ParamResult => parseScenarioSlugParams({ slug: value });

async function errorCode(response: Response): Promise<string> {
  return storeErrorBodySchema.parse(await response.json()).error.code;
}

describe("without Supabase every route answers 503 not_configured", () => {
  const harness = createApiHarness({ configured: false });
  const someId = id("10000000-0000-4000-8000-000000000001");

  it.each([
    ["GET /api/scenarios", () => handleListScenarios(jsonRequest("GET", "/"), harness.deps)],
    [
      "POST /api/scenarios",
      () =>
        handleCreateScenario(
          jsonRequest("POST", "/", { scenario: sampleScenario() }),
          harness.deps,
        ),
    ],
    [
      "GET /api/scenarios/[id]",
      () => handleGetScenario(jsonRequest("GET", "/"), someId, harness.deps),
    ],
    [
      "PATCH /api/scenarios/[id]",
      () =>
        handleUpdateScenario(
          jsonRequest("PATCH", "/", { visibility: "public" }),
          someId,
          harness.deps,
        ),
    ],
    [
      "DELETE /api/scenarios/[id]",
      () => handleDeleteScenario(jsonRequest("DELETE", "/"), someId, harness.deps),
    ],
    [
      "GET /api/scenarios/by-slug/[slug]",
      () => handleGetScenarioBySlug(jsonRequest("GET", "/"), slug("some-slug"), harness.deps),
    ],
  ])("%s", async (_name, call) => {
    const response = await call();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = storeErrorBodySchema.parse(await response.json());
    expect(body.error.code).toBe("not_configured");
    expect(body.error.message).toContain("not configured");
    expect(harness.supabase.statements).toEqual([]);
  });
});

describe("POST /api/scenarios", () => {
  it("refuses an unauthenticated write with 401 before it reads the body", async () => {
    const harness = createApiHarness();
    const request = jsonRequest("POST", "/api/scenarios", { scenario: sampleScenario() });

    const response = await handleCreateScenario(request, harness.deps);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthenticated");
    expect(request.bodyUsed).toBe(false);
    expect(harness.supabase.rows).toEqual([]);
  });

  it("creates a private scenario with a server-made slug and answers 201", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;

    const response = await handleCreateScenario(
      jsonRequest("POST", "/api/scenarios", { scenario: sampleScenario() }),
      harness.deps,
    );

    expect(response.status).toBe(201);
    const { scenario } = scenarioResponseSchema.parse(await response.json());
    expect(scenario).toMatchObject({
      title: "Sample scenario",
      visibility: "private",
      ownedByMe: true,
      scenario: sampleScenario(),
    });
    expect(scenario.slug).toMatch(/^sample-scenario-[a-z2-7]{16}$/);
    expect(scenario.updatedAt).toMatch(/Z$/);
    expect(response.headers.get("location")).toBe(`/api/scenarios/${scenario.id}`);
    expect(response.headers.get("ratelimit-limit")).toBe(
      String(RATE_LIMITS["scenario-writes"].perIp),
    );
    expect(harness.supabase.rows[0]).toMatchObject({ owner: ALICE, slug: scenario.slug });
    expect(harness.events).toEqual([
      { event: "scenarios", action: "create", status: 201, durationMs: expect.any(Number) },
    ]);
  });

  it("never takes a slug, an id or an owner from the caller", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;

    const response = await handleCreateScenario(
      jsonRequest("POST", "/api/scenarios", {
        scenario: sampleScenario(),
        slug: "my-vanity-slug",
        owner: BOB,
      }),
      harness.deps,
    );

    expect(response.status).toBe(400);
    expect(harness.supabase.rows).toEqual([]);
  });

  it("retries on a slug collision and gives up after the configured attempts", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;
    const post = () =>
      handleCreateScenario(
        jsonRequest("POST", "/api/scenarios", {
          scenario: sampleScenario(),
          visibility: "unlisted",
        }),
        harness.deps,
      );

    harness.supabase.slugCollisions = 2;
    expect((await post()).status).toBe(201);
    expect(harness.supabase.statements.filter((s) => s === "insert:scenarios")).toHaveLength(3);

    harness.supabase.slugCollisions = 5;
    const response = await post();
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("unavailable");
  });

  it.each([
    ["a body that is not JSON", "{nope", {}],
    ["an unknown field", { scenario: sampleScenario(), extra: 1 }, {}],
    ["an unknown visibility", { scenario: sampleScenario(), visibility: "secret" }, {}],
    ["a missing scenario", { visibility: "public" }, {}],
    ["an invalid scenario", { scenario: { ...sampleScenario(), mode: "oracle" } }, {}],
    ["a wrong media type", { scenario: sampleScenario() }, { "content-type": "text/plain" }],
  ])("answers 400 for %s", async (_name, body, headers) => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;

    const response = await handleCreateScenario(
      jsonRequest("POST", "/api/scenarios", body, headers),
      harness.deps,
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid");
    expect(harness.supabase.rows).toEqual([]);
  });

  it("names the field of an invalid scenario, never its value", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;

    const response = await handleCreateScenario(
      jsonRequest("POST", "/api/scenarios", {
        scenario: { ...sampleScenario(), mode: "oracle-secret-value" },
      }),
      harness.deps,
    );
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({ error: { issues: [{ path: "scenario.mode" }] } });
    expect(text).not.toContain("oracle-secret-value");
  });

  it("answers 400 for a body that is not UTF-8 or is missing", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;
    const headers = { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" };

    const notUtf8 = await handleCreateScenario(
      new Request("http://localhost/api/scenarios", {
        method: "POST",
        headers,
        body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      }),
      harness.deps,
    );
    const empty = await handleCreateScenario(
      new Request("http://localhost/api/scenarios", { method: "POST", headers }),
      harness.deps,
    );

    expect([notUtf8.status, empty.status]).toEqual([400, 400]);
  });

  it("answers 413 by the declared and by the counted size, without buffering the rest", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;

    const declared = await handleCreateScenario(
      jsonRequest("POST", "/api/scenarios", "{}", {
        "content-length": String(SCENARIO_BODY_MAX_BYTES + 1),
      }),
      harness.deps,
    );
    expect(declared.status).toBe(413);

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;
        controller.enqueue(new Uint8Array(256 * 1024).fill(0x20));
      },
    });
    const counted = await handleCreateScenario(
      new Request("http://localhost/api/scenarios", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: endless,
        duplex: "half",
      } as RequestInit),
      harness.deps,
    );
    expect(counted.status).toBe(413);
    expect(await errorCode(counted)).toBe("too_large");
    expect(pulled).toBeLessThan(10);
  });

  it("answers 429 with the rate limit headers once the address is over its budget", async () => {
    const harness = createApiHarness();
    const { perIp } = RATE_LIMITS["scenario-writes"];
    const post = () =>
      handleCreateScenario(
        jsonRequest("POST", "/api/scenarios", { scenario: sampleScenario() }),
        harness.deps,
      );

    // Nobody is signed in: the limit applies before the session is even looked at.
    for (let index = 0; index < perIp; index += 1) expect((await post()).status).toBe(401);
    const response = await post();

    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe("rate_limited");
    expect(response.headers.get("ratelimit-limit")).toBe(String(perIp));
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(Number(response.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("keeps an anonymous caller in one bucket whatever it writes in front of the proxy's hop", async () => {
    const harness = createApiHarness();
    const { perIp } = RATE_LIMITS["scenario-writes"];
    const statuses: number[] = [];

    // An appending proxy forwards "what the caller sent, the caller's address".
    for (let index = 0; index < perIp + 3; index += 1) {
      const response = await handleCreateScenario(
        jsonRequest(
          "POST",
          "/api/scenarios",
          { scenario: sampleScenario() },
          { "x-forwarded-for": `10.0.0.${index}, 198.51.100.9` },
        ),
        harness.deps,
      );
      statuses.push(response.status);
    }

    expect(statuses).toEqual([...Array.from({ length: perIp }, () => 401), 429, 429, 429]);
  });

  it("limits a user across addresses", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;
    const { perUser } = RATE_LIMITS["scenario-writes"];
    const post = (index: number) =>
      handleCreateScenario(
        jsonRequest(
          "POST",
          "/api/scenarios",
          { scenario: sampleScenario() },
          {
            "x-forwarded-for": `198.51.100.${index % 250}`,
          },
        ),
        harness.deps,
      );

    for (let index = 0; index < perUser; index += 1) expect((await post(index)).status).toBe(201);
    const response = await post(perUser);

    expect(response.status).toBe(429);
    expect(response.headers.get("ratelimit-limit")).toBe(String(perUser));
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(harness.supabase.rows).toHaveLength(perUser);
  });

  it("refuses a cross-site request whatever the session", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;

    const response = await handleCreateScenario(
      jsonRequest(
        "POST",
        "/api/scenarios",
        { scenario: sampleScenario() },
        {
          "sec-fetch-site": "cross-site",
        },
      ),
      harness.deps,
    );

    expect(response.status).toBe(403);
    expect(harness.supabase.rows).toEqual([]);
  });

  it("fails closed with 503 when the limiter is down, and when Supabase Auth is down", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;
    const request = () => jsonRequest("POST", "/api/scenarios", { scenario: sampleScenario() });

    const limiterDown = await handleCreateScenario(request(), {
      ...harness.deps,
      limiter: { check: () => Promise.reject(new RedisUnavailableError("rateLimiter.check")) },
    });
    expect(limiterDown.status).toBe(503);
    expect(limiterDown.headers.get("retry-after")).toBe("30");

    harness.supabase.authOutage = true;
    const authDown = await handleCreateScenario(request(), harness.deps);
    expect(authDown.status).toBe(503);
    expect(await errorCode(authDown)).toBe("unavailable");
    expect(harness.supabase.rows).toEqual([]);
  });

  it("maps database failures without forwarding their text", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;
    const post = () =>
      handleCreateScenario(
        jsonRequest("POST", "/api/scenarios", { scenario: sampleScenario() }),
        harness.deps,
      );

    harness.supabase.failWith = {
      code: "42501",
      message: "new row violates policy scenarios_owner_all",
    };
    const refused = await post();
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("scenarios_owner_all");

    harness.supabase.failWith = { code: "23514", message: "scenarios_payload_size" };
    expect((await post()).status).toBe(400);

    harness.supabase.failWith = { code: "", message: "fetch failed" };
    expect((await post()).status).toBe(503);
  });

  it("rethrows what it does not know", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;

    await expect(
      handleCreateScenario(jsonRequest("POST", "/api/scenarios", { scenario: sampleScenario() }), {
        ...harness.deps,
        limiter: { check: () => Promise.reject(new TypeError("bug")) },
      }),
    ).rejects.toThrow("bug");
  });
});

describe("GET /api/scenarios", () => {
  it("needs a session", async () => {
    const harness = createApiHarness();
    const response = await handleListScenarios(jsonRequest("GET", "/api/scenarios"), harness.deps);
    expect(response.status).toBe(401);
  });

  it("lists the caller's own scenarios only, newest first, without payloads", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "alice-old", owner: ALICE, visibility: "private" });
    harness.supabase.seed({ slug: "bob-public", owner: BOB, visibility: "public" });
    harness.supabase.seed({ slug: "alice-new", owner: ALICE, visibility: "unlisted" });
    harness.supabase.user = ALICE;

    const response = await handleListScenarios(jsonRequest("GET", "/api/scenarios"), harness.deps);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(scenarioListResponseSchema.parse(JSON.parse(text)).scenarios.map((s) => s.slug)).toEqual(
      ["alice-new", "alice-old"],
    );
    expect(text).not.toContain("schemaSql");
    expect(text).not.toContain(ALICE);
  });

  it("answers 422 when the database returns rows it cannot read", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "NOT A SLUG", owner: ALICE, visibility: "private" });
    harness.supabase.user = ALICE;

    const response = await handleListScenarios(jsonRequest("GET", "/api/scenarios"), harness.deps);

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("corrupt");
  });
});

describe("GET /api/scenarios/by-slug/[slug]", () => {
  it("serves public and unlisted scenarios to anybody and private ones to the owner only", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "alice-public", owner: ALICE, visibility: "public" });
    harness.supabase.seed({ slug: "alice-unlisted", owner: ALICE, visibility: "unlisted" });
    harness.supabase.seed({ slug: "alice-private", owner: ALICE, visibility: "private" });
    const get = (value: string) =>
      handleGetScenarioBySlug(jsonRequest("GET", "/"), slug(value), harness.deps);

    expect((await get("alice-public")).status).toBe(200);
    const unlisted = await get("alice-unlisted");
    expect(scenarioResponseSchema.parse(await unlisted.json()).scenario.ownedByMe).toBe(false);
    expect((await get("alice-private")).status).toBe(404);

    harness.supabase.user = BOB;
    expect((await get("alice-private")).status).toBe(404);

    harness.supabase.user = ALICE;
    const mine = await get("alice-private");
    expect(scenarioResponseSchema.parse(await mine.json()).scenario.ownedByMe).toBe(true);
  });

  it("never puts the owner id on the wire", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "alice-public", owner: ALICE, visibility: "public" });

    const response = await handleGetScenarioBySlug(
      jsonRequest("GET", "/"),
      slug("alice-public"),
      harness.deps,
    );
    const body = (await response.json()) as { scenario: Record<string, unknown> };

    expect(Object.keys(body.scenario).sort()).toEqual(
      ["id", "ownedByMe", "scenario", "slug", "title", "updatedAt", "visibility"].sort(),
    );
  });

  it("answers the second read from the cache, and computes ownedByMe per caller", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "alice-unlisted", owner: ALICE, visibility: "unlisted" });
    const get = () =>
      handleGetScenarioBySlug(jsonRequest("GET", "/"), slug("alice-unlisted"), harness.deps);

    expect((await get()).status).toBe(200);
    harness.supabase.user = ALICE;
    const second = await get();

    expect(harness.supabase.statements).toEqual(["rpc:get_scenario_by_slug"]);
    expect(scenarioResponseSchema.parse(await second.json()).scenario.ownedByMe).toBe(true);
    const key = harness.services.keys.scenario("alice-unlisted");
    expect(await harness.services.cache.get(key)).toContain("alice-unlisted");
  });

  it("never caches a private scenario: the next caller must not get it from the cache", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "alice-private", owner: ALICE, visibility: "private" });
    const get = () =>
      handleGetScenarioBySlug(jsonRequest("GET", "/"), slug("alice-private"), harness.deps);

    harness.supabase.user = ALICE;
    expect((await get()).status).toBe(200);
    expect(await harness.services.cache.get(harness.services.keys.scenario("alice-private"))).toBe(
      undefined,
    );

    harness.supabase.user = BOB;
    expect((await get()).status).toBe(404);
  });

  it("treats a cache entry it cannot validate as a miss, and a private one too", async () => {
    const harness = createApiHarness();
    const row = harness.supabase.seed({ slug: "alice-public", owner: ALICE, visibility: "public" });
    const key = harness.services.keys.scenario("alice-public");
    const get = () =>
      handleGetScenarioBySlug(jsonRequest("GET", "/"), slug("alice-public"), harness.deps);

    await harness.services.cache.set(key, "{broken", 60);
    expect((await get()).status).toBe(200);
    await harness.services.cache.set(
      key,
      JSON.stringify({ ...row, visibility: "private", updatedAt: "2026-09-01T00:00:00.000Z" }),
      60,
    );
    expect((await get()).status).toBe(200);

    expect(harness.supabase.statements).toEqual([
      "rpc:get_scenario_by_slug",
      "rpc:get_scenario_by_slug",
    ]);
  });

  it("still answers when the cache is down", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "alice-public", owner: ALICE, visibility: "public" });
    const down = () => Promise.reject(new RedisUnavailableError("cache"));

    const response = await handleGetScenarioBySlug(jsonRequest("GET", "/"), slug("alice-public"), {
      ...harness.deps,
      cache: { get: down, set: down, delete: down },
    });

    expect(response.status).toBe(200);
  });

  it("answers 404 for a malformed slug without asking the database", async () => {
    const harness = createApiHarness();

    for (const params of [{ slug: "../x" }, { slug: "UPPER" }, { slug: ["a"] }, {}, null]) {
      const response = await handleGetScenarioBySlug(
        jsonRequest("GET", "/"),
        parseScenarioSlugParams(params),
        harness.deps,
      );
      expect(response.status).toBe(404);
    }
    expect(harness.supabase.statements).toEqual([]);
  });

  it("answers 422 for a stored payload that is not a scenario", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({
      slug: "garbage",
      owner: ALICE,
      visibility: "public",
      payload: { hello: "world" },
    });

    const response = await handleGetScenarioBySlug(
      jsonRequest("GET", "/"),
      slug("garbage"),
      harness.deps,
    );

    expect(response.status).toBe(422);
  });
});

describe("GET /api/scenarios/[id]", () => {
  it("returns the caller's own row or a public one, nothing else", async () => {
    const harness = createApiHarness();
    const mine = harness.supabase.seed({ slug: "bob-private", owner: BOB, visibility: "private" });
    const open = harness.supabase.seed({
      slug: "alice-public",
      owner: ALICE,
      visibility: "public",
    });
    const hidden = harness.supabase.seed({
      slug: "alice-unlisted",
      owner: ALICE,
      visibility: "unlisted",
    });
    harness.supabase.user = BOB;
    const get = (value: string) =>
      handleGetScenario(jsonRequest("GET", "/"), id(value), harness.deps);

    const own = await get(mine.id);
    expect(scenarioResponseSchema.parse(await own.json()).scenario.ownedByMe).toBe(true);
    const foreign = await get(open.id);
    expect(scenarioResponseSchema.parse(await foreign.json()).scenario.ownedByMe).toBe(false);
    expect((await get(hidden.id)).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });
});

describe("PATCH and DELETE /api/scenarios/[id]", () => {
  it("need a session", async () => {
    const harness = createApiHarness();
    const row = harness.supabase.seed({ slug: "alice-public", owner: ALICE, visibility: "public" });

    const patch = await handleUpdateScenario(
      jsonRequest("PATCH", "/", { visibility: "private" }),
      id(row.id),
      harness.deps,
    );
    const del = await handleDeleteScenario(jsonRequest("DELETE", "/"), id(row.id), harness.deps);

    expect([patch.status, del.status]).toEqual([401, 401]);
    expect(harness.supabase.rows).toHaveLength(1);
  });

  it("let the owner change the scenario and the visibility, keeping the slug", async () => {
    const harness = createApiHarness();
    const row = harness.supabase.seed({ slug: "alice-draft", owner: ALICE, visibility: "private" });
    harness.supabase.user = ALICE;

    const response = await handleUpdateScenario(
      jsonRequest("PATCH", "/", {
        scenario: sampleScenario({ title: "Second title" }),
        visibility: "unlisted",
      }),
      id(row.id),
      harness.deps,
    );

    expect(response.status).toBe(200);
    expect(scenarioResponseSchema.parse(await response.json()).scenario).toMatchObject({
      id: row.id,
      slug: "alice-draft",
      title: "Second title",
      visibility: "unlisted",
      ownedByMe: true,
    });

    const onlyVisibility = await handleUpdateScenario(
      jsonRequest("PATCH", "/", { visibility: "public" }),
      id(row.id),
      harness.deps,
    );
    expect(scenarioResponseSchema.parse(await onlyVisibility.json()).scenario).toMatchObject({
      title: "Second title",
      visibility: "public",
    });
  });

  it("answer 400 for an empty patch", async () => {
    const harness = createApiHarness();
    const row = harness.supabase.seed({ slug: "alice-draft", owner: ALICE, visibility: "private" });
    harness.supabase.user = ALICE;

    const response = await handleUpdateScenario(
      jsonRequest("PATCH", "/", {}),
      id(row.id),
      harness.deps,
    );

    expect(response.status).toBe(400);
  });

  it("refuse everybody but the owner: 403 for a row the caller can see, 404 otherwise", async () => {
    const harness = createApiHarness();
    const open = harness.supabase.seed({
      slug: "alice-public",
      owner: ALICE,
      visibility: "public",
    });
    const hidden = harness.supabase.seed({
      slug: "alice-private",
      owner: ALICE,
      visibility: "private",
    });
    harness.supabase.user = BOB;
    const patch = (value: string) =>
      handleUpdateScenario(
        jsonRequest("PATCH", "/", { visibility: "private" }),
        id(value),
        harness.deps,
      );
    const del = (value: string) =>
      handleDeleteScenario(jsonRequest("DELETE", "/"), id(value), harness.deps);

    expect((await patch(open.id)).status).toBe(403);
    expect((await del(open.id)).status).toBe(403);
    expect((await patch(hidden.id)).status).toBe(404);
    expect((await del(hidden.id)).status).toBe(404);
    expect((await del("not-a-uuid")).status).toBe(404);
    expect(harness.supabase.rows.map((row) => row.visibility)).toEqual(["public", "private"]);
  });

  it("invalidate the cached slug on every write", async () => {
    const harness = createApiHarness();
    const row = harness.supabase.seed({
      slug: "alice-shared",
      owner: ALICE,
      visibility: "unlisted",
    });
    const key = harness.services.keys.scenario("alice-shared");
    const read = () =>
      handleGetScenarioBySlug(jsonRequest("GET", "/"), slug("alice-shared"), harness.deps);

    await read();
    expect(await harness.services.cache.get(key)).toBeDefined();

    harness.supabase.user = ALICE;
    await handleUpdateScenario(
      jsonRequest("PATCH", "/", { visibility: "private" }),
      id(row.id),
      harness.deps,
    );
    expect(await harness.services.cache.get(key)).toBeUndefined();

    // What was shared a moment ago is gone for everybody else at once, not after the TTL.
    harness.supabase.user = null;
    expect((await read()).status).toBe(404);

    harness.supabase.user = ALICE;
    await handleUpdateScenario(
      jsonRequest("PATCH", "/", { visibility: "public" }),
      id(row.id),
      harness.deps,
    );
    await read();
    expect(await harness.services.cache.get(key)).toBeDefined();

    const deleted = await handleDeleteScenario(
      jsonRequest("DELETE", "/"),
      id(row.id),
      harness.deps,
    );
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await harness.services.cache.get(key)).toBeUndefined();
    expect((await read()).status).toBe(404);
  });

  it("keep the write when the cache cannot be invalidated", async () => {
    const harness = createApiHarness();
    const row = harness.supabase.seed({ slug: "alice-shared", owner: ALICE, visibility: "public" });
    harness.supabase.user = ALICE;
    const cache = {
      ...harness.services.cache,
      delete: vi.fn(() => Promise.reject(new RedisUnavailableError("cache.delete"))),
    };

    const response = await handleUpdateScenario(
      jsonRequest("PATCH", "/", { visibility: "private" }),
      id(row.id),
      { ...harness.deps, cache },
    );

    expect(response.status).toBe(200);
    expect(cache.delete).toHaveBeenCalledOnce();
  });
});

describe("statusOfStoreError", () => {
  it("maps every code in one place", () => {
    expect(statusOfStoreError("invalid")).toBe(400);
    expect(statusOfStoreError("unauthenticated")).toBe(401);
    expect(statusOfStoreError("forbidden")).toBe(403);
    expect(statusOfStoreError("not_found")).toBe(404);
    expect(statusOfStoreError("too_large")).toBe(413);
    expect(statusOfStoreError("corrupt")).toBe(422);
    expect(statusOfStoreError("rate_limited")).toBe(429);
    expect(statusOfStoreError("not_configured")).toBe(503);
    expect(statusOfStoreError("unavailable")).toBe(503);
    expect(statusOfStoreError("network")).toBe(500);
  });
});
