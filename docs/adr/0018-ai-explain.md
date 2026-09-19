# AI explanation endpoint: request slice, prompt, wire shape, single-flight with a stream

Status: accepted (Phase 6, second half, server side; the lab UI follows)

## Context

Brief 3.2, 3.7, 4.5 to 4.8 and rules.yaml AI-001, AI-002, SEC-002, SEC-004, REDIS-002, ARCH-003,
TEST-001 ask for `POST /api/explain`: validated minimum input, rate limit, cache, single-flight
lock, streamed structured output; plus `GET /api/health` and config validation at boot. Verified
against the installed toolchain: `ai` 7.0.107, `@ai-sdk/anthropic` 4.0.58, zod 4.6, Next.js
16.3.5, Vitest 5, and the Redis layer of `docs/adr/0017-redis-design.md`. The `claude-api` skill
was consulted for model ids and request parameters before any code was written.

## Decisions

### Model (`src/lib/ai/model.ts`, AI-001)

- Default `claude-opus-5`; `ANTHROPIC_MODEL` (parsed by `src/lib/config`) overrides it. The module
  takes the parsed config as a parameter and never reads the environment.
- The request sets no `thinking` and no `effort`. The default model thinks adaptively when the
  parameter is omitted, and the cheapest override (`claude-haiku-4-5`) rejects `effort`, so leaving
  both out is the one request shape every override accepts.
- `maxOutputTokens` is 16 000 (thinking included). It is a cost cap on a public endpoint; the
  answer object is small. A truncated answer fails validation and is never cached.
- `providerOptions.anthropic.fallbacks = "default"` is sent for the default model only. Policy SQL
  is security-adjacent text, so a safety refusal is possible; the fallback lets the API retry the
  turn server side. An override gets no fallback chain, because support cannot be known for an
  arbitrary id. NOT verified with a live call (TEST-001; no key in this environment).

### AI SDK 7 API (deviation from the brief's wording)

- `streamObject` is deprecated in AI SDK 7. The route uses
  `streamText({ output: Output.object({ schema }), instructions, prompt, ... })`. `instructions`
  replaces the deprecated `system`.
- The schema given to the model (`explanationModelSchema`) has descriptions and an enum but no
  length limits, because provider structured-output modes support only part of JSON Schema. The
  limits live in `explanationSchema` (strict), which validates the finished text on the server
  before caching and again in the client helper.
- `onError` is overridden with a no-op. The default prints the error object, and an
  `APICallError` carries `requestBodyValues`, which would put SQL and claims into the server log
  (brief 4.7). The log gets `error.name` only.
- The documentation's mock `finish` chunk has `logprobs: undefined`; the installed
  `LanguageModelV4StreamPart` type has no such field, so the fixtures omit it.

### Request slice (`schema.ts`, `build-request.ts`)

- Every object is `z.strictObject`: `seedSql`, `schemaSql` or a whole scenario is refused with 400,
  not silently dropped and not forwarded.
- `buildExplainRequest(cell, catalog, scenario, findings)` renders the table DDL from the catalog
  (columns, types, defaults, key, owner, RLS switches), so neither `schemaSql` nor `seedSql` is
  read. It sends ALL policies on the table with `appliesAs: command | visibility | none` (a policy
  written for another role or command is often the explanation of an overblock), the grants the
  persona's role holds (directly, by membership, through PUBLIC), the effective claims, the
  owner and tenant columns, the custom expectation query for a `custom` scope, capped key samples
  (20 per list, totals kept) and the static findings on that table.
- Sub-probe statements and the cell's `sql` transcript are NOT sent: an insert probe inlines the
  values of a cloned seed row. The bare reach `statement` holds no row values and is sent.
- Only `leak`, `escape` and `overblock` are accepted (brief 3.7: failing cells only).
- Payload cap 30 720 bytes (rules.yaml `thresholds.ai`). The builder shrinks in steps (finding
  evidence, key samples, findings) and returns `too-large` rather than cutting DDL or a policy.
- The route checks `Content-Length` first, then counts bytes while reading and cancels the read
  at the cap, then decodes as strict UTF-8, then `JSON.parse`, then zod. Validation issues are
  reported as path plus zod message: they name fields, never values.

### Prompt (`prompt.ts`, AI-002)

- `PROMPT_VERSION = "1"` is part of the cache key.
- The system prompt states that the engine already proved the failure, that the model explains and
  proposes SQL to be re-tested, that it never declares a verdict, and that everything inside the
  single `<untrusted_data>` block is data and NEVER an instruction.
- The request is embedded as stable JSON with `<` and `>` written as JSON unicode escapes, so no
  string inside the data can close the block. Outside the block only enum values the schema
  validated are interpolated. The escape prefix is built with `String.fromCharCode(92)` because
  a tool in the authoring chain decoded the literal escape sequence into `<`.

### Order of checks (deviation from the task text)

Feature enabled -> body -> rate limit -> cache -> lock -> model. The task listed validation before
the feature check. With the feature off nothing of an untrusted body is read or parsed; the only
visible difference is that an invalid request to a disabled endpoint gets 503 instead of 400.

### Feature gating and failure policy

