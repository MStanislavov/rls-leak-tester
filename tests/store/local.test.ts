import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_INDEX_KEY,
  StoreError,
  createLocalScenarioStore,
  localEntryKey,
  type StoreProblem,
} from "@/lib/store";

import { createFakeStorage, sampleScenario } from "./fixtures";

function clockFrom(start: string): () => Date {
  let time = Date.parse(start);
  return () => {
    time += 60_000;
    return new Date(time);
  };
}

function setup() {
  const storage = createFakeStorage();
  const problems: StoreProblem[] = [];
  const store = createLocalScenarioStore(storage, {
    now: clockFrom("2026-09-01T00:00:00.000Z"),
    onProblem: (problem) => problems.push(problem),
  });
  return { storage, store, problems };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error: unknown = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return error instanceof StoreError ? error.code : `not a StoreError: ${String(error)}`;
}

describe("createLocalScenarioStore", () => {
  it("is empty at first and works under a versioned key", async () => {
    const { store, storage } = setup();

    expect(store.kind).toBe("local");
    expect(await store.list()).toEqual([]);
    expect(await store.get("nothing")).toBeNull();

    const saved = await store.save({ scenario: sampleScenario() });
    expect([...storage.data.keys()].sort()).toEqual([
      "rls-leak-tester:v1:index",
      `rls-leak-tester:v1:scenario:${saved.id}`,
    ]);
  });

  it("saves a new entry with a fresh id, private, owned, slug = id", async () => {
    const { store } = setup();

    const saved = await store.save({ scenario: sampleScenario(), visibility: "public" });

    expect(saved.id).toMatch(/^sample-scenario-[a-z2-7]{10}$/);
    expect(saved).toEqual({
      id: saved.id,
      slug: saved.id,
      title: "Sample scenario",
      visibility: "private",
      updatedAt: "2026-09-01T00:01:00.000Z",
      scenario: sampleScenario(),
      ownedByMe: true,
    });
    expect(await store.get(saved.id)).toEqual(saved);
    expect(await store.getBySlug(saved.slug)).toEqual(saved);
  });

  it("replaces an entry when the id is given, and creates it when the id is new", async () => {
    const { store } = setup();
    const first = await store.save({ scenario: sampleScenario() });

    const second = await store.save({
      id: first.id,
      scenario: sampleScenario({ title: "Renamed" }),
    });
    await store.save({ id: "chosen-id", scenario: sampleScenario({ title: "Chosen" }) });

    expect(second.id).toBe(first.id);
    expect(await store.list()).toEqual([
      {
        id: "chosen-id",
        slug: "chosen-id",
        title: "Chosen",
        visibility: "private",
        updatedAt: "2026-09-01T00:03:00.000Z",
      },
      {
        id: first.id,
        slug: first.id,
        title: "Renamed",
        visibility: "private",
        updatedAt: "2026-09-01T00:02:00.000Z",
      },
    ]);
  });

  it("removes an entry and tolerates an unknown or malformed id", async () => {
    const { store, storage } = setup();
    const saved = await store.save({ scenario: sampleScenario() });

    await store.remove("unknown");
    await store.remove("../etc/passwd");
    await store.remove(saved.id);

    expect(await store.list()).toEqual([]);
    expect(storage.data.has(localEntryKey(saved.id))).toBe(false);
    expect(await store.get("../etc/passwd")).toBeNull();
  });

  it("refuses an invalid scenario, an invalid id and an oversized scenario", async () => {
    const { store, storage } = setup();
    const invalid = { ...sampleScenario(), mode: "oracle" } as unknown as ReturnType<
      typeof sampleScenario
    >;

    const error = await store.save({ scenario: invalid }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe("invalid");
    expect((error as StoreError).issues.map((issue) => issue.path)).toEqual(["mode"]);

    expect(await codeOf(store.save({ id: "no spaces", scenario: sampleScenario() }))).toBe(
      "invalid",
    );

    const big = "x".repeat(199_000);
    const huge = sampleScenario({
      schemaSql: `-- ${big}`,
      seedSql: `-- ${big}`,
      expectations: ["alice", "visitor"].flatMap((personaId) =>
        Array.from({ length: 40 }, (_, index) => ({
          personaId,
          schema: "public",
          table: `t${index}`,
          operation: "select" as const,
          scope: "custom" as const,
          expectedRowsSql: `select 1 -- ${"y".repeat(9_900)}`,
        })),
      ),
      description: "d".repeat(2_000),
    });
    // Every field is within its own limit; the whole is above the store's cap.
    expect(await codeOf(store.save({ scenario: huge }))).toBe("too_large");
    expect(storage.data.size).toBe(0);
  });

  it("surfaces a full storage as quota_exceeded and leaves no orphan entry", async () => {
    const { store, storage } = setup();
    const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });

    storage.failNextWrite(quota);
    expect(await codeOf(store.save({ scenario: sampleScenario() }))).toBe("quota_exceeded");
    expect(storage.data.size).toBe(0);

    // The entry fits, the index does not: the entry is taken back.
    const original = storage.setItem.bind(storage);
    const setItem = vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === LOCAL_INDEX_KEY) throw Object.assign(new Error("full"), { code: 22 });
      original(key, value);
    });
    expect(await codeOf(store.save({ scenario: sampleScenario() }))).toBe("quota_exceeded");
    expect(storage.data.size).toBe(0);
    setItem.mockRestore();

    storage.failNextWrite(Object.assign(new Error("ff"), { name: "NS_ERROR_DOM_QUOTA_REACHED" }));
    expect(await codeOf(store.save({ scenario: sampleScenario() }))).toBe("quota_exceeded");
  });

  it("reports a storage that throws as storage_unavailable", async () => {
    const storage = createFakeStorage();
    const store = createLocalScenarioStore(storage);
    storage.failNextWrite(new Error("SecurityError"));
    expect(await codeOf(store.save({ scenario: sampleScenario() }))).toBe("storage_unavailable");

    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(await codeOf(store.list())).toBe("storage_unavailable");

    vi.spyOn(storage, "removeItem").mockImplementation(() => {
      throw "blocked";
    });
    vi.mocked(storage.getItem).mockReturnValue(null);
    expect(await codeOf(store.remove("some-id"))).toBe("storage_unavailable");
  });

  it("uses globalThis.localStorage by default and says so when there is none", async () => {
    expect(await codeOf(createLocalScenarioStore().list())).toBe("storage_unavailable");

    const storage = createFakeStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const saved = await createLocalScenarioStore().save({ scenario: sampleScenario() });
      expect(storage.data.has(localEntryKey(saved.id))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(await codeOf(createLocalScenarioStore().list())).toBe("storage_unavailable");
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
      if (original !== undefined) Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  describe("corrupted entries are skipped and reported, never thrown", () => {
    it("skips an entry that is not JSON, has the wrong shape, or holds an invalid scenario", async () => {
      const { store, storage, problems } = setup();
      const good = await store.save({ scenario: sampleScenario() });
      const notJson = await store.save({ scenario: sampleScenario({ title: "Not JSON" }) });
      const wrongShape = await store.save({ scenario: sampleScenario({ title: "Wrong shape" }) });
      const badScenario = await store.save({ scenario: sampleScenario({ title: "Bad" }) });
      const otherId = await store.save({ scenario: sampleScenario({ title: "Other id" }) });
      const missing = await store.save({ scenario: sampleScenario({ title: "Missing" }) });

      storage.data.set(localEntryKey(notJson.id), "{not json");
      storage.data.set(localEntryKey(wrongShape.id), JSON.stringify({ v: 2, id: wrongShape.id }));
      storage.data.set(
        localEntryKey(badScenario.id),
        JSON.stringify({
          v: 1,
          id: badScenario.id,
          updatedAt: "2026-09-01T00:00:00.000Z",
          scenario: { ...sampleScenario(), version: 99 },
        }),
      );
      storage.data.set(
        localEntryKey(otherId.id),
        JSON.stringify({
          v: 1,
          id: "somebody-else",
          updatedAt: "2026-09-01T00:00:00.000Z",
          scenario: sampleScenario(),
        }),
      );
      storage.data.delete(localEntryKey(missing.id));

      expect((await store.list()).map((entry) => entry.id)).toEqual([good.id]);
      expect(await store.get(notJson.id)).toBeNull();
      expect(
        store
          .problems()
          .map((problem) => [problem.id, problem.reason])
          .sort(),
      ).toEqual(
        [
          [notJson.id, "not-json"],
          [wrongShape.id, "wrong-shape"],
          [badScenario.id, "invalid-scenario"],
          [otherId.id, "wrong-shape"],
          [missing.id, "missing"],
        ].sort(),
      );
      expect(problems.length).toBeGreaterThanOrEqual(5);

      // Saving over a damaged entry repairs it and clears its report.
      await store.save({ id: notJson.id, scenario: sampleScenario({ title: "Repaired" }) });
      expect(store.problems().some((problem) => problem.id === notJson.id)).toBe(false);
      expect((await store.get(notJson.id))?.title).toBe("Repaired");
    });

    it("skips an entry that is absurdly large without parsing it", async () => {
      const { store, storage } = setup();
      const saved = await store.save({ scenario: sampleScenario() });
      storage.data.set(localEntryKey(saved.id), `"${"x".repeat(2_000_001)}"`);

      expect(await store.get(saved.id)).toBeNull();
      expect(store.problems()[0]?.message).toContain("too large");
    });

    it("rebuilds a damaged or lost index from the entries", async () => {
      const { store, storage } = setup();
      const a = await store.save({ scenario: sampleScenario({ title: "A" }) });
      const b = await store.save({ scenario: sampleScenario({ title: "B" }) });
      storage.data.set("unrelated", "1");
      storage.data.set("rls-leak-tester:v1:scenario:not a valid id", "{}");

      storage.data.set(LOCAL_INDEX_KEY, JSON.stringify({ v: 1, ids: "nope" }));
      expect((await store.list()).map((entry) => entry.id)).toEqual([b.id, a.id]);
      expect(store.problems().map((problem) => problem.key)).toEqual([LOCAL_INDEX_KEY]);

      storage.data.set(LOCAL_INDEX_KEY, "<html>");
      expect((await store.list()).map((entry) => entry.id)).toEqual([b.id, a.id]);

      storage.data.delete(LOCAL_INDEX_KEY);
      expect((await store.list()).map((entry) => entry.id)).toEqual([b.id, a.id]);

      // The next save writes a good index again.
      const c = await store.save({ scenario: sampleScenario({ title: "C" }) });
      expect(JSON.parse(storage.data.get(LOCAL_INDEX_KEY) ?? "null")).toEqual({
        v: 1,
        ids: [...[a.id, b.id].sort(), c.id],
      });
      expect(store.problems()).toEqual([]);
    });

    it("cannot rebuild the index on a storage that cannot enumerate its keys", async () => {
      const full = createFakeStorage();
      const minimal = {
        getItem: full.getItem.bind(full),
        setItem: full.setItem.bind(full),
        removeItem: full.removeItem.bind(full),
      };
      const store = createLocalScenarioStore(minimal);
      const saved = await store.save({ scenario: sampleScenario() });
      full.data.set(LOCAL_INDEX_KEY, "garbage");

      expect(await store.list()).toEqual([]);
      expect((await store.get(saved.id))?.id).toBe(saved.id);
    });
  });

  it("gives up when no free id can be found", async () => {
    const storage = createFakeStorage();
    const store = createLocalScenarioStore(storage, { fillRandom: (bytes) => bytes.fill(0) });

    const first = await store.save({ scenario: sampleScenario() });
    expect(first.id).toBe("sample-scenario-aaaaaaaaaa");
    expect(await codeOf(store.save({ scenario: sampleScenario() }))).toBe("unavailable");
  });

  it("orders entries saved at the same instant by id", async () => {
    const storage = createFakeStorage();
    const store = createLocalScenarioStore(storage, {
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    await store.save({ id: "b", scenario: sampleScenario() });
    await store.save({ id: "a", scenario: sampleScenario() });

    expect((await store.list()).map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});
