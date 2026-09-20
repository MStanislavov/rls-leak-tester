import { describe, expect, it, vi } from "vitest";

import { blankScenario } from "@/lib/lab";
import type { Scenario } from "@/lib/scenario";
import {
  StoreError,
  type SaveScenarioInput,
  type StoredScenario,
  type StoredScenarioSummary,
} from "@/lib/store";

import {
  HEALTH_PATH,
  SHARE_DISABLED_EXPLANATION,
  changeVisibility,
  fetchSharingEnabled,
  forkToLab,
  loadShareSession,
  parseSharingEnabled,
  shareErrorMessage,
  sharedPath,
  sharedUrl,
  signInReturnPath,
  withSharedSummary,
} from "./share";

const REMOTE_ID = "00000000-0000-4000-8000-0000000000aa";

function scenario(title = "Notes per user"): Scenario {
  return { ...blankScenario("notes-per-user-abc"), title };
}

function stored(overrides: Partial<StoredScenario> = {}): StoredScenario {
  return {
    id: REMOTE_ID,
    slug: "notes-per-user-abcdefghijklmnop",
    title: "Notes per user",
    visibility: "unlisted",
    updatedAt: "2026-09-20T10:00:00.000Z",
    scenario: scenario(),
    ownedByMe: true,
    ...overrides,
  };
}

function summary(id: string, title: string): StoredScenarioSummary {
  return {
    id,
    slug: `${title}-slug`,
    title,
    visibility: "private",
    updatedAt: "2026-09-20T10:00:00.000Z",
  };
}

/** A store that keeps what was saved and answers with a local-looking entry. */
function recordingStore() {
  const saved: SaveScenarioInput[] = [];
  return {
    saved,
    save: async (input: SaveScenarioInput): Promise<StoredScenario> => {
      saved.push(input);
      return stored({ id: input.scenario.id, slug: input.scenario.id, scenario: input.scenario });
    },
  };
}

const zeros = (bytes: Uint8Array): Uint8Array => bytes.fill(0);

describe("parseSharingEnabled", () => {
  it("reads the supabase flag of a health report", () => {
    const report = {
      status: "ok",
      buildId: "x",
      features: { explain: false, redis: false, supabase: true },
    };
    expect(parseSharingEnabled(report)).toBe(true);
    expect(parseSharingEnabled({ features: { supabase: false } })).toBe(false);
  });

  it.each([null, "ok", {}, { features: {} }, { features: { supabase: "yes" } }])(
    "is null for %j",
    (body) => {
      expect(parseSharingEnabled(body)).toBeNull();
    },
  );
});

describe("fetchSharingEnabled", () => {
  it("asks /api/health without a cache and believes a true flag", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ features: { supabase: true } }));
    await expect(fetchSharingEnabled(fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      HEALTH_PATH,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("is false for an error status, a body that is no report, broken JSON and a network failure", async () => {
    await expect(
      fetchSharingEnabled(async () =>
        Response.json({ features: { supabase: true } }, { status: 500 }),
      ),
    ).resolves.toBe(false);
    await expect(fetchSharingEnabled(async () => Response.json({ ok: true }))).resolves.toBe(false);
    await expect(fetchSharingEnabled(async () => new Response("<html>"))).resolves.toBe(false);
    await expect(
      fetchSharingEnabled(async () => {
        throw new TypeError("offline");
      }),
    ).resolves.toBe(false);
  });
});

describe("links", () => {
  it("builds the path and the absolute link of a slug", () => {
    expect(sharedPath("notes-abc")).toBe("/s/notes-abc");
    expect(sharedUrl("https://rls.example", "notes-abc")).toBe("https://rls.example/s/notes-abc");
    expect(sharedUrl("http://localhost:3000/lab?x=1", "notes-abc")).toBe(
      "http://localhost:3000/s/notes-abc",
    );
  });

  it("never lets a slug leave the /s/ segment", () => {
    expect(sharedPath("../api/health")).toBe("/s/..%2Fapi%2Fhealth");
  });
});

