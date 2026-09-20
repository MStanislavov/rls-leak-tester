/**
 * The codes `GET /auth/callback` puts into `?auth_error=`, WITHOUT zod: the site header shows a
 * sentence for them on every page, and a header module that imports a schema puts all of zod
 * (about 96 KB gzip) into the script of every route, the landing page included. The callback's
 * own zod enum (`server/auth.ts`) is built from this list, so the two cannot drift.
 */

/** Query parameter a page may read to show a calm notice after a sign-in that did not work. */
export const AUTH_ERROR_PARAM = "auth_error";

export const AUTH_ERROR_CODES = [
  "not_configured",
  "missing_code",
  "provider_error",
  "exchange_failed",
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Pure. The code when `value` is exactly one of the known codes, else `null`. */
export function parseAuthErrorCode(value: unknown): AuthErrorCode | null {
  return AUTH_ERROR_CODES.find((code) => code === value) ?? null;
}
