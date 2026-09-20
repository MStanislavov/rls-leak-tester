/**
 * The one place where a `StoreError` becomes an HTTP answer, and the small readers a handler
 * needs around a `Request` (SEC-002: header values are parsed with zod before use).
 */
import { z } from "zod";

import { StoreError, type StoreErrorCode } from "../types";
import type { StoreErrorBody } from "../wire";

/** Codes that only ever exist in the browser still need a status: they would be a server bug. */
const STATUS_BY_CODE: Readonly<Record<StoreErrorCode, number>> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  too_large: 413,
  corrupt: 422,
  rate_limited: 429,
  not_configured: 503,
  unavailable: 503,
  quota_exceeded: 500,
  storage_unavailable: 500,
  network: 500,
  invalid_response: 500,
};

export function statusOfStoreError(code: StoreErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** The limits of `storeErrorBodySchema`: an answer this server sends always parses. */
const MAX_ISSUES = 50;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function emptyResponse(status: 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...NO_STORE, ...headers } });
}

/** The JSON error answer of a `StoreError`. The cause never leaves the server. */
export function storeErrorResponse(
  error: StoreError,
  headers: Record<string, string> = {},
): Response {
  const body: StoreErrorBody = {
    error:
      error.issues.length === 0
        ? { code: error.code, message: error.message }
        : {
            code: error.code,
            message: error.message,
            issues: error.issues.slice(0, MAX_ISSUES).map((issue) => ({
              path: issue.path.slice(0, 300),
              message: issue.message.slice(0, 500),
            })),
          },
  };
  const retryAfter: Record<string, string> =
    error.retryAfterSeconds === undefined ? {} : { "Retry-After": String(error.retryAfterSeconds) };
  return jsonResponse(body, statusOfStoreError(error.code), { ...retryAfter, ...headers });
}

export const NOT_CONFIGURED_MESSAGE =
  "Sharing is not configured on this deployment (no Supabase project). Scenarios are still saved in this browser, and everything else works without it.";

export function notConfiguredError(): StoreError {
  return new StoreError("not_configured", NOT_CONFIGURED_MESSAGE);
}

const fetchSiteSchema = z.enum(["same-origin", "same-site", "cross-site", "none"]);

/**
 * True when the browser says the request was started by another site. Browsers set
 * `Sec-Fetch-Site` themselves and a page cannot forge it; a client without the header (curl, a
 * test) is not a browser acting for a victim. The session cookie is `SameSite=Lax` and a JSON
 * body needs a preflight, so this is a third barrier, not the only one.
 */
export function isCrossSiteRequest(headers: Headers): boolean {
  const parsed = fetchSiteSchema.safeParse(headers.get("sec-fetch-site") ?? undefined);
  return parsed.success && parsed.data === "cross-site";
}
