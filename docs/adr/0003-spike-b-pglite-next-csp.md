# ADR 0003: Spike B, PGlite inside Next.js, in a Web Worker, with the CSP on

- Status: accepted. The open item of the first version (root layout) was closed on 2026-09-19;
  see "The root layout renders dynamically"
- Date: 2026-09-19
- Phase: 1 (spike B)
- Versions: Next.js 16.3.5, React 19.2.8, `@electric-sql/pglite` 0.5.8 (PostgreSQL 18.3),
  Playwright 1.63.0 with Chromium 153

## Context

Section 4.4 of the brief calls bundling PGlite's WASM and filesystem image under Next.js "a known
friction point" and asks for proof in `next dev` and in `next build && next start`, inside a Web
Worker, with a strict Content-Security-Policy active. This ADR records what was built, what was
measured, and every trap found on the way. Everything below was observed on this machine; nothing
is quoted from memory of older versions.

## Decision

### Bundler: Turbopack for both modes, with scope hoisting switched off

Next.js 16.3.5 uses Turbopack by default for `next dev` and for `next build` (the build log prints
`Next.js 16.3.5 (Turbopack)`; `--webpack` is the opt-out). Turbopack is kept.

`next.config.ts` sets `experimental.turbopackScopeHoisting: false`. This is required, not cosmetic;
see trap 1.

### Assets: emitted by the bundler, no `public/pglite/` copy

The worker is created with the literal form both bundlers recognise:

```ts
new Worker(new URL("./pglite.worker.ts", import.meta.url), { type: "module", name: "pglite" });
```

PGlite locates its own files with `new URL("./pglite.wasm", import.meta.url)` (and the same for
`initdb.wasm` and `pglite.data`). Turbopack follows those references and emits hashed files:

```
.next/static/media/pglite.<hash>.wasm    10 088 161 bytes
.next/static/media/pglite.<hash>.data     6 295 316 bytes
.next/static/media/initdb.<hash>.wasm       395 242 bytes
```

They are served as `application/wasm` and `application/octet-stream`, which
`WebAssembly.instantiateStreaming` needs. Nothing is copied on `postinstall`, so `npm ci` on a
clean clone needs no extra step and there is no `scripts/copy-pglite-assets.mjs`. The fallback from
section 4.4 was not needed. Note that it would not have fixed trap 1 on its own: that bug is in how
PGlite's JavaScript is bundled, not in how its assets are located.

### Lazy loading

`src/app/lab/page.tsx` (server) renders `lab-loader.tsx` (client), which loads `lab-spike.tsx`
through `next/dynamic` with `ssr: false`. In Next.js 16 `ssr: false` is only allowed inside a Client
Component, hence the wrapper. Only `lab-spike.tsx` imports `create-worker.ts`. The e2e suite proves
that `/` requests no `.wasm`, no `.data`, starts no worker, and that no script it downloads contains
PGlite code.

### Security headers

`src/lib/security/csp.ts` is a pure module (no React, no `next/*`, no `process.env`) with a unit
test. It builds two policies because there are two kinds of response:

1. **Document policy**, per-request nonce, set by `src/proxy.ts` on the request (so the App Router
   stamps the nonce on its scripts) and on the response. `proxy.ts` is the Next.js 16 name for
   `middleware.ts`, which is deprecated; it runs on the Node.js runtime. Matcher:
   `/((?!_next/static).*)`, so pages, route handlers, 404s and `public/` files are all covered.
2. **Asset policy**, no nonce, set in `next.config.ts` `headers()` for `/_next/static/:path*`, the
   paths the proxy skips.

