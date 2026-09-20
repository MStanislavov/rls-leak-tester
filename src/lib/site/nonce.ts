/**
 * The `x-nonce` request header is set by `src/proxy.ts`, but a header is external input all the
 * same (SEC-002): the root layout hands the value to `next-themes`, which writes it into a
 * `nonce=""` attribute. Only the shape `generateNonce()` produces is let through.
 */
const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{16,128}={0,2}$/;

/** The nonce when it looks like one, otherwise `undefined` (the theme script then gets none). */
export function parseNonce(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return NONCE_PATTERN.test(value) ? value : undefined;
}
