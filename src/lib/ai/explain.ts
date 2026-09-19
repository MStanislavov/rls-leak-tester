/**
 * The logic of `POST /api/explain` (brief 3.7, 4.5, 4.6), framework-free and with every
 * dependency injected, so the route stays thin (ARCH-003) and the tests need no network.
 *
 * Order: feature enabled? -> bounded, validated body -> rate limit -> cache -> single-flight lock
 * -> streamed structured output -> validate and cache. The server never executes anything the
 * request contains (SEC-004); it forwards validated text to the model as data.
 *
 * Failure policy: an unmetered model endpoint is a cost risk, so any `RedisUnavailableError`
 * before the model is called answers `503` (fail closed). A cache write that fails after the
 * answer was streamed is logged and nothing else: the caller already has the answer.
 *
 * Wire shape: a successful answer is always `text/plain` holding the JSON text of one
 * `Explanation`, streamed from the model or sent at once from the cache. The client reads both
 * with the same code (`client.ts`). Every other answer is an `ExplainErrorBody` as JSON.
 *
 * Logs carry hashes, sizes and outcomes. Never SQL, claims, keys, addresses or provider errors:
 * a provider error object can hold the whole request body.
 */
import { createHash } from "node:crypto";
import { Output, streamText, type LanguageModel } from "ai";
import type { ServerConfig } from "@/lib/config/server";
import {
  EXPLANATION_CACHE_TTL_SECONDS,
  SINGLE_FLIGHT_LOCK_TTL_MS,
  checkRateLimits,
  RATE_LIMITS,
  isRedisUnavailable,
  waitForValue,
  type Cache,
  type Clock,
  type KeyBuilder,
  type Lock,
  type LockLease,
  type RateLimiter,
  type WaitOptions,
} from "@/lib/redis";
import { stableStringify } from "@/lib/scenario";
import { z } from "zod";
import { readExplainRequest } from "./body";
import { MAX_OUTPUT_TOKENS, modelProviderOptions, resolveModelId } from "./model";
import { EXPLAIN_SYSTEM_PROMPT, PROMPT_VERSION, buildExplainPrompt } from "./prompt";
import { explainRateLimitHeaders } from "./rate-limit-headers";
import {
  explanationModelSchema,
  explanationSchema,
  utf8ByteLength,
  type ExplainErrorBody,
  type ExplainErrorCode,
  type ExplainRequest,
} from "./schema";

export type ExplainConfig = Pick<
  ServerConfig,
  "isProduction" | "anthropicModel" | "redisUrl" | "features"
>;

export type ExplainOutcome =
  | "not_configured"
  | "invalid_request"
  | "rate_limited"
  | "redis_unavailable"
  | "cache_hit"
  | "peer_hit"
  | "streamed"
  | "streamed_invalid"
  | "aborted"
  | "model_failed";

/** One line per request. By construction there is no field that could hold SQL or claims. */
export interface ExplainLogEvent {
  readonly event: "explain";
  readonly outcome: ExplainOutcome;
  readonly status: number;
  readonly durationMs: number;
  readonly modelId: string;
  readonly requestHash?: string;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  /** Whether the validated answer was written to the cache. */
  readonly stored?: boolean;
  /** `error.name` or the Redis operation: a class of failure, never a message. */
  readonly errorName?: string;
}

export type ExplainLogger = (event: ExplainLogEvent) => void;

export interface ExplainDeps {
  readonly config: ExplainConfig;
  /** `undefined` without an API key; see `createExplainModel`. */
  readonly model: LanguageModel | undefined;
  readonly keys: KeyBuilder;
  readonly limiter: RateLimiter;
  readonly cache: Cache;
  readonly lock: Lock;
  readonly clock?: Clock | undefined;
  readonly logger?: ExplainLogger | undefined;
  /** The signed-in user, verified on the server. Never taken from the request body. */
  readonly resolveUserId?: ((request: Request) => Promise<string | undefined>) | undefined;
  /** How long a request that lost the lock waits for the winner's cache entry. */
  readonly followerWait?: Partial<WaitOptions> | undefined;
}

/** Header of a successful answer: `hit` came from the cache, `miss` from the model. */
export const EXPLAIN_CACHE_HEADER = "X-Explain-Cache";
export const FOLLOWER_WAIT_TIMEOUT_MS = 15_000;
export const FOLLOWER_WAIT_INTERVAL_MS = 250;

const UNKNOWN_CLIENT = "unknown";
const clientAddressSchema = z.string().regex(/^[0-9A-Fa-f:.]{2,45}$/);

const defaultLogger: ExplainLogger = (event) => {
  console.info(JSON.stringify(event));
};

export type ExplainAvailability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: "no-api-key" | "no-redis-in-production" };

/** Pure. Production without `REDIS_URL` keeps the endpoint off (brief 4.5). */
export function explainAvailability(config: ExplainConfig, hasModel: boolean): ExplainAvailability {
  if (!hasModel) {
    return { enabled: false, reason: "no-api-key" };
  }
  if (config.isProduction && config.redisUrl === undefined) {
    return { enabled: false, reason: "no-redis-in-production" };
  }
  if (!config.features.explainEnabled) {
    return { enabled: false, reason: "no-api-key" };
  }
  return { enabled: true };
}