The request-independent headers are set in `next.config.ts` for `/:path*`: `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
`Permissions-Policy` (accelerometer, camera, geolocation, gyroscope, magnetometer, microphone,
payment, usb all `()`), and in production `Strict-Transport-Security: max-age=63072000;
includeSubDomains`. `poweredByHeader` is off.

Exact production document policy (pinned by `csp.test.ts`; the live header is checked directive by
directive in the e2e suite):

```
default-src 'self'; script-src 'self' 'nonce-<128-bit base64>' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```

Exact production asset policy:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

No `'unsafe-eval'` and no script `'unsafe-inline'` in production. `'strict-dynamic'` is not used:
the brief asks for `'self'` plus a nonce, and with `'strict-dynamic'` browsers ignore `'self'`.

`style-src` allows `'unsafe-inline'` deliberately. React writes `style=""` attributes into
server-rendered HTML, and sonner 2.0.8, already installed, injects a `<style>` element with no
nonce support (checked in its dist). Inline styles cannot run code. A later phase may tighten this;
CodeMirror 6 accepts a nonce through the `EditorView.cspNonce` facet (checked in
`@codemirror/view`'s types).

Development relaxations, gated on `NODE_ENV === "development"` and asserted by the e2e suite in dev
mode:

- `'unsafe-eval'` is added to `script-src` in both policies. The Next.js CSP guide states React
  needs `eval` in development to rebuild server error stacks. It was the only relaxation needed:
  the HMR websocket is covered by `connect-src 'self'`.
- `upgrade-insecure-requests` and HSTS are omitted, because the dev server is plain http.

Later phases extend `connect-src` through the `connectSrc` option. Each entry must be a plain
`https://` or `wss://` origin; anything containing whitespace, quotes, `;`, `,`, a path, a bare
scheme or a keyword throws `CspConfigError`, so a configuration value cannot inject a directive.
The explain API is same-origin and needs no entry; Supabase needs its `https://` and `wss://`
origins.

### Worker and timeout design

Files under `src/lib/engine/worker/`:

- `protocol.ts`: typed `WorkerRequest` (`init`, `exec`) and `WorkerResponse`, with runtime guards.
  Cells are `string | number | boolean | null`; `bigint`, dates, `bytea` and JSON are converted to
  strings inside the worker so both sides see one deterministic, structured-clone-safe shape.
- `handler.ts`: the worker's logic without `self` and without the PGlite import, so it is tested in
  Node against a real PGlite. Requests are answered strictly in order. A failed start is retried on
  the next request. Errors carry SQLSTATE (`code`), `detail`, `hint`, `position`.
- `pglite.worker.ts`: glue only. In-memory database (`PGlite.create()`).
- `client.ts`: `PgliteWorkerClient`, DOM-free, worker injected through a factory. Every request has
  a timeout (`exec` 5 s, `init` 30 s by default, both overridable per call). A query inside WASM
  cannot be cancelled, so on timeout the client calls `worker.terminate()`, rejects the timed-out
  request with `WorkerTimeoutError` and everything else in flight with `WorkerTerminatedError`, and
  creates a new worker lazily on the next request. `generation` counts workers started.
- `create-worker.ts`: the only file with `new Worker(...)`; browser-only.

Proven in the browser: `select pg_sleep(10)` with a 1.5 s timeout ends in `timed-out` well under
8 s, three clicks on another button are counted while the query is stuck (the page stays
responsive), and the next run gets worker generation 2 with correct results. `pg_sleep` does block
the single WASM thread in PGlite 0.5.8, so it is a valid runaway query for tests.

The e2e test does not take the page's word for the termination or for the fresh database:

- **Termination is observed from outside the page.** Playwright emits `close` on a `Worker` when
  the browser destroys it. `PageGuard` records those events; the test requires exactly one, for
  the first worker (compared by identity), requires `page.workers()` to be empty right after the
  timeout and to hold only the second worker after recovery, and then waits past the 10 s at which
  `pg_sleep(10)` would have returned to check that nothing from the first worker reaches the page
  (status still `timed-out`, generation still 2, still one live worker, still one `close`).
- **A fresh database is told apart from a surviving one.** The proof's `SETUP_SQL` starts with
  `drop table if exists` / `drop role if exists`, so its results look the same either way. The lab
  therefore has a marker table, `spike_survivor_marker`, that `SETUP_SQL` never touches, and shows
  what `to_regclass` says about it after every run. The test creates it, re-runs the proof **on the
  same worker** and requires the marker to still be there (generation 1, no `close`): that is the
  control which makes the next assertion mean something. After the timeout and the re-run on
  worker 2 the marker must be absent.
- Negative control, run once by hand: with `worker?.terminate()` removed from `client.ts` the test
  fails at the `close` assertion (`Expected: 1, Received: 0`). The file was restored afterwards.

## Verification