describe("shareErrorMessage", () => {
  it("has a sentence for every code the API can answer with", () => {
    const codes = [
      "unauthenticated",
      "forbidden",
      "not_found",
      "rate_limited",
      "too_large",
      "invalid",
      "network",
      "unavailable",
      "invalid_response",
      "corrupt",
    ] as const;
    for (const code of codes) {
      const message = shareErrorMessage(new StoreError(code, "raw server text"));
      expect(message, code).not.toBe("");
      expect(message, code).not.toContain("raw server text");
    }
  });

  it("names the wait of a rate limit and the first issue of a refusal", () => {
    expect(
      shareErrorMessage(new StoreError("rate_limited", "slow down", { retryAfterSeconds: 42 })),
    ).toContain("42 s");
    expect(
      shareErrorMessage(
        new StoreError("invalid", "no", {
          issues: [{ path: "scenario.title", message: "is empty" }],
        }),
      ),
    ).toContain("scenario.title is empty");
  });

  it("explains a deployment without Supabase with the standard notice", () => {
    expect(shareErrorMessage(new StoreError("not_configured", "x"))).toBe(
      SHARE_DISABLED_EXPLANATION,
    );
  });

  it("keeps the local store's own message and hides anything that is not a StoreError", () => {
    expect(
      shareErrorMessage(new StoreError("quota_exceeded", "The browser storage is full.")),
    ).toBe("The browser storage is full.");
    expect(shareErrorMessage(new Error("stack trace"))).not.toContain("stack trace");
  });
});

describe("loadShareSession", () => {
  const mine = [summary(REMOTE_ID, "one")];

  it("does not ask the API when the browser session knows nobody", async () => {
    const list = vi.fn(async () => mine);
    const session = await loadShareSession({
      auth: { enabled: true, getUser: async () => null },
      store: { list },
    });
    expect(session).toEqual({ status: "signed-out" });
    expect(list).not.toHaveBeenCalled();
  });

  it("lists the caller's scenarios when somebody is signed in", async () => {
    const session = await loadShareSession({
      auth: { enabled: true, getUser: async () => ({ id: "u" }) },
      store: { list: async () => mine },
    });
    expect(session).toEqual({ status: "signed-in", mine });
  });

  it("lets the server decide when the auth client is off or cannot read the session", async () => {
    const off = { enabled: false, getUser: async () => null };
    await expect(
      loadShareSession({ auth: off, store: { list: async () => mine } }),
    ).resolves.toEqual({ status: "signed-in", mine });
    const broken = {
      enabled: true,
      getUser: async () => {
        throw new Error("no storage");
      },
    };
    await expect(
      loadShareSession({ auth: broken, store: { list: async () => mine } }),
    ).resolves.toEqual({ status: "signed-in", mine });
  });

  it("is signed out on 401 and an error with a readable message otherwise", async () => {
    const off = { enabled: false, getUser: async () => null };
    const failing = (code: "unauthenticated" | "unavailable") => ({
      list: async (): Promise<StoredScenarioSummary[]> => {
        throw new StoreError(code, "raw");
      },
    });
    await expect(
      loadShareSession({ auth: off, store: failing("unauthenticated") }),
    ).resolves.toEqual({ status: "signed-out" });
    await expect(loadShareSession({ auth: off, store: failing("unavailable") })).resolves.toEqual({
      status: "error",
      message: shareErrorMessage(new StoreError("unavailable", "raw")),
    });
  });
});