const UNAVAILABLE_MESSAGES = {
  "no-api-key":
    "Explain is not configured on this deployment (no model API key). Everything else works without it.",
  "no-redis-in-production":
    "Explain is not configured on this deployment (production needs Redis for rate limiting). Everything else works without it.",
} as const;

/** Pure: SHA-256 over the normalised request, the model id and the prompt version (brief 4.5). */
export function hashExplainRequest(request: ExplainRequest, modelId: string): string {
  return createHash("sha256")
    .update(stableStringify({ model: modelId, prompt: PROMPT_VERSION, request }))
    .digest("hex");
}

/**
 * The first hop of `X-Forwarded-For`, which the hosting platform overwrites, else `X-Real-IP`.
 * Anything that does not look like an address shares one bucket, which is the strict choice.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded ?? headers.get("x-real-ip")?.trim();
  const parsed = clientAddressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : UNKNOWN_CLIENT;
}

function errorResponse(
  status: number,
  code: ExplainErrorCode,
  message: string,
  headers: Record<string, string> = {},
  issues?: readonly string[],
): Response {
  const body: ExplainErrorBody = {
    error: issues === undefined ? { code, message } : { code, message, issues: [...issues] },
  };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function explanationResponse(
  body: string | ReadableStream<Uint8Array>,
  cache: "hit" | "miss",
  headers: Record<string, string>,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      [EXPLAIN_CACHE_HEADER]: cache,
      ...headers,
    },
  });
}

/** The canonical JSON text of a valid explanation, else `undefined`. */
function canonicalExplanation(text: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = explanationSchema.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : undefined;
}

const errorNameOf = (error: unknown): string =>
  isRedisUnavailable(error) ? error.operation : error instanceof Error ? error.name : "unknown";

interface Flight {
  readonly deps: ExplainDeps;
  readonly model: LanguageModel;
  readonly modelId: string;
  readonly request: ExplainRequest;
  readonly requestHash: string;
  readonly headers: Record<string, string>;
  readonly lease: LockLease | undefined;
  readonly signal: AbortSignal;
  readonly log: (outcome: ExplainOutcome, status: number, extra?: Partial<ExplainLogEvent>) => void;
}

async function releaseQuietly(lock: Lock, lease: LockLease | undefined): Promise<void> {
  if (lease !== undefined) {
    // The lock has a TTL, so a failed release costs a follower time, never correctness.
    await lock.release(lease).catch(() => false);
  }
}

/** Validates the finished text and stores it. Returns whether it is now in the cache. */
async function storeAnswer(
  flight: Flight,
  text: string,
): Promise<"stored" | "unstored" | "invalid"> {
  const canonical = canonicalExplanation(text);
  if (canonical === undefined) {
    return "invalid";
  }
  try {
    await flight.deps.cache.set(
      flight.deps.keys.explanation(flight.requestHash),
      canonical,
      EXPLANATION_CACHE_TTL_SECONDS,
    );
    return "stored";
  } catch (error) {
    if (!isRedisUnavailable(error)) {
      throw error;
    }
    return "unstored";
  }
}

/**
 * Calls the model. Waits for the first text or the first failure before it answers, so that a
 * provider error or a refusal becomes a `502` instead of an empty `200`.
 */
async function streamFromModel(flight: Flight): Promise<Response> {
  const { deps, log } = flight;
  const abort = new AbortController();
  const signal = AbortSignal.any([flight.signal, abort.signal]);
  const result = streamText({
    model: flight.model,
    instructions: EXPLAIN_SYSTEM_PROMPT,
    prompt: buildExplainPrompt(flight.request),
    output: Output.object({ schema: explanationModelSchema }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 1,
    abortSignal: signal,
    providerOptions: modelProviderOptions(flight.modelId),
    // The default handler prints the error, and a provider error can hold the request body.
    onError: () => undefined,
  });
  const parts = result.stream[Symbol.asyncIterator]();

  let firstText: string | undefined;
  let failureName: string | undefined;
  try {
    for (let next = await parts.next(); !next.done; next = await parts.next()) {
      if (next.value.type === "text-delta" && next.value.text !== "") {
        firstText = next.value.text;
        break;
      }
      if (next.value.type === "error") {
        failureName = errorNameOf(next.value.error);
        break;
      }
    }
  } catch (error) {
    failureName = errorNameOf(error);
  }
  if (firstText === undefined) {
    abort.abort();
    await releaseQuietly(deps.lock, flight.lease);
    log("model_failed", 502, { errorName: failureName ?? "no-output" });
    return errorResponse(
      502,
      "model_failed",
      "The model did not return an explanation. Try again later.",
      flight.headers,
    );
  }

  const encoder = new TextEncoder();
  const opening = firstText;
  const pump = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    let text = opening;
    let outcome: ExplainOutcome = "streamed";
    let errorName: string | undefined;
    try {
      controller.enqueue(encoder.encode(opening));
      for (let next = await parts.next(); !next.done; next = await parts.next()) {
        const part = next.value;
        if (part.type === "text-delta") {
          text += part.text;
          controller.enqueue(encoder.encode(part.text));
        } else if (part.type === "error") {
          outcome = "model_failed";
          errorName = errorNameOf(part.error);
          break;
        } else if (part.type === "abort") {
          outcome = "aborted";
          break;
        }
      }
      if (outcome === "streamed") {
        controller.close();
      } else {
        controller.error(new Error("The explanation stream ended early."));
      }
    } catch (error) {
      // The client went away (enqueue on a cancelled stream) or the provider stream threw.
      outcome = signal.aborted ? "aborted" : "model_failed";
      errorName = errorNameOf(error);
      controller.error(new Error("The explanation stream ended early."));
    }

    let stored: boolean | undefined;
    try {
      if (outcome === "streamed") {
        const kept = await storeAnswer(flight, text);
        stored = kept === "stored";
        outcome = kept === "invalid" ? "streamed_invalid" : "streamed";
      }
    } finally {
      await releaseQuietly(deps.lock, flight.lease);
      log(outcome, 200, {
        responseBytes: utf8ByteLength(text),
        ...(stored === undefined ? {} : { stored }),
        ...(errorName === undefined ? {} : { errorName }),
      });
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void pump(controller);
    },
    cancel() {
      abort.abort();
    },
  });
  return explanationResponse(body, "miss", flight.headers);
}

