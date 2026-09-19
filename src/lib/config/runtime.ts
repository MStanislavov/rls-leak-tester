/**
 * The edge-safe corner of the configuration: no imports, no zod, no secrets.
 * `src/proxy.ts` uses it, so that rule ARCH-002 ("only `src/lib/config` reads
 * `process.env`") holds there too.
 *
 * `process.env.NODE_ENV` is written as a literal member expression on purpose:
 * Next.js replaces exactly that expression at build time, in every runtime.
 */

/** Pure: true only for the literal value `production`. */
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}

/** Pure: true only for the literal value `development`. */
export function isDevelopmentEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}

/** True under `next build` output and `next start`. */
export function isProduction(): boolean {
  return isProductionEnv(process.env.NODE_ENV);
}

/** True under `next dev` only. Tests (`NODE_ENV=test`) are not development. */
export function isDevelopment(): boolean {
  return isDevelopmentEnv(process.env.NODE_ENV);
}
