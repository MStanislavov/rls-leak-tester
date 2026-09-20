/**
 * The SERVER half of `/s/[slug]`: the page module itself, with the configuration, Next's cookie
 * jar and `@supabase/ssr` mocked (TEST-001: no test reaches a Supabase project). The fake client
 * applies the visibility rules of the migration, so this shows what a visitor, a signed-in
 * stranger and the owner get: the scenario, or a 404, and metadata that never names a scenario
 * that is not public. The browser half is covered by `e2e/share.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseServerEnv, type EnvRecord } from "@/lib/config/env";
import { resetRedisServices } from "@/lib/redis";

import { ALICE, BOB, createFakeSupabase, sampleScenario } from "../store/fixtures";

const state = vi.hoisted((): { env: Record<string, string | undefined>; client: unknown } => ({
  env: {},
  client: undefined,
}));

vi.mock("@/lib/config/server", () => ({
  getServerConfig: () => parseServerEnv(state.env as EnvRecord),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => state.client }));
// The browser half is a Client Component with `next/dynamic`; the page only passes props to it.
vi.mock("@/app/s/[slug]/shared-scenario-loader", () => ({ SharedScenarioLoader: () => null }));

const SUPABASE_ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-for-tests",
};

const SECRET_TITLE = "Payroll of ACME, confidential";

interface PageElement {
  readonly props: { readonly slug: string; readonly initial: { readonly status: string } };
}

async function openPage(slug: string) {
  // A fresh module per call: `cache()` and the mocks must not carry over between visitors.
  vi.resetModules();
  const page = await import("@/app/s/[slug]/page");
  const props = { params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) };
  return {
    metadata: () => page.generateMetadata(props),
    render: async () => (await page.default(props)) as unknown as PageElement,
  };
}

function configured() {
  state.env = SUPABASE_ENV;
  const supabase = createFakeSupabase();
  state.client = supabase.client;
  const payload = sampleScenario({ title: SECRET_TITLE });
  for (const visibility of ["public", "unlisted", "private"] as const) {
    supabase.seed({
      slug: `alice-${visibility}`,
      owner: ALICE,
      visibility,
      title: SECRET_TITLE,
      payload,
    });
  }
  return supabase;
}

afterEach(() => {
  state.env = {};
  state.client = undefined;
  resetRedisServices();
});

describe("/s/[slug], server half", () => {
  it("without Supabase: a page that says so, generic metadata, nothing looked up", async () => {
    const page = await openPage("alice-public");
    const element = await page.render();
    expect(element.props).toEqual({ slug: "alice-public", initial: { status: "not_configured" } });
    expect(await page.metadata()).toMatchObject({
      title: "Shared scenario",
      robots: { index: false, follow: false },
    });
  });

  it.each(["Not_A_Slug", "ab", "../x", "a--b", "a".repeat(65)])(
    "a malformed slug %j is a 404, configured or not",
    async (slug) => {
      await expect((await openPage(slug)).render()).rejects.toMatchObject({
        digest: expect.stringContaining("404"),
      });
      configured();
      await expect((await openPage(slug)).render()).rejects.toMatchObject({
        digest: expect.stringContaining("404"),
      });
    },
  );

  it("a visitor gets public and unlisted scenarios, and a 404 for a private one", async () => {
    configured();
    for (const slug of ["alice-public", "alice-unlisted"]) {
      const element = await (await openPage(slug)).render();
      expect(element.props.slug).toBe(slug);
      expect(element.props.initial).toMatchObject({
        status: "ok",
        scenario: { slug, ownedByMe: false, scenario: { title: SECRET_TITLE } },
      });
    }
    await expect((await openPage("alice-private")).render()).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    await expect((await openPage("nobody-has-this")).render()).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });

  it("a signed-in stranger gets the same 404 for a private scenario; its owner gets it", async () => {
    const supabase = configured();
    supabase.user = BOB;
    await expect((await openPage("alice-private")).render()).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    supabase.user = ALICE;
    const element = await (await openPage("alice-private")).render();
    expect(element.props.initial).toMatchObject({
      status: "ok",
      scenario: { visibility: "private", ownedByMe: true },
    });
  });

  it("never sends the owner's id to the browser", async () => {
    const supabase = configured();
    // The fixture scenario mentions Alice's id in its own SQL, so the row here belongs to Bob.
    supabase.seed({
      slug: "bob-public",
      owner: BOB,
      visibility: "public",
      payload: sampleScenario(),
    });
    const element = await (await openPage("bob-public")).render();
    expect(JSON.stringify(element.props)).not.toContain(BOB);
    const initial = element.props.initial as { scenario?: Record<string, unknown> };
    expect(Object.keys(initial.scenario ?? {}).sort()).toEqual(
      ["id", "ownedByMe", "scenario", "slug", "title", "updatedAt", "visibility"].sort(),
    );
  });

  it("metadata names a public scenario only", async () => {
    const supabase = configured();
    expect(await (await openPage("alice-public")).metadata()).toMatchObject({
      title: SECRET_TITLE,
      robots: { index: true },
    });
    for (const viewer of [null, BOB, ALICE]) {
      supabase.user = viewer;
      for (const slug of ["alice-unlisted", "alice-private", "nobody-has-this"]) {
        const metadata = await (await openPage(slug)).metadata();
        expect(JSON.stringify(metadata), `${slug} as ${viewer}`).not.toContain("ACME");
        expect(metadata).toMatchObject({ title: "Shared scenario", robots: { index: false } });
      }
    }
  });

  it("an outage is a page with a retry, not a 404 and not a crash", async () => {
    const supabase = configured();
    supabase.failWith = { code: "", message: "fetch failed" };
    const element = await (await openPage("alice-unlisted")).render();
    expect(element.props.initial).toEqual({ status: "unavailable" });
  });
});
