/**
 * `createRemoteScenarioStore` against a FAKE fetch (TEST-001). Most cases route the fake fetch
 * into the real handlers with the mocked Supabase client, so the client and the server are
 * proven to speak the same wire format; the rest feeds canned answers.
 */
import { describe, expect, it, vi } from "vitest";

import { StoreError, createRemoteScenarioStore, type FetchLike } from "@/lib/store";
import {
  handleCreateScenario,
  handleDeleteScenario,
  handleGetScenario,
  handleGetScenarioBySlug,
  handleListScenarios,
  handleUpdateScenario,
  parseScenarioIdParams,
  parseScenarioSlugParams,
} from "@/lib/store/server";

import { ALICE, BOB, createApiHarness, sampleScenario, type ApiHarness } from "./fixtures";

/** A fetch that dispatches to the handlers the way the route files do. */
function fetchInto(harness: ApiHarness): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const send: FetchLike = async (input, init) => {
    const request = new Request(`http://localhost${input}`, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (path === "/api/scenarios") {
      return request.method === "POST"
        ? handleCreateScenario(request, harness.deps)
        : handleListScenarios(request, harness.deps);
    }
    const bySlug = /^\/api\/scenarios\/by-slug\/([^/]+)$/.exec(path);
    if (bySlug !== null) {
      const slug = parseScenarioSlugParams({ slug: bySlug[1] });
      return handleGetScenarioBySlug(request, slug, harness.deps);
    }
    const id = parseScenarioIdParams({ id: path.slice("/api/scenarios/".length) });
    if (request.method === "PATCH") return handleUpdateScenario(request, id, harness.deps);
    if (request.method === "DELETE") return handleDeleteScenario(request, id, harness.deps);
    return handleGetScenario(request, id, harness.deps);
  };
  return Object.assign(send, { calls });
}

async function storeError(work: Promise<unknown>): Promise<StoreError> {
  const error: unknown = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof StoreError))
    throw new Error(`expected a StoreError, got ${String(error)}`);
  return error;
}

