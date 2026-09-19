/**
 * Public configuration: the `NEXT_PUBLIC_*` variables only. Safe to import from
 * Client Components.
 *
 * Every variable is read as a literal `process.env.NEXT_PUBLIC_X` member
 * expression. Next.js inlines exactly that form into client bundles at build
 * time; a dynamic lookup (`process.env[name]`, destructuring) would be
 * `undefined` in the browser.
 */
import { once, parsePublicEnv, type EnvRecord, type PublicConfig } from "./env";

function readPublicEnv(): EnvRecord {
  return {
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

/** Parsed on first use, then cached. Throws `ConfigError` on an invalid value. */
export const getPublicConfig: () => PublicConfig = once(() => parsePublicEnv(readPublicEnv()));

export type { PublicConfig } from "./env";