`npm run e2e` (`next build && playwright test`, prod mode) and `npm run e2e:dev`
(`E2E_MODE=dev playwright test`). Both use port 3100 with `reuseExistingServer: false`.
`e2e:dev` uses POSIX env syntax; there is no `cross-env` in the project.

| Test                                                                       | dev  | prod |
| -------------------------------------------------------------------------- | ---- | ---- |
| Postgres with RLS in a worker, result rendered as text                     | pass | pass |
| Strict CSP and the other headers (page, `/`, 404, worker JS)               | pass | pass |
| `/` hydrates and then loads no PGlite asset, worker or code                | pass | pass |
| `/` hydrates without a CSP violation or page error                         | pass | pass |
| The 404 page hydrates without a CSP violation or page error                | pass | pass |
| Timeout kills the worker (browser `close` event), a fresh database follows | pass | pass |

Last run on 2026-09-19: `npm run e2e` 6 passed, build output `ƒ /`, `ƒ /_not-found`, `ƒ /lab`;
`npm run e2e:dev` 6 passed. In the first version of this ADR the fourth row failed in production
(4 passed, 1 failed); see the next section for the cause and the fix.

The lab tests also assert: no `securitypolicyviolation` event, no console error, no console line
mentioning the CSP, no uncaught page error. The 404 test allows exactly one console line, the one
Chromium prints for the 404 status of the document itself.

"Hydrates" is checked, not assumed: `PageGuard.waitForHydration` waits until React has put its
`__reactFiber$...` key on the page's `<h1>`. A page whose inline scripts were blocked keeps its
server-rendered markup, so a text assertion alone passes on a dead page, and "requests no PGlite
asset" would pass for the wrong reason. The two hydration tests also require the response to have
no `x-nextjs-prerender` header and every inline `<script>` in the raw HTML to carry the nonce of
that response's own policy.

Unit tests: `csp.test.ts`, `client.test.ts` (fake worker, fake timers), `handler.test.ts` (real
PGlite, including an RLS policy filtering a non-superuser role). `vitest run --coverage` over
`src/lib/**` as it stood when this spike finished reported 94.8 percent lines and 97.4 percent
branches. `create-worker.ts` and `pglite.worker.ts` show 0 percent in Vitest because they only run
in a browser; Playwright exercises them.

### Measured cold start

Headless Chromium 153 on an Apple-silicon Mac, server on localhost, so download time is near zero.
"Worker" is `PGlite.create()` plus `select version()` measured inside the worker; "page" is from
creating the worker to the finished RLS proof, measured on the page.

| Mode                               | Worker  | Page    |
| ---------------------------------- | ------- | ------- |
| prod, single page                  | 1135 ms | 1188 ms |
| prod, 5 Playwright workers at once | 1422 ms | 1478 ms |
| prod, 4 Playwright workers at once | 1764 ms | 1824 ms |
| dev                                | 1157 ms | 1222 ms |

A real visitor also downloads about 16.8 MB before compression on the first visit. Every timeout
costs one more cold start, because the replacement worker boots Postgres again.

## The root layout renders dynamically

A nonce only reaches the HTML when the page is rendered for a real request. A prerendered page
ships inline `self.__next_f.push(...)` scripts without a nonce, the policy blocks them, and the page
does not hydrate. This was observed twice. First on `/lab`, which was prerendered (`○`) until a
segment layout awaited `connection()`. Then, found in review, on `/` and `/_not-found`: the build
printed `○ /` and `○ /_not-found`, the responses carried `x-nextjs-prerender: 1`, their five inline
scripts had no nonce, Chromium reported five `script-src-elem` violations, neither page hydrated,
and `npm run e2e` exited 1 (4 passed, 1 failed). This was not a bundler problem, so neither a
bundler switch nor the `public/pglite/` fallback was the answer.

The fix, from the Next.js CSP guide (`node_modules/next/dist/docs/01-app/02-guides/
content-security-policy.md`, "Forcing dynamic rendering"), is one line in `src/app/layout.tsx`:

```tsx
import { connection } from "next/server";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  ...
```

Because it sits in the root layout it covers every route and the 404 page. The build now prints
`ƒ /`, `ƒ /_not-found`, `ƒ /lab`. `src/app/lab/layout.tsx`, which did the same for `/lab` only, was
redundant and has been deleted. The header comment of `src/proxy.ts`, which already claimed that
the root layout awaits `connection()`, is true now.

