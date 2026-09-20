/**
 * GitHub sign-in through Supabase Auth, browser half. The Supabase browser client exists only
 * when both public variables are set, and its code is loaded on first use (`import()`), so a
 * deployment without Supabase, and every page that never signs in, ships none of it.
 *
 * What this module tells the UI ("somebody is signed in") comes from the session in the
 * browser and decides what is SHOWN, nothing more. What a user may DO is decided on the server,
 * which verifies the session with `auth.getUser()`, and by row level security behind it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { PublicConfig } from "@/lib/config/env";
import { getPublicConfig } from "@/lib/config/public";

const AUTH_CALLBACK_PATH = "/auth/callback";
const DEFAULT_NEXT_PATH = "/lab";

export interface AuthUser {
  id: string;
  /** The GitHub login or name, when the provider sent one. Render it as text only. */
  displayName: string | undefined;
}

export interface AuthClient {
  /** False without the Supabase variables: every method is then a no-op. */
  readonly enabled: boolean;
  /** Leaves the page for GitHub. Comes back to `nextPath` (a path on this site) signed in. */
  signInWithGitHub(nextPath?: string): Promise<void>;
  signOut(): Promise<void>;
  /** The user of the session in this browser, without a network call. */
  getUser(): Promise<AuthUser | null>;
  /** Calls back now-ish with the current user and on every change. Returns the unsubscribe. */
  onAuthStateChange(listener: (user: AuthUser | null) => void): () => void;
}

const sessionUserSchema = z.object({
  id: z.uuid(),
  user_metadata: z
    .object({
      user_name: z.string().max(100).optional(),
      name: z.string().max(200).optional(),
    })
    .optional(),
});

/** Pure: the user object of a Supabase session, reduced to what the UI may show. */
export function parseAuthUser(value: unknown): AuthUser | null {
  const parsed = sessionUserSchema.safeParse(value);
  if (!parsed.success) return null;
  const meta = parsed.data.user_metadata;
  return { id: parsed.data.id, displayName: meta?.user_name ?? meta?.name };
}

export class AuthClientError extends Error {
  override readonly name = "AuthClientError";
}

export type BrowserClientFactory = (url: string, anonKey: string) => Promise<SupabaseClient>;

const loadBrowserClient: BrowserClientFactory = async (url, anonKey) => {
  const { createBrowserClient } = await import("@supabase/ssr");
  return createBrowserClient(url, anonKey);
};

const DISABLED: AuthClient = {
  enabled: false,
  signInWithGitHub: async () => undefined,
  signOut: async () => undefined,
  getUser: async () => null,
  onAuthStateChange: () => () => undefined,
};

export interface AuthClientOptions {
  factory?: BrowserClientFactory | undefined;
  /** The origin the callback URL is built on when `NEXT_PUBLIC_SITE_URL` is unset. */
  currentOrigin?: (() => string) | undefined;
}

export function createAuthClient(
  config: PublicConfig,
  options: AuthClientOptions = {},
): AuthClient {
  const { supabaseUrl, supabaseAnonKey } = config;
  if (supabaseUrl === undefined || supabaseAnonKey === undefined) return DISABLED;

  const factory = options.factory ?? loadBrowserClient;
  const currentOrigin = options.currentOrigin ?? (() => globalThis.location.origin);
  let client: Promise<SupabaseClient> | undefined;
  const getClient = (): Promise<SupabaseClient> => {
    client ??= factory(supabaseUrl, supabaseAnonKey).catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return client;
  };

  return {
    enabled: true,

    signInWithGitHub: async (nextPath = DEFAULT_NEXT_PATH) => {
      const redirectTo = new URL(AUTH_CALLBACK_PATH, config.siteUrl ?? currentOrigin());
      // The server validates `next` again; a path keeps the round trip on this site.
      redirectTo.searchParams.set("next", nextPath.startsWith("/") ? nextPath : DEFAULT_NEXT_PATH);
      const { error } = await (
        await getClient()
      ).auth.signInWithOAuth({ provider: "github", options: { redirectTo: redirectTo.href } });
      if (error !== null) throw new AuthClientError("Sign-in with GitHub could not be started.");
    },

    signOut: async () => {
      const { error } = await (await getClient()).auth.signOut({ scope: "local" });
      if (error !== null) throw new AuthClientError("Sign-out did not complete.");
    },

    getUser: async () => {
      const { data } = await (await getClient()).auth.getSession();
      return parseAuthUser(data.session?.user);
    },

    onAuthStateChange: (listener) => {
      let active = true;
      let unsubscribe: (() => void) | undefined;
      void getClient()
        .then((supabase) => {
          if (!active) return;
          const { data } = supabase.auth.onAuthStateChange((_event, session) => {
            if (active) listener(parseAuthUser(session?.user));
          });
          unsubscribe = () => data.subscription.unsubscribe();
        })
        .catch(() => {
          if (active) listener(null);
        });
      return () => {
        active = false;
        unsubscribe?.();
      };
    },
  };
}

let shared: AuthClient | undefined;

/** The auth client of this page, built from the public configuration on first use. */
export function getAuthClient(): AuthClient {
  shared ??= createAuthClient(getPublicConfig());
  return shared;
}
