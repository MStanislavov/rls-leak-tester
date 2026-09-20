/**
 * The HTTP layer of `/api/scenarios`, framework free: a `Request` and explicit dependencies in,
 * a `Response` out, so the routes stay thin (ARCH-003) and everything is testable with a mocked
 * Supabase client (TEST-001).
 *
 * Order of a write: configured (503) -> not cross-site (403) -> limit per IP (429) -> session
 * verified with `auth.getUser()` (401) -> limit per user (429) -> body (400, 413) -> database,
 * where row level security decides once more. Nothing of an untrusted body is read before the
 * caller is known and within budget. Reads are not rate limited; listing needs a session.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  checkRateLimits,
  isRedisUnavailable,
  rateLimitHeaders,
  rateLimitRule,
  type Cache,
  type KeyBuilder,
  type RateLimitResult,
  type RateLimiter,
} from "@/lib/redis";
import type { FillRandom } from "@/lib/scenario";
import { clientAddress } from "@/lib/security/client-address";

import { StoreError } from "../types";
import { remoteIdSchema, slugSchema } from "../wire";
import { parseCreateScenarioBody, parseUpdateScenarioBody, readJsonBody } from "./body";
import {
  emptyResponse,
  isCrossSiteRequest,
  jsonResponse,
  notConfiguredError,
  storeErrorResponse,
} from "./http";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "./policy";
import { createSupabaseScenarioRepository } from "./repository";
import { create, getById, getBySlug, listMine, remove, update } from "./service";
import type { ScenarioServiceDeps } from "./service";
import { requireUserId, resolveUserId } from "./session";

export type ScenarioAction = "list" | "create" | "get" | "get-by-slug" | "update" | "delete";

/** One line per request. There is no field that could hold a scenario, SQL or an address. */
export interface ScenarioLogEvent {
  readonly event: "scenarios";
  readonly action: ScenarioAction;
  readonly status: number;
  readonly durationMs: number;
  readonly code?: string;
}