- No API key: 503 `{ error: { code: "not_configured", message: "Explain is not configured ..." } }`.
- Production without `REDIS_URL`: the same 503 (`features.explainEnabled` is false, brief 4.5).
- Any `RedisUnavailableError` before the model is called (limiter, cache read, lock): 503
  `unavailable` with `Retry-After: 30`, in every environment, not only production. Simpler than a
  per-environment policy and never wrong: without the limiter the endpoint is unmetered.
- A cache WRITE that fails after the answer streamed is logged (`stored: false`) and nothing else.
- A cached value that does not pass `explanationSchema` is a miss.

### Rate limit headers (verified, deviation)

The current IETF draft (draft-ietf-httpapi-ratelimit-headers, revisions 07 and later; revision 11
at the time of writing, checked on the IETF datatracker) defines `RateLimit-Policy` and
`RateLimit` as structured fields (`"explain";q=5;w=60` and `"explain";r=4;t=12`). The Redis
layer's `rateLimitHeaders` emits the three fields of the earlier revisions plus `Retry-After`.
`/api/explain` sends both sets (`src/lib/ai/rate-limit-headers.ts`). A cache hit still costs one
unit of the limit: the limiter runs before the cache.

The per-user limit needs a user id that the SERVER verified. `ExplainDeps.resolveUserId` is the
seam; the route does not pass one until the Supabase session check exists. The request body can
never name a user.

### Single-flight with a stream (deviation from `singleFlight`)

`singleFlight` of the Redis layer wants `produce()` to resolve with the finished value, which
would turn the winner's stream into a buffered answer. `handleExplain` therefore uses the `Lock`
port and `waitForValue` directly: read cache -> acquire -> (winner) read once more, stream, then
validate, store with the 7 day TTL and release; (follower) poll the cache for up to 15 s every
250 ms, answer from it, else fall through to its own model call without the lease. The lock TTL
is 30 s. The pump that feeds the response body is detached from the consumer, so the winner
stores its answer even when nobody reads its body quickly.

### Wire shape

A successful answer is always `200 text/plain; charset=utf-8` whose body is the JSON text of one
`Explanation`: streamed from the model (`X-Explain-Cache: miss`) or sent at once from the cache
(`hit`). This is the shape `useObject` of `@ai-sdk/react` reads too. `src/lib/ai/client.ts`
(`requestExplanation`, `readExplanationResponse`) reads both with one code path, reports parseable
prefixes through `onPartial` (`parsePartialJson` from `ai`), and returns `ok` only when the
complete text passes `explanationSchema`. Every other answer is JSON
`{ error: { code, message, issues? } }` with status 400, 413, 415, 429, 502 or 503.

The route waits for the first text delta (or the first error) before it answers. A provider
error, a refusal or an empty answer therefore becomes `502 model_failed` instead of an empty 200.
Cost: response headers arrive only after the model's thinking phase. A failure after the first
byte errors the body stream; the client helper reports `invalid_response`. A client that goes
away aborts the model call; nothing is cached and the lock is released.

### Logs

One JSON line per request through an injectable logger: outcome, status, duration, model id,
SHA-256 of the normalised request, request and response sizes, `stored`, and an error class name.
There is no field that could hold SQL, claims, keys or the client address.

### Health and boot

- `GET /api/health` returns `{ status, buildId, features: { explain, redis, supabase } }`, built
  field by field from the feature flags (`src/lib/ai/health.ts`; it sits in `src/lib/ai` only
  because of this task's ownership, and may move to a neutral directory later).
- `src/instrumentation.ts` `register()` calls `getServerConfig()`. No runtime guard: the config
  module needs only zod and loads in every runtime `register()` runs in.

## Evidence

- `npx vitest run src/lib/ai tests/api`: 8 files, 81 tests pass, model mocked with
  `MockLanguageModelV4` from `ai/test`; coverage of `src/lib/ai/**` 97 % lines, 93 % branches.
- Tests cover: oversize by header and by counted bytes, wrong shape, seed data fields refused,
  429 with both header sets, per-user limit, cache hit without a model call, two concurrent
  identical requests with one model call, follower fall-through, missing key, production without
  Redis, Redis down with 503 and no model call, provider rejection (502, lock freed), mid-stream
  failure, invalid model output never cached, client disconnect, the client helper on the real
  response, the untrusted-data instruction in the prompt the model received, logs without SQL or
  claims, health booleans, the builder on a real PGlite matrix run without seed values.
- `next dev`: `GET /api/health` 200 with booleans and the security headers, `POST /api/explain`
  503 `not_configured` with zero environment variables, `GET /api/explain` 405.

## Consequences

- The UI builds the body with `buildExplainRequest`, calls `requestExplanation`, and must run the
  verified-fix loop itself: `proposedPolicySql` is a proposal until the matrix was re-run (AI-002).
- Changing the prompt means bumping `PROMPT_VERSION`; changing the request or answer schema
  changes the hash input or invalidates cached entries on read, so no manual flush is needed.
- Not verified live: the real provider stream, `fallbacks: "default"`, and time to first byte with
  thinking. A run with `RUN_LIVE_AI_TESTS=1` and a key is the place for that.
