/**
 * The browser half around the stores: the auth client (with a fake Supabase browser client),
 * the chooser between the local and the remote store, and the CSP source helper.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { parsePublicEnv } from "@/lib/config/env";
import { getScenarioStore, type ScenarioStore } from "@/lib/store";
import {
  AuthClientError,
  createAuthClient,
  getAuthClient,
  parseAuthUser,
} from "@/lib/store/auth-client";
import { supabaseConnectSources } from "@/lib/store/connect-src";

import { ALICE } from "./fixtures";

const CONFIGURED = parsePublicEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-for-tests",
});
const UNCONFIGURED = parsePublicEnv({});

type Listener = (event: string, session: { user: unknown } | null) => void;

function fakeBrowserClient(session: { user: unknown } | null = null) {
  const listeners = new Set<Listener>();
  const auth = {
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null as unknown })),
    signOut: vi.fn(async () => ({ error: null as unknown })),
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: vi.fn((listener: Listener) => {
      listeners.add(listener);
      listener("INITIAL_SESSION", session);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    }),
  };
  return {
    auth,
    listeners,
    emit: (next: { user: unknown } | null) => {
      for (const listener of listeners) listener("SIGNED_IN", next);
    },
    client: { auth } as unknown as SupabaseClient,
  };
}

describe("parseAuthUser", () => {
  it("keeps the id and a display name, nothing else", () => {
    expect(
      parseAuthUser({
        id: ALICE,
        email: "alice@example.test",
        user_metadata: { user_name: "alice", name: "Alice A.", avatar_url: "https://x.example/a" },
      }),
    ).toEqual({ id: ALICE, displayName: "alice" });
    expect(parseAuthUser({ id: ALICE, user_metadata: { name: "Alice A." } })).toEqual({
      id: ALICE,
      displayName: "Alice A.",
    });
    expect(parseAuthUser({ id: ALICE })).toEqual({ id: ALICE, displayName: undefined });
  });

  it("is null for anything that is not a user", () => {
    expect(parseAuthUser(undefined)).toBeNull();
    expect(parseAuthUser({ id: "not-a-uuid" })).toBeNull();
    expect(parseAuthUser({ id: ALICE, user_metadata: { user_name: 7 } })).toBeNull();
  });
});

describe("createAuthClient", () => {
  it("is a calm no-op without the Supabase variables and never loads the client", async () => {
    const factory = vi.fn();
    const auth = createAuthClient(UNCONFIGURED, { factory });
    const listener = vi.fn();

    expect(auth.enabled).toBe(false);
    await auth.signInWithGitHub();
    await auth.signOut();
    expect(await auth.getUser()).toBeNull();
    auth.onAuthStateChange(listener)();

    expect(factory).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("starts GitHub sign-in with a callback on this site and a path to come back to", async () => {
    const browser = fakeBrowserClient();
    const factory = vi.fn(async () => browser.client);
    const auth = createAuthClient(CONFIGURED, {
      factory,
      currentOrigin: () => "http://localhost:3000",
    });

    await auth.signInWithGitHub("/s/some-slug");
    await auth.signInWithGitHub("https://evil.example");

    expect(auth.enabled).toBe(true);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      "https://project.supabase.example",
      "anon-key-for-tests",
    );
    expect(browser.auth.signInWithOAuth.mock.calls).toEqual([
      [
        {
          provider: "github",
          options: { redirectTo: "http://localhost:3000/auth/callback?next=%2Fs%2Fsome-slug" },
        },
      ],
      [
        {
          provider: "github",
          options: { redirectTo: "http://localhost:3000/auth/callback?next=%2Flab" },
        },
      ],
    ]);
  });

  it("prefers the configured site URL for the callback", async () => {
    const browser = fakeBrowserClient();
    const auth = createAuthClient(
      parsePublicEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-for-tests",
        NEXT_PUBLIC_SITE_URL: "https://rls.example/",
      }),
      { factory: async () => browser.client },
    );

    await auth.signInWithGitHub();

    expect(browser.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: { redirectTo: "https://rls.example/auth/callback?next=%2Flab" },
    });
  });

  it("reports a sign-in or sign-out that did not work, without the provider's text", async () => {
    const browser = fakeBrowserClient();
    const auth = createAuthClient(CONFIGURED, {
      factory: async () => browser.client,
      currentOrigin: () => "http://localhost:3000",
    });

    browser.auth.signInWithOAuth.mockResolvedValueOnce({ data: {}, error: { message: "secret" } });
    await expect(auth.signInWithGitHub()).rejects.toBeInstanceOf(AuthClientError);
    browser.auth.signOut.mockResolvedValueOnce({ error: { message: "secret" } });
    await expect(auth.signOut()).rejects.toThrow("Sign-out did not complete.");

    await auth.signOut();
    expect(browser.auth.signOut).toHaveBeenLastCalledWith({ scope: "local" });
  });

  it("reads the user of the session and follows changes until unsubscribed", async () => {
    const browser = fakeBrowserClient({
      user: { id: ALICE, user_metadata: { user_name: "alice" } },
    });
    const auth = createAuthClient(CONFIGURED, { factory: async () => browser.client });
    const seen: Array<string | null> = [];

    expect(await auth.getUser()).toEqual({ id: ALICE, displayName: "alice" });
    const unsubscribe = auth.onAuthStateChange((user) => seen.push(user?.id ?? null));
    await vi.waitFor(() => expect(seen).toEqual([ALICE]));

    browser.emit(null);
    unsubscribe();
    browser.emit({ user: { id: ALICE } });

    expect(seen).toEqual([ALICE, null]);
    expect(browser.listeners.size).toBe(0);
  });

  it("does not subscribe when the listener left before the client had loaded", async () => {
    const browser = fakeBrowserClient();
    let resolve: (client: SupabaseClient) => void = () => undefined;
    const auth = createAuthClient(CONFIGURED, {
      factory: () => new Promise<SupabaseClient>((done) => (resolve = done)),
    });
    const listener = vi.fn();

    auth.onAuthStateChange(listener)();
    resolve(browser.client);
    await Promise.resolve();

    expect(browser.auth.onAuthStateChange).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("tells the listener nobody is signed in when the client cannot load, and retries later", async () => {
    const browser = fakeBrowserClient();
    const factory = vi
      .fn<() => Promise<SupabaseClient>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValue(browser.client);
    const auth = createAuthClient(CONFIGURED, { factory });
    const listener = vi.fn();

    auth.onAuthStateChange(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(null));

    expect(await auth.getUser()).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("getAuthClient builds one client from the public configuration", () => {
    expect(getAuthClient()).toBe(getAuthClient());
    expect(getAuthClient().enabled).toBe(false);
  });
});

describe("getScenarioStore", () => {
  const local = { kind: "local" } as ScenarioStore;
  const remote = { kind: "supabase" } as ScenarioStore;
  const pick = (supabaseEnabled: boolean, getUser: () => Promise<{ id: string } | null>) =>
    getScenarioStore({
      config: { supabaseEnabled },
      auth: { getUser: async () => (await getUser()) as never },
      local: () => local,
      remote: () => remote,
    });

  it("is the remote store only when Supabase is configured AND somebody is signed in", async () => {
    const signedIn = vi.fn(async () => ({ id: ALICE }));

    expect(await pick(true, signedIn)).toBe(remote);
    expect(await pick(true, async () => null)).toBe(local);
    expect(await pick(false, signedIn)).toBe(local);
    // Without Supabase the session is not even looked at.
    expect(signedIn).toHaveBeenCalledOnce();
  });

  it("falls back to the local store when the session cannot be read", async () => {
    expect(await pick(true, () => Promise.reject(new Error("chunk failed")))).toBe(local);
  });

  it("defaults to the local store with zero configuration", async () => {
    expect((await getScenarioStore()).kind).toBe("local");
  });
});

describe("supabaseConnectSources", () => {
  it("adds the https origin of the project, and nothing otherwise", () => {
    expect(supabaseConnectSources(undefined)).toEqual([]);
    expect(supabaseConnectSources("https://project.supabase.example/rest/v1")).toEqual([
      "https://project.supabase.example",
    ]);
    expect(supabaseConnectSources("http://127.0.0.1:54321")).toEqual([]);
    expect(supabaseConnectSources("not a url")).toEqual([]);
  });

  it("produces a source the document CSP accepts", async () => {
    const { buildDocumentCsp, generateNonce } = await import("@/lib/security/csp");

    const policy = buildDocumentCsp({
      nonce: generateNonce(),
      isDev: false,
      connectSrc: supabaseConnectSources("https://project.supabase.example"),
    });

    expect(policy).toContain("connect-src 'self' https://project.supabase.example");
  });
});
