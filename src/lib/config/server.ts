/**
 * Server configuration: every environment variable, secrets included.
 *
 * Never import this module from a Client Component. The `server-only` package
 * is not installed (see docs/adr), so the guard is a runtime one: evaluating
 * this module where a `window` exists throws at once. Even without the guard no
 * secret could reach a browser, because Next.js only inlines `NEXT_PUBLIC_*`.
 *
 * Client code uses `@/lib/config/public`; `src/proxy.ts` uses
 * `@/lib/config/runtime`.
 */
import { once, parseServerEnv, type ServerConfig } from "./env";

/** Throws when `scope` looks like a browser global object. */
export function assertServerRuntime(scope: object = globalThis): void {
  if ("window" in scope) {
    throw new Error(
      "@/lib/config/server was loaded in a browser. Import @/lib/config/public in client code.",
    );
  }
}

assertServerRuntime();

/** Parsed on first use, then cached. Throws `ConfigError` on an invalid value. */
export const getServerConfig: () => ServerConfig = once(() => parseServerEnv(process.env));

export { ConfigError } from "./env";
export type { EnvName, FeatureFlags, NodeEnv, PublicConfig, ServerConfig } from "./env";