export interface ScenarioApiDeps {
  /** The request's Supabase client, or `undefined` when Supabase is not configured. */
  readonly supabase: SupabaseClient | undefined;
  readonly keys: KeyBuilder;
  readonly limiter: RateLimiter;
  readonly cache: Cache;
  readonly fillRandom?: FillRandom | undefined;
  readonly logger?: ((event: ScenarioLogEvent) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

/** A route parameter after validation. A malformed one can name no row: it is a 404. */
export type ParamResult = { readonly ok: true; readonly value: string } | { readonly ok: false };

function parseParam(params: unknown, name: "id" | "slug"): ParamResult {
  if (typeof params !== "object" || params === null) return { ok: false };
  const raw: unknown = (params as Record<string, unknown>)[name];
  const parsed = (name === "id" ? remoteIdSchema : slugSchema).safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** `params` of `/api/scenarios/[id]`. */
export function parseScenarioIdParams(params: unknown): ParamResult {
  return parseParam(params, "id");
}

/** `params` of `/api/scenarios/by-slug/[slug]`. */
export function parseScenarioSlugParams(params: unknown): ParamResult {
  return parseParam(params, "slug");
}

const notFound = (): StoreError => new StoreError("not_found", "There is no such scenario.");

const defaultLogger = (event: ScenarioLogEvent): void => {
  console.info(JSON.stringify(event));
};

interface Context {
  readonly client: SupabaseClient;
  readonly service: ScenarioServiceDeps;
}

type Work = (context: Context, headers: Record<string, string>) => Promise<Response>;

/** Runs `work`, turns every known failure into its JSON answer and writes the log line. */
async function respond(
  action: ScenarioAction,
  deps: ScenarioApiDeps,
  work: Work,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const headers: Record<string, string> = {};
  let code: string | undefined;
  let response: Response;
  try {
    if (deps.supabase === undefined) throw notConfiguredError();
    const service: ScenarioServiceDeps = {
      repository: createSupabaseScenarioRepository(deps.supabase),
      cache: deps.cache,
      keys: deps.keys,
      fillRandom: deps.fillRandom,
    };
    response = await work({ client: deps.supabase, service }, headers);
  } catch (error) {
    const known = isRedisUnavailable(error)
      ? new StoreError("unavailable", "The service is busy. Try again shortly.", {
          retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
        })
      : error;
    if (!(known instanceof StoreError)) throw error;
    code = known.code;
    response = storeErrorResponse(known, headers);
  }
  (deps.logger ?? defaultLogger)({
    event: "scenarios",
    action,
    status: response.status,
    durationMs: now() - startedAt,
    ...(code === undefined ? {} : { code }),
  });
  return response;
}

function refuseWhenLimited(result: RateLimitResult, headers: Record<string, string>): void {
  Object.assign(headers, rateLimitHeaders(result));
  if (result.allowed) return;
  throw new StoreError("rate_limited", "Too many changes. Wait a moment and try again.", {
    retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
  });
}

/** The verified user of a write that is allowed to go on. Fills the rate limit headers. */
async function authoriseWrite(
  request: Request,
  deps: ScenarioApiDeps,
  context: Context,
  headers: Record<string, string>,
): Promise<string> {
  if (isCrossSiteRequest(request.headers)) {
    throw new StoreError("forbidden", "Requests from another site are refused.");
  }
  const scope = "scenario-writes";
  const byIp = await checkRateLimits(deps.limiter, deps.keys, scope, {
    ip: clientAddress(request.headers),
  });
  refuseWhenLimited(byIp, headers);

  const userId = await requireUserId(context.client);
  const byUser = await deps.limiter.check(
    deps.keys.rateLimit(scope, "user", userId),
    rateLimitRule(scope, "user"),
  );
  refuseWhenLimited(byUser.allowed && byIp.remaining < byUser.remaining ? byIp : byUser, headers);
  return userId;
}

/** `GET /api/scenarios`: the caller's own scenarios, newest first. */
export function handleListScenarios(_request: Request, deps: ScenarioApiDeps): Promise<Response> {
  return respond("list", deps, async ({ client, service }) => {
    const userId = await requireUserId(client);
    return jsonResponse({ scenarios: await listMine(service, userId) }, 200);
  });
}

/** `POST /api/scenarios`: the slug is generated here, never taken from the caller. */
export function handleCreateScenario(request: Request, deps: ScenarioApiDeps): Promise<Response> {
  return respond("create", deps, async (context, headers) => {
    const userId = await authoriseWrite(request, deps, context, headers);
    const input = parseCreateScenarioBody(await readJsonBody(request));
    const scenario = await create(context.service, userId, input);
    return jsonResponse({ scenario }, 201, {
      ...headers,
      Location: `/api/scenarios/${scenario.id}`,
    });
  });
}

/** `GET /api/scenarios/[id]`: the caller's own scenario or a public one. */
export function handleGetScenario(
  _request: Request,
  id: ParamResult,
  deps: ScenarioApiDeps,
): Promise<Response> {
  return respond("get", deps, async ({ client, service }) => {
    if (!id.ok) throw notFound();
    const scenario = await getById(service, id.value, await resolveUserId(client));
    if (scenario === undefined) throw notFound();
    return jsonResponse({ scenario }, 200);
  });
}

/** `GET /api/scenarios/by-slug/[slug]`: public, unlisted, or the caller's own. No session needed. */
export function handleGetScenarioBySlug(
  _request: Request,
  slug: ParamResult,
  deps: ScenarioApiDeps,
): Promise<Response> {
  return respond("get-by-slug", deps, async ({ client, service }) => {
    if (!slug.ok) throw notFound();
    const scenario = await getBySlug(service, slug.value, await resolveUserId(client));
    if (scenario === undefined) throw notFound();
    return jsonResponse({ scenario }, 200);
  });
}

/** `PATCH /api/scenarios/[id]`: owner only. */
export function handleUpdateScenario(
  request: Request,
  id: ParamResult,
  deps: ScenarioApiDeps,
): Promise<Response> {
  return respond("update", deps, async (context, headers) => {
    const userId = await authoriseWrite(request, deps, context, headers);
    if (!id.ok) throw notFound();
    const input = parseUpdateScenarioBody(await readJsonBody(request));
    const scenario = await update(context.service, userId, id.value, input);
    return jsonResponse({ scenario }, 200, headers);
  });
}

/** `DELETE /api/scenarios/[id]`: owner only. */
export function handleDeleteScenario(
  request: Request,
  id: ParamResult,
  deps: ScenarioApiDeps,
): Promise<Response> {
  return respond("delete", deps, async (context, headers) => {
    const userId = await authoriseWrite(request, deps, context, headers);
    if (!id.ok) throw notFound();
    await remove(context.service, userId, id.value);
    return emptyResponse(204, headers);
  });
}
