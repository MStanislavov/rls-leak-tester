/**
 * The only file of the store that knows Next.js: it builds the per-request Supabase client from
 * the request's cookies (`@supabase/ssr`, `getAll` / `setAll`) and hands the framework-free
 * handlers their dependencies. A route that imports this module declares
 * `export const runtime = "nodejs"` (REDIS-002).
 *
 * A NEW client per request, never shared: it carries one visitor's session. There is no
 * service-role client; every query runs under the visitor's own JWT.
 */
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import type { PublicConfig } from "@/lib/config/env";
import { getServerConfig } from "@/lib/config/server";
import { getRedisServices } from "@/lib/redis";

import { isStoreError, type StoredScenario } from "../types";
import type { AuthRouteDeps } from "./auth";
import type { ParamResult, ScenarioApiDeps } from "./handlers";
import { createSupabaseScenarioRepository } from "./repository";
import { getBySlug } from "./service";
import { resolveUserId } from "./session";

/** `undefined` when Supabase is not configured: the caller answers with its notice. */
export async function createRequestSupabaseClient(
  config: PublicConfig,
): Promise<SupabaseClient | undefined> {
  if (config.supabaseUrl === undefined || config.supabaseAnonKey === undefined) return undefined;
  const jar = await cookies();
  return createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
    cookies: {
      getAll: () => jar.getAll().map(({ name, value }) => ({ name, value })),
      // The cache headers the library passes as a second argument are not needed: every answer
      // of these routes already carries `Cache-Control: no-store`.
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) jar.set(name, value, options);
        } catch {
          // A Server Component cannot set cookies. The browser client refreshes the token too.
        }
      },
    },
  });
}

export async function getScenarioApiDeps(): Promise<ScenarioApiDeps> {
  const config = getServerConfig();
  const services = getRedisServices(config);
  return {
    supabase: await createRequestSupabaseClient(config.public),
    keys: services.keys,
    limiter: services.rateLimiter,
    cache: services.cache,
  };
}

export async function getAuthRouteDeps(): Promise<AuthRouteDeps> {
  const config = getServerConfig();
  return {
    supabase: await createRequestSupabaseClient(config.public),
    siteUrl: config.public.siteUrl,
  };
}

/**
 * The signed-in user of the current request, verified by Supabase Auth, for the per-user rate
 * limit of `/api/explain` (`ExplainDeps.resolveUserId`). Never throws: without Supabase, without
 * a session or during an outage the caller is anonymous and the per-IP limit still applies.
 */
export async function resolveRequestUserId(): Promise<string | undefined> {
  try {
    const client = await createRequestSupabaseClient(getServerConfig().public);
    return client === undefined ? undefined : await resolveUserId(client);
  } catch {
    return undefined;
  }
}

export type SharedScenarioResult =
  | { readonly status: "ok"; readonly scenario: StoredScenario }
  | { readonly status: "not_found" | "not_configured" | "unavailable" | "corrupt" };

/**
 * A shared scenario for a Server Component (`/s/[slug]`, its metadata): the same read-through
 * path as `GET /api/scenarios/by-slug/[slug]`, without an HTTP hop. Pass the result of
 * `parseScenarioSlugParams(await params)`. Never throws for a known failure.
 */
export async function loadSharedScenario(slug: ParamResult): Promise<SharedScenarioResult> {
  if (!slug.ok) return { status: "not_found" };
  const config = getServerConfig();
  const client = await createRequestSupabaseClient(config.public);
  if (client === undefined) return { status: "not_configured" };
  const services = getRedisServices(config);
  try {
    const scenario = await getBySlug(
      {
        repository: createSupabaseScenarioRepository(client),
        cache: services.cache,
        keys: services.keys,
      },
      slug.value,
      await resolveUserId(client),
    );
    return scenario === undefined ? { status: "not_found" } : { status: "ok", scenario };
  } catch (error) {
    if (isStoreError(error) && error.code === "corrupt") return { status: "corrupt" };
    if (isStoreError(error)) return { status: "unavailable" };
    throw error;
  }
}