Negative control, run once by hand: with the `await connection()` line removed, the build prints
`○` for all three routes and all six production tests fail, the landing tests on
`x-nextjs-prerender` being `"1"` and on `waitForHydration` timing out. The line was restored.

When Phase 2 or 5 adds `next-themes`, the layout should read `(await headers()).get("x-nonce")`
and pass it on (trap 6). The installed Next.js docs say `headers()` opts a route into dynamic
rendering as well (`04-functions/headers.md`; not measured here), but keep `await connection()`:
it states the intent and does not depend on somebody keeping the nonce read.

Consequence to accept: with a nonce-based policy no page is static, so nothing is served from a CDN
cache as HTML. The pages are small and the heavy work happens in the browser. The alternative in
the Next.js guide, experimental SRI, was not evaluated.

## Traps for later agents

1. **Turbopack scope hoisting breaks PGlite in production only.** With the default settings the
   production build fails at run time with `instantiateWasm is not a function`, while `next dev`
   works, because hoisting is "always disabled in dev mode". In an unminified build the cause is
   readable: Turbopack merges PGlite's dist chunks into one scope, renames the utility namespace
   object from `p` to `p1` (another merged chunk declares `var p = Object.create`), and also renames
   a local variable inside PGlite's initdb function to `p1` (`p1 = -1`, later
   `p1 = S._fopen(...)`). The local shadows the namespace, so `p1.instantiateWasm(...)` is called on
   a number. Turning minification off does not help; turning scope hoisting off does. Re-test
   before removing the flag after a Next.js or PGlite upgrade: delete it, run `npm run e2e`.
   `next build --webpack` was not tried.
2. **A worker is governed by the CSP of its own script response, not the page's.** Verified: with
   `'wasm-unsafe-eval'` removed from the asset policy only, WebAssembly compilation inside the
   worker was blocked and the error quoted the worker's policy (`script-src 'self'`). Anything the
   worker must fetch or run has to be allowed in `buildAssetCsp`, not only in the document policy.
3. **A WASM load failure hangs `PGlite.create()`.** In that experiment the promise never settled;
   the error surfaced only as an unhandled rejection inside the worker and the Worker `error` event
   did not fire. Only the client's `init` timeout ends the request, so never call `init` without
   one.
4. **A new worker is an empty database.** After a timeout the runner must replay schema and seed
   before the next probe.
5. **React's development double mount** would start two workers. `lab-spike.tsx` defers the first
   run by one task and clears it in the effect cleanup; keep that pattern or `generation` is off by
   one in dev.
6. **`next-themes` injects an inline script.** It must receive the nonce
   (`<ThemeProvider nonce={nonce}>`), read in the root layout from the `x-nonce` request header
   that `proxy.ts` sets.
7. **`upgrade-insecure-requests` and localhost.** Observed: with the directive present, `next start`
   on `http://localhost:3100` loads every subresource in Chromium 153. Other engines were not
   tested, and neither was a plain-http host other than localhost.
8. **`proxy.ts` reads `process.env.NODE_ENV`.** Phase 2 makes `src/lib/config` the only reader of
   `process.env`; `src/proxy.ts` and `next.config.ts` need an exemption or a change then.
9. **Vitest `it.each` titles**: `%j` calls `JSON.stringify` and throws on a `bigint` while
   collecting tests. Use `%#` or `%s` for cases that contain one.

## Consequences

- The engine for Phase 3 can build on `PgliteWorkerClient` and the typed protocol as they are; the
  protocol has two request types and is meant to grow.
- Bundles are slightly larger without scope hoisting. That is the price of a working production
  build on this Next.js version.
- `/lab` is a spike surface with stable `data-testid` hooks; Phase 5 replaces the UI and keeps the
  worker client, the loader pattern and the e2e guard in `e2e/support/page-guard.ts`.
- Every new page inherits dynamic rendering from the root layout. A route that opts back into
  static rendering (`export const dynamic = "force-static"`, `generateStaticParams` with a full
  prerender, Partial Prerendering) will ship scripts without a nonce and will not hydrate under
  this policy. Give every new page a "hydrates without a CSP violation" e2e test like the two here.
