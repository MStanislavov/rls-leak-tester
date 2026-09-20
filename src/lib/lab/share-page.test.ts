import { describe, expect, it, vi } from "vitest";

import { blankScenario } from "@/lib/lab";
import { StoreError, type StoredScenario, type Visibility } from "@/lib/store";

import {
  SHARED_FAILURE_TEXT,
  SHARED_PAGE_TITLE,
  canRetryShared,
  initialSharedView,
  loadSharedInBrowser,
  sharedPageMeta,
  toSharedServerResult,
} from "./share-page";

function stored(visibility: Visibility, title = "Payroll of ACME, confidential"): StoredScenario {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    slug: "payroll-abcdefghijklmnop",
    title,
    visibility,
    updatedAt: "2026-09-20T10:00:00.000Z",
    scenario: { ...blankScenario("payroll-abc"), title },
    ownedByMe: visibility === "private",
  };
}

describe("sharedPageMeta", () => {
  it("uses the title of a public scenario and lets it be indexed", () => {
    expect(
      sharedPageMeta({ status: "ok", scenario: stored("public", "Notes per user") }),
    ).toMatchObject({ title: "Notes per user", index: true });
  });

  it.each(["unlisted", "private"] as const)(
    "never puts the title of a %s scenario into the metadata",
    (visibility) => {
      const meta = sharedPageMeta({ status: "ok", scenario: stored(visibility) });
      expect(JSON.stringify(meta)).not.toContain("ACME");
      expect(meta).toMatchObject({ title: SHARED_PAGE_TITLE, index: false });
    },
  );

  it.each(["not_found", "not_configured", "unavailable", "corrupt"] as const)(
    "answers %s with the same generic, unindexed metadata",
    (status) => {
      expect(sharedPageMeta({ status })).toEqual(
        sharedPageMeta({ status: "ok", scenario: stored("private") }),
      );
    },
  );
});

describe("toSharedServerResult", () => {
  it("is null, a 404, for a miss", () => {
    expect(toSharedServerResult({ status: "not_found" })).toBeNull();
  });

  it("passes the scenario and the other failures on", () => {
    const scenario = stored("unlisted");
    expect(toSharedServerResult({ status: "ok", scenario })).toEqual({ status: "ok", scenario });
    for (const status of ["not_configured", "unavailable", "corrupt"] as const) {
      expect(toSharedServerResult({ status })).toEqual({ status });
    }
  });
});

describe("initialSharedView and canRetryShared", () => {
  it("shows what the server loaded", () => {
    const scenario = stored("public");
    expect(initialSharedView({ status: "ok", scenario })).toEqual({
      phase: "ready",
      stored: scenario,
    });
  });

  it("offers another attempt only after an outage", () => {
    expect(canRetryShared(initialSharedView({ status: "unavailable" }))).toBe(true);
    expect(canRetryShared(initialSharedView({ status: "not_configured" }))).toBe(false);
    expect(canRetryShared(initialSharedView({ status: "corrupt" }))).toBe(false);
    expect(canRetryShared({ phase: "loading" })).toBe(false);
    expect(canRetryShared(initialSharedView({ status: "ok", scenario: stored("public") }))).toBe(
      false,
    );
  });

  it("has a title and a body for every failure", () => {
    for (const text of Object.values(SHARED_FAILURE_TEXT)) {
      expect(text.title).not.toBe("");
      expect(text.body).not.toBe("");
    }
  });
});

describe("loadSharedInBrowser", () => {
  const enabled = async (): Promise<boolean> => true;

  it("does not ask the API on a deployment without sharing", async () => {
    const getBySlug = vi.fn();
    await expect(
      loadSharedInBrowser("some-slug", { sharingEnabled: async () => false, store: { getBySlug } }),
    ).resolves.toEqual({ phase: "failed", reason: "not_configured" });
    expect(getBySlug).not.toHaveBeenCalled();
  });

  it("is ready with the scenario the API answered", async () => {
    const scenario = stored("unlisted");
    const getBySlug = vi.fn(async () => scenario);
    await expect(
      loadSharedInBrowser("payroll-abcdefghijklmnop", {
        sharingEnabled: enabled,
        store: { getBySlug },
      }),
    ).resolves.toEqual({ phase: "ready", stored: scenario });
    expect(getBySlug).toHaveBeenCalledWith("payroll-abcdefghijklmnop");
  });

  it("is not_found for a miss, which is also what a private scenario of somebody else is", async () => {
    await expect(
      loadSharedInBrowser("gone", {
        sharingEnabled: enabled,
        store: { getBySlug: async () => null },
      }),
    ).resolves.toEqual({ phase: "failed", reason: "not_found" });
  });

  it.each([
    ["corrupt", "corrupt"],
    ["not_configured", "not_configured"],
    ["unavailable", "unavailable"],
    ["network", "unavailable"],
    ["rate_limited", "unavailable"],
  ] as const)("maps the store error %s to %s", async (code, reason) => {
    const store = {
      getBySlug: async (): Promise<StoredScenario | null> => {
        throw new StoreError(code, "raw");
      },
    };
    await expect(loadSharedInBrowser("slug", { sharingEnabled: enabled, store })).resolves.toEqual({
      phase: "failed",
      reason,
    });
  });

  it("treats an unknown failure as an outage", async () => {
    const store = {
      getBySlug: async (): Promise<StoredScenario | null> => {
        throw new TypeError("boom");
      },
    };
    await expect(loadSharedInBrowser("slug", { sharingEnabled: enabled, store })).resolves.toEqual({
      phase: "failed",
      reason: "unavailable",
    });
  });
});