describe("changeVisibility", () => {
  it("writes the stored scenario back with the new visibility", async () => {
    const current = stored();
    const save = vi.fn(async (input: SaveScenarioInput) =>
      stored({ visibility: input.visibility ?? "private" }),
    );
    const result = await changeVisibility({ get: async () => current, save }, REMOTE_ID, "public");
    expect(save).toHaveBeenCalledWith({
      id: REMOTE_ID,
      scenario: current.scenario,
      visibility: "public",
    });
    expect(result.visibility).toBe("public");
  });

  it("is not_found when the entry is gone, without writing", async () => {
    const save = vi.fn();
    await expect(
      changeVisibility({ get: async () => null, save }, REMOTE_ID, "public"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("withSharedSummary", () => {
  it("replaces an entry in place and keeps only the summary fields", () => {
    const next = withSharedSummary(
      [summary("a", "one"), summary(REMOTE_ID, "two")],
      stored({ title: "renamed", visibility: "public" }),
    );
    expect(next.map((entry) => entry.title)).toEqual(["one", "renamed"]);
    expect(next[1]).toEqual({
      id: REMOTE_ID,
      slug: stored().slug,
      title: "renamed",
      visibility: "public",
      updatedAt: stored().updatedAt,
    });
  });

  it("puts a new entry first", () => {
    expect(withSharedSummary([summary("a", "one")], stored()).map((entry) => entry.id)).toEqual([
      REMOTE_ID,
      "a",
    ]);
  });
});

describe("forkToLab", () => {
  it("saves a copy under a new id, without an id for the store, and answers with its lab address", async () => {
    const store = recordingStore();
    const original = scenario();
    const path = await forkToLab(store, original, zeros);
    expect(store.saved).toHaveLength(1);
    const input = store.saved[0];
    expect(input?.id).toBeUndefined();
    expect(input?.scenario.id).not.toBe(original.id);
    expect(input?.scenario).toEqual({ ...original, id: input?.scenario.id });
    expect(path).toBe(`/lab?saved=${input?.scenario.id}`);
  });

  it("passes a full store on to the caller", async () => {
    const full = {
      save: async (): Promise<StoredScenario> => {
        throw new StoreError("quota_exceeded", "full");
      },
    };
    await expect(forkToLab(full, scenario())).rejects.toMatchObject({ code: "quota_exceeded" });
  });
});

describe("signInReturnPath", () => {
  it("reopens an unchanged template or saved entry by its own address", async () => {
    const store = recordingStore();
    await expect(
      signInReturnPath(store, {
        origin: { kind: "template", templateId: "notes", variant: "fixed" },
        dirty: false,
        scenario: scenario(),
      }),
    ).resolves.toBe("/lab?template=notes&variant=fixed");
    await expect(
      signInReturnPath(store, {
        origin: { kind: "saved", storeId: "mine-abc" },
        dirty: false,
        scenario: scenario(),
      }),
    ).resolves.toBe("/lab?saved=mine-abc");
    expect(store.saved).toEqual([]);
  });

  it("keeps edited or imported work as a copy in the local store", async () => {
    const store = recordingStore();
    const edited = await signInReturnPath(
      store,
      { origin: { kind: "saved", storeId: "mine-abc" }, dirty: true, scenario: scenario() },
      zeros,
    );
    const imported = await signInReturnPath(
      store,
      { origin: { kind: "imported" }, dirty: false, scenario: scenario() },
      zeros,
    );
    expect(store.saved).toHaveLength(2);
    expect(edited).toBe(`/lab?saved=${store.saved[0]?.scenario.id}`);
    expect(imported).toBe(`/lab?saved=${store.saved[1]?.scenario.id}`);
  });

  it("falls back to the plain lab when the work is invalid or cannot be written", async () => {
    const store = recordingStore();
    await expect(
      signInReturnPath(store, { origin: { kind: "blank" }, dirty: true, scenario: null }),
    ).resolves.toBe("/lab");
    const full = {
      save: async (): Promise<StoredScenario> => {
        throw new StoreError("quota_exceeded", "full");
      },
    };
    await expect(
      signInReturnPath(full, { origin: { kind: "blank" }, dirty: true, scenario: scenario() }),
    ).resolves.toBe("/lab");
  });
});