describe("createRemoteScenarioStore over the real handlers", () => {
  it("saves, lists, reads, updates and removes through /api/scenarios", async () => {
    const harness = createApiHarness();
    harness.supabase.user = ALICE;
    const fetchImpl = fetchInto(harness);
    const store = createRemoteScenarioStore(fetchImpl);

    expect(store.kind).toBe("supabase");
    const saved = await store.save({ scenario: sampleScenario(), visibility: "unlisted" });
    expect(saved).toMatchObject({
      visibility: "unlisted",
      ownedByMe: true,
      title: "Sample scenario",
    });

    expect(await store.list()).toEqual([
      {
        id: saved.id,
        slug: saved.slug,
        title: saved.title,
        visibility: "unlisted",
        updatedAt: saved.updatedAt,
      },
    ]);
    expect(await store.get(saved.id)).toEqual(saved);
    expect(await store.getBySlug(saved.slug)).toEqual(saved);

    const renamed = await store.save({
      id: saved.id,
      scenario: sampleScenario({ title: "Renamed" }),
    });
    expect(renamed).toMatchObject({ id: saved.id, slug: saved.slug, title: "Renamed" });
    // The visibility was not sent, so it did not change.
    expect(renamed.visibility).toBe("unlisted");

    await store.remove(saved.id);
    await store.remove(saved.id);
    expect(await store.get(saved.id)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(fetchImpl.calls).toContain(`PATCH /api/scenarios/${saved.id}`);
  });

  it("opens a shared scenario without a session and reports ownership honestly", async () => {
    const harness = createApiHarness();
    harness.supabase.seed({ slug: "alice-unlisted", owner: ALICE, visibility: "unlisted" });
    harness.supabase.seed({ slug: "alice-private", owner: ALICE, visibility: "private" });
    const store = createRemoteScenarioStore(fetchInto(harness));

    expect((await store.getBySlug("alice-unlisted"))?.ownedByMe).toBe(false);
    expect(await store.getBySlug("alice-private")).toBeNull();
  });

  it("turns the server's refusals into typed errors", async () => {
    const harness = createApiHarness();
    const row = harness.supabase.seed({ slug: "alice-public", owner: ALICE, visibility: "public" });
    const store = createRemoteScenarioStore(fetchInto(harness));

    expect((await storeError(store.list())).code).toBe("unauthenticated");
    expect((await storeError(store.save({ scenario: sampleScenario() }))).code).toBe(
      "unauthenticated",
    );

    harness.supabase.user = BOB;
    expect((await storeError(store.save({ id: row.id, scenario: sampleScenario() }))).code).toBe(
      "forbidden",
    );
    expect((await storeError(store.remove(row.id))).code).toBe("forbidden");

    const invalid = await storeError(
      store.save({ scenario: { ...sampleScenario(), mode: "oracle" } as never }),
    );
    expect(invalid.code).toBe("invalid");
    expect(invalid.issues).toEqual([{ path: "scenario.mode", message: expect.any(String) }]);
  });

  it("reports not_configured from a deployment without Supabase", async () => {
    const store = createRemoteScenarioStore(fetchInto(createApiHarness({ configured: false })));

    const error = await storeError(store.getBySlug("some-slug"));

    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("not configured");
  });
});

describe("createRemoteScenarioStore with canned answers", () => {
  const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
    Response.json(body, { status, headers });

  it("never asks the server about an id or a slug that cannot exist", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const store = createRemoteScenarioStore(fetchImpl);

    expect(await store.get("local-id-abc")).toBeNull();
    expect(await store.getBySlug("../admin")).toBeNull();
    await store.remove("local-id-abc");
    expect(
      (await storeError(store.save({ id: "local-id-abc", scenario: sampleScenario() }))).code,
    ).toBe("not_found");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends same-origin credentials and JSON, to the app's own routes only", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ scenarios: [] }, 200));
    await createRemoteScenarioStore(fetchImpl).list();

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/scenarios",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("carries Retry-After of a 429 into the error", async () => {
    const fetchImpl: FetchLike = async () =>
      json({ error: { code: "rate_limited", message: "Too many changes." } }, 429, {
        "Retry-After": "17",
      });

    const error = await storeError(
      createRemoteScenarioStore(fetchImpl).save({ scenario: sampleScenario() }),
    );

    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(17);
  });

  it("refuses answers it cannot validate", async () => {
    const answers: Response[] = [
      json({ scenarios: [{ id: "x" }] }, 200),
      json({ scenario: { id: "10000000-0000-4000-8000-000000000001" } }, 200),
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      json({ error: { code: "made_up", message: "?" } }, 500),
    ];
    const fetchImpl: FetchLike = async () => answers.shift() ?? json({}, 500);
    const store = createRemoteScenarioStore(fetchImpl);

    expect((await storeError(store.list())).code).toBe("invalid_response");
    expect((await storeError(store.getBySlug("some-slug"))).code).toBe("invalid_response");
    expect((await storeError(store.list())).code).toBe("invalid_response");
    expect((await storeError(store.list())).message).toContain("500");
  });

  it("refuses a scenario from the server that does not pass parseScenario", async () => {
    const fetchImpl: FetchLike = async () =>
      json(
        {
          scenario: {
            id: "10000000-0000-4000-8000-000000000001",
            slug: "some-slug",
            title: "T",
            visibility: "public",
            updatedAt: "2026-09-01T00:00:00.000Z",
            ownedByMe: false,
            scenario: { ...sampleScenario(), personas: "none" },
          },
        },
        200,
      );

    expect(
      (await storeError(createRemoteScenarioStore(fetchImpl).getBySlug("some-slug"))).code,
    ).toBe("invalid_response");
  });

  it("reports a request that never got an answer as network", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };

    const error = await storeError(createRemoteScenarioStore(fetchImpl).list());

    expect(error.code).toBe("network");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("uses the global fetch when none is given", async () => {
    const globalFetch = vi.fn(async () => json({ scenarios: [] }, 200));
    vi.stubGlobal("fetch", globalFetch);
    try {
      expect(await createRemoteScenarioStore().list()).toEqual([]);
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
