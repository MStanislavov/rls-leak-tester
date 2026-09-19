/**
 * Next.js calls `register()` once when a server instance starts. Parsing the configuration here
 * turns an invalid environment variable into a failed boot with a `ConfigError` that names the
 * variable (never its value), instead of a failure on the first request that needs it.
 *
 * This file does not read the environment itself (ARCH-002): `src/lib/config` does. The config
 * module needs nothing but zod, so it loads in every runtime `register()` runs in and no runtime
 * guard is needed.
 */
import { getServerConfig } from "@/lib/config/server";

export function register(): void {
  getServerConfig();
}