/** `POST /api/explain`. Never throws for a Redis failure; see the file header for the policy. */
export async function handleExplain(request: Request, deps: ExplainDeps): Promise<Response> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const modelId = resolveModelId(deps.config);
  const emit = deps.logger ?? defaultLogger;
  const base: { requestHash?: string; requestBytes?: number } = {};
  const log: Flight["log"] = (outcome, status, extra = {}) => {
    emit({
      event: "explain",
      outcome,
      status,
      durationMs: clock() - started,
      modelId,
      ...base,
      ...extra,
    });
  };

  const availability = explainAvailability(deps.config, deps.model !== undefined);
  if (!availability.enabled || deps.model === undefined) {
    log("not_configured", 503);
    const reason = availability.enabled ? "no-api-key" : availability.reason;
    return errorResponse(503, "not_configured", UNAVAILABLE_MESSAGES[reason]);
  }

  const body = await readExplainRequest(request);
  base.requestBytes = body.bytes;
  if (!body.ok) {
    log("invalid_request", body.status);
    return errorResponse(body.status, body.code, body.message, {}, body.issues);
  }

  let lease: LockLease | undefined;
  let headers: Record<string, string> = {};
  const requestHash = hashExplainRequest(body.request, modelId);
  base.requestHash = requestHash;
  try {
    const userId = await deps.resolveUserId?.(request);
    const rate = await checkRateLimits(deps.limiter, deps.keys, "explain", {
      ip: clientAddress(request.headers),
      userId,
    });
    headers = explainRateLimitHeaders(rate, RATE_LIMITS.explain.windowSeconds);
    if (!rate.allowed) {
      log("rate_limited", 429);
      return errorResponse(
        429,
        "rate_limited",
        "Too many explanations requested. Wait a moment and try again.",
        headers,
      );
    }

    const cacheKey = deps.keys.explanation(requestHash);
    const readCached = async (): Promise<string | undefined> => {
      const hit = await deps.cache.get(cacheKey);
      return hit === undefined ? undefined : canonicalExplanation(hit);
    };

    const cached = await readCached();
    if (cached !== undefined) {
      log("cache_hit", 200, { responseBytes: utf8ByteLength(cached) });
      return explanationResponse(cached, "hit", headers);
    }

    lease = await deps.lock.acquire(
      deps.keys.explanationLock(requestHash),
      SINGLE_FLIGHT_LOCK_TTL_MS,
    );
    // Without the lease a peer is producing: wait briefly for its entry. With the lease, look
    // once more, because a peer may have stored its answer between our read and our acquire.
    const late =
      lease === undefined
        ? await waitForValue(readCached, {
            timeoutMs: FOLLOWER_WAIT_TIMEOUT_MS,
            intervalMs: FOLLOWER_WAIT_INTERVAL_MS,
            clock,
            ...deps.followerWait,
          })
        : await readCached();
    if (late !== undefined) {
      await releaseQuietly(deps.lock, lease);
      log("peer_hit", 200, { responseBytes: utf8ByteLength(late) });
      return explanationResponse(late, "hit", headers);
    }
  } catch (error) {
    await releaseQuietly(deps.lock, lease);
    if (!isRedisUnavailable(error)) {
      throw error;
    }
    log("redis_unavailable", 503, { errorName: errorNameOf(error) });
    return errorResponse(
      503,
      "unavailable",
      "Explain is temporarily unavailable. Try again later.",
      { "Retry-After": "30" },
    );
  }

  // A follower whose wait ran out falls through and asks the model itself, without the lease.
  return streamFromModel({
    deps,
    model: deps.model,
    modelId,
    request: body.request,
    requestHash,
    headers,
    lease,
    signal: request.signal,
    log,
  });
}
