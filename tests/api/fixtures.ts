/**
 * Shared by the `/api/explain` suites: a valid request, a mocked model (rules.yaml TEST-001: no
 * test talks to a real one), in-memory Redis services and the dependencies of `handleExplain`.
 */
import { randomUUID } from "node:crypto";

import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { ExplainDeps, ExplainLogEvent } from "@/lib/ai/explain";
import type { ExplainRequest, Explanation } from "@/lib/ai/schema";
import { parseServerEnv, type EnvRecord, type ServerConfig } from "@/lib/config/env";
import { createRedisServices, type Cache, type RedisServices } from "@/lib/redis";

export const POLICY_EXPRESSION =
  "(tenant_id = ((current_setting('request.jwt.claims'))::json ->> 'tenant_id')::int)";
export const PERSONA_SUB = "11111111-1111-4111-8111-111111111111";

export function validRequest(overrides: Partial<ExplainRequest> = {}): ExplainRequest {
  return {
    version: 1,
    mode: "postgres",
    cell: {
      operation: "update",
      status: "escape",
      scope: "tenant",
      expectationSource: "explicit",
      expectedRowsSql: null,
      reason: null,
      statement: 'update "public"."projects" set "name" = "name" returning "id"::text',
      perRowFallback: false,
      error: null,
      rlsBypass: null,
      subProbes: [
        {
          kind: "escape-targeted",
          expected: "blocked",
          outcome: "allowed",
          status: "escape",
          reason: null,
          error: null,
        },
      ],
    },
    table: {
      schema: "public",
      name: "projects",
      ddl: 'create table "public"."projects" (\n  "id" integer not null,\n  "tenant_id" integer not null\n);',
      owner: "postgres",
      rlsEnabled: true,
      rlsForced: false,
      ownerColumn: "user_id",
      tenantColumn: "tenant_id",
      grants: ["SELECT", "UPDATE"],
    },
    policies: [
      {
        name: "change",
        command: "update",
        permissive: true,
        roles: ["app_user"],
        using: POLICY_EXPRESSION,
        withCheck: "true",
        appliesAs: "command",
      },
    ],
    persona: {
      dbRole: "app_user",
      claimsJson: JSON.stringify({ sub: PERSONA_SUB, tenant_id: 1 }),
      tenantClaimPath: "tenant_id",
    },
    keys: {
      expected: { total: 2, sample: ['["1"]', '["2"]'] },
      actual: { total: 2, sample: ['["1"]', '["2"]'] },
      leaked: { total: 0, sample: [] },
      missing: { total: 0, sample: [] },
      blind: { total: 0, sample: [] },
    },
    findings: [],
    ...overrides,
  };
}

export const EXPLANATION: Explanation = {
  explanation:
    "The update policy checks the tenant only in USING. WITH CHECK (true) accepts any new row, so a row can be moved to another tenant.",
  rootCause: 'Policy "change" has WITH CHECK (true).',
  proposedPolicySql:
    'DROP POLICY IF EXISTS "change" ON "public"."projects";\nCREATE POLICY "change" ON "public"."projects" FOR UPDATE TO "app_user" USING (tenant_id = 1) WITH CHECK (tenant_id = 1);',
  confidence: "high",
};

/** The text cut into pieces of `size` characters, the way a model streams it. */
export function chunksOf(text: string, size = 17): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) {
    chunks.push(text.slice(at, at + size));
  }
  return chunks;
}

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamChunk = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

/** The provider stream of one answer. `failAfter` ends it with an error part instead. */
export function answerStream(text: string, failAfter?: number, delayMs?: number): StreamResult {
  const deltas = chunksOf(text).map((delta): StreamChunk => ({
    type: "text-delta",
    id: "answer",
    delta,
  }));
  const chunks: StreamChunk[] =
    failAfter === undefined
      ? [
          { type: "text-start", id: "answer" },
          ...deltas,
          { type: "text-end", id: "answer" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: USAGE,
          },
        ]
      : [
          { type: "text-start", id: "answer" },
          ...deltas.slice(0, failAfter),
          { type: "error", error: new Error(`provider error quoting ${POLICY_EXPRESSION}`) },
        ];
  return {
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: delayMs ?? null,
    }),
  };
}

export interface MockModelOptions {
  readonly text?: string;
  /** Number of text chunks before the stream errors. */
  readonly failAfter?: number;
  /** Milliseconds between two chunks; none by default. */
  readonly delayMs?: number;
  /** Rejects the call itself, like a provider that answers 401 or 529. */
  readonly reject?: boolean;
  /** The n-th call (0-based) waits for this promise before it answers. */
  readonly gate?: { readonly call: number; readonly open: Promise<void> };
}

export function mockModel(options: MockModelOptions = {}): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call = calls;
      calls += 1;
      if (options.gate?.call === call) {
        await options.gate.open;
      }
      if (options.reject === true) {
        throw new Error(`provider rejected the call quoting ${POLICY_EXPRESSION}`);
      }
      return answerStream(
        options.text ?? JSON.stringify(EXPLANATION),
        options.failAfter,
        options.delayMs,
      );
    },
  });
}

export function serverConfig(env: EnvRecord = {}): ServerConfig {
  return parseServerEnv({ NODE_ENV: "test", ANTHROPIC_API_KEY: "test-key", ...env });
}

/** In-memory adapters under a key environment no other test shares. */
export function memoryServices(): RedisServices {
  return createRedisServices({
    envName: `test-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    redisUrl: undefined,
  });
}

export interface Harness {
  readonly deps: ExplainDeps;
  readonly services: RedisServices;
  readonly events: ExplainLogEvent[];
}

type Overrides = Partial<ExplainDeps> | ((services: RedisServices) => Partial<ExplainDeps>);

export function harness(overrides: Overrides = {}): Harness {
  const services = memoryServices();
  const events: ExplainLogEvent[] = [];
  return {
    services,
    events,
    deps: {
      config: serverConfig(),
      model: mockModel(),
      keys: services.keys,
      limiter: services.rateLimiter,
      cache: services.cache,
      lock: services.lock,
      logger: (event) => events.push(event),
      followerWait: { timeoutMs: 2_000, intervalMs: 5 },
      ...(typeof overrides === "function" ? overrides(services) : overrides),
    },
  };
}

/** The real cache with a different `set`. The adapter is a class, so a spread would lose it. */
export function cacheWithSet(cache: Cache, set: Cache["set"]): Cache {
  return { get: (key) => cache.get(key), set, delete: (key) => cache.delete(key) };
}

export interface PostOptions {
  readonly ip?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export function post(body: unknown, options: PostOptions = {}): Request {
  return new Request("http://localhost/api/explain", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": options.ip ?? "203.0.113.7",
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal ?? null,
  });
}

/** Lets the detached pump of a streamed answer finish: cache write, lock release, log line. */
export async function settled(events: readonly ExplainLogEvent[], count: number): Promise<void> {
  for (let tries = 0; tries < 400 && events.length < count; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
