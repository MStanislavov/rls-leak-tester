/**
 * Content-Security-Policy and security header construction.
 *
 * Pure: no React, no `next/*`, no `process.env`. Callers pass `isDev` in.
 * Two policies exist because two kinds of response exist:
 *
 * - Documents and every other response that goes through `src/proxy.ts` get
 *   the *document policy* with a fresh per-request nonce.
 * - Files under `/_next/static/` are served without the proxy, so they get the
 *   nonce-free *asset policy* from `next.config.ts`. That one matters more than
 *   it looks: a dedicated worker is governed by the CSP delivered with its own
 *   script, not by the page's. The PGlite worker compiles WebAssembly, so its
 *   script response has to carry `'wasm-unsafe-eval'`.
 *
 * Later phases extend `connect-src` (Supabase, nothing else is cross-origin)
 * through `connectSrc`; every extra source is validated before it reaches a
 * header value.
 */

export type CspDirectiveName =
  | "default-src"
  | "script-src"
  | "style-src"
  | "img-src"
  | "font-src"
  | "connect-src"
  | "worker-src"
  | "object-src"
  | "base-uri"
  | "form-action"
  | "frame-ancestors"
  | "upgrade-insecure-requests";

/** Ordered list of directives; an empty source list renders a bare directive. */
export type CspDirectives = ReadonlyArray<readonly [CspDirectiveName, readonly string[]]>;

export interface CspOptions {
  /** `true` only under `next dev`. Switches on the documented relaxations. */
  readonly isDev: boolean;
  /** Extra origins for `connect-src`, for example the Supabase project URL. */
  readonly connectSrc?: readonly string[];
}

export interface DocumentCspOptions extends CspOptions {
  /** Per-request nonce from {@link generateNonce}. */
  readonly nonce: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/**
 * A `connect-src` extra must be a plain origin (`https://host[:port]`,
 * `wss://host[:port]`), optionally with a leading `*.` wildcard label. Keywords,
 * paths, bare schemes and anything with whitespace, quotes, `;` or `,` are
 * refused, so a configuration value can never smuggle in a second directive.
 */
const ORIGIN_SOURCE_PATTERN =
  /^(https|wss):\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

export class CspConfigError extends Error {
  override readonly name = "CspConfigError";
}

/** 128 bits from the platform CSPRNG, base64. Works in Node and in the browser. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new CspConfigError("CSP nonce must be at least 16 base64 characters");
  }
}

function validatedConnectSources(extra: readonly string[] | undefined): string[] {
  const sources: string[] = [];
  for (const source of extra ?? []) {
    if (!ORIGIN_SOURCE_PATTERN.test(source)) {
      throw new CspConfigError(
        `connect-src accepts only https:// or wss:// origins, got ${JSON.stringify(source)}`,
      );
    }
    if (!sources.includes(source)) {
      sources.push(source);
    }
  }
  return sources;
}

/**
 * Policy for documents, route handlers and everything else the proxy sees.
 *
 * Production `script-src` is exactly `'self'`, the nonce and
 * `'wasm-unsafe-eval'`. Development adds `'unsafe-eval'`, which React needs to
 * rebuild server error stacks in the browser (see the Next.js CSP guide), and
 * drops `upgrade-insecure-requests` because the dev server is plain http.
 *
 * `style-src` allows `'unsafe-inline'` on purpose: React writes `style=""`
 * attributes into server-rendered HTML, and sonner (checked in 2.0.8) injects a
 * `<style>` element without a nonce. Inline styles cannot execute code; the
 * script policy is the one that stays strict.
 */
export function buildDocumentCspDirectives(options: DocumentCspOptions): CspDirectives {
  assertNonce(options.nonce);
  const scriptSrc = ["'self'", `'nonce-${options.nonce}'`, "'wasm-unsafe-eval'"];
  if (options.isDev) {
    scriptSrc.push("'unsafe-eval'");
  }
  const directives: Array<readonly [CspDirectiveName, readonly string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...validatedConnectSources(options.connectSrc)]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  if (!options.isDev) {
    directives.push(["upgrade-insecure-requests", []]);
  }
  return directives;
}

/**
 * Policy for `/_next/static/*`. It is what governs the PGlite worker: the
 * worker may run same-origin script, compile WebAssembly and fetch same-origin
 * files (`pglite.wasm`, `pglite.data`), and nothing else. No nonce, because a
 * static file has no request to tie one to.
 */
export function buildAssetCspDirectives(options: CspOptions): CspDirectives {
  const scriptSrc = ["'self'", "'wasm-unsafe-eval'"];
  if (options.isDev) {
    scriptSrc.push("'unsafe-eval'");
  }
  return [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["connect-src", ["'self'", ...validatedConnectSources(options.connectSrc)]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
  ];
}

export function serializeCsp(directives: CspDirectives): string {
  return directives
    .map(([name, sources]) => (sources.length === 0 ? name : `${name} ${sources.join(" ")}`))
    .join("; ");
}

export function buildDocumentCsp(options: DocumentCspOptions): string {
  return serializeCsp(buildDocumentCspDirectives(options));
}

export function buildAssetCsp(options: CspOptions): string {
  return serializeCsp(buildAssetCspDirectives(options));
}

export const CSP_HEADER = "Content-Security-Policy";

export interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

/**
 * Headers that do not depend on the request. `next.config.ts` puts them on
 * every path (`/:path*`), which includes the responses the proxy handles, so
 * the proxy itself only adds the Content-Security-Policy.
 */
export function buildStaticSecurityHeaders(options: Pick<CspOptions, "isDev">): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value:
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    },
  ];
  if (!options.isDev) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    });
  }
  return headers;
}
