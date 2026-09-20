/**
 * Pure parsing of environment records into typed configuration.
 *
 * Nothing in this file touches `process.env`: every function takes the record
 * as a parameter, so it is unit-testable and safe to import anywhere. The two
 * readers are `server.ts` (every variable, server only) and `public.ts` (the
 * `NEXT_PUBLIC_*` variables, safe for client bundles).
 *
 * Rules: an empty or whitespace-only value counts as unset; an invalid value
 * raises a `ConfigError` that names the variable and never contains the value.
 */
import { z } from "zod";

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export const DEFAULT_APP_NAME = "RLS Leak Tester";
export const DEFAULT_BUILD_ID = "dev";

export type NodeEnv = "development" | "production" | "test";
/** The `{env}` segment of every Redis key: `rlsleak:{env}:{purpose}:{id}`. */
export type EnvName = "production" | "preview" | "development" | "test";

export interface PublicConfig {
  readonly appName: string;
  /** Origin of the deployed site, without a trailing slash. */
  readonly siteUrl: string | undefined;
  /** Supabase project URL, without a trailing slash. */
  readonly supabaseUrl: string | undefined;
  readonly supabaseAnonKey: string | undefined;
  /** True when both the Supabase URL and the anon key are present. */
  readonly supabaseEnabled: boolean;
}

export interface FeatureFlags {
  /** `/api/explain` may run: a key is present and, in production, Redis too. */
  readonly explainEnabled: boolean;
  /** `REDIS_URL` is set; otherwise the in-memory adapters are used. */
  readonly redisEnabled: boolean;
  /** Sign-in and shared scenarios are configured. */
  readonly supabaseEnabled: boolean;
}

export interface ServerConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly envName: EnvName;
  /** `VERCEL_GIT_COMMIT_SHA`, or `dev` outside Vercel. */
  readonly buildId: string;
  readonly anthropicApiKey: string | undefined;
  /** Override only. The default model id lives in `src/lib/ai/model.ts`. */
  readonly anthropicModel: string | undefined;
  readonly redisUrl: string | undefined;
  readonly supabaseServiceRoleKey: string | undefined;
  /** True only when `RUN_LIVE_AI_TESTS` is on and an API key is present. */
  readonly runLiveAiTests: boolean;
  readonly public: PublicConfig;
  readonly features: FeatureFlags;
}

export interface ConfigIssue {
  readonly variable: string;
  readonly problem: string;
}

/** Names the offending variables. By construction it never carries a value. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const lines = issues.map((issue) => `- ${issue.variable}: ${issue.problem}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hasProtocol(value: string, protocols: readonly string[]): boolean {
  const url = parseUrl(value);
  return url !== undefined && protocols.includes(url.protocol) && url.hostname !== "";
}

const HTTP_PROTOCOLS = ["http:", "https:"] as const;
const REDIS_PROTOCOLS = ["redis:", "rediss:"] as const;

const httpUrl = z
  .string()
  .max(2048, { error: "must be at most 2048 characters" })
  .refine((value) => hasProtocol(value, HTTP_PROTOCOLS), {
    error: "must be an absolute http:// or https:// URL",
  })
  // Only reached when the refinement passed, so the constructor cannot throw.
  .transform((value) => new URL(value));

const redisUrl = z
  .string()
  .max(2048, { error: "must be at most 2048 characters" })
  .refine((value) => hasProtocol(value, REDIS_PROTOCOLS), {
    error: "must be a redis:// or rediss:// URL with a host",
  });

const secret = z
  .string()
  .max(4096, { error: "must be at most 4096 characters" })
  .regex(/^\S+$/, { error: "must not contain whitespace" });

const publicSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z
    .string()
    .max(80, { error: "must be at most 80 characters" })
    .default(DEFAULT_APP_NAME),
  NEXT_PUBLIC_SITE_URL: httpUrl.optional(),
  NEXT_PUBLIC_SUPABASE_URL: httpUrl.optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: secret.optional(),
});

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"], {
      error: "must be development, production or test",
    })
    .default("development"),
  VERCEL_ENV: z
    .enum(["production", "preview", "development"], {
      error: "must be production, preview or development",
    })
    .optional(),
  VERCEL_GIT_COMMIT_SHA: z
    .string()
    .regex(/^[0-9A-Za-z._-]{1,64}$/, {
      error: "must be 1 to 64 letters, digits, dots, dashes or underscores",
    })
    .optional(),
  ANTHROPIC_API_KEY: secret.optional(),
  ANTHROPIC_MODEL: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/, {
      error: "must be a model id: letters, digits and . _ : @ / - only, at most 128 characters",
    })
    .optional(),
  REDIS_URL: redisUrl.optional(),
  SUPABASE_SERVICE_ROLE_KEY: secret.optional(),
  RUN_LIVE_AI_TESTS: z
    .enum(["1", "0", "true", "false"], { error: "must be 1, 0, true or false" })
    .optional(),
});

export const PUBLIC_ENV_KEYS = Object.keys(publicSchema.shape);
export const SERVER_ENV_KEYS = Object.keys(serverSchema.shape);

/** Keeps only the named keys, trims them, and turns empty strings into unset. */
export function pickEnv(
  env: EnvRecord,
  keys: readonly string[],
): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = env[key]?.trim();
    picked[key] = value === undefined || value === "" ? undefined : value;
  }
  return picked;
}

/** Maps zod issues to variable names and problems; the input is never copied. */
export function toConfigError(error: z.ZodError): ConfigError {
  return new ConfigError(
    error.issues.map((issue) => ({
      variable: issue.path.map(String).join(".") || "(environment)",
      problem: issue.message,
    })),
  );
}

/** A loop, not `/\/+$/`: that pattern backtracks quadratically on a long run of slashes. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function toPublicConfig(values: z.infer<typeof publicSchema>): PublicConfig {
  const supabaseUrl =
    values.NEXT_PUBLIC_SUPABASE_URL === undefined
      ? undefined
      : stripTrailingSlashes(values.NEXT_PUBLIC_SUPABASE_URL.href);
  const supabaseAnonKey = values.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return Object.freeze({
    appName: values.NEXT_PUBLIC_APP_NAME,
    siteUrl: values.NEXT_PUBLIC_SITE_URL?.origin,
    supabaseUrl,
    supabaseAnonKey,
    supabaseEnabled: supabaseUrl !== undefined && supabaseAnonKey !== undefined,
  });
}

/** Parses the `NEXT_PUBLIC_*` variables. Safe for client and server. */
export function parsePublicEnv(env: EnvRecord): PublicConfig {
  const result = publicSchema.safeParse(pickEnv(env, PUBLIC_ENV_KEYS));
  if (!result.success) {
    throw toConfigError(result.error);
  }
  return toPublicConfig(result.data);
}

/**
 * The Redis key segment. Tests always get `test`; on Vercel the platform's own
 * `VERCEL_ENV` separates `preview` from `production` (both run with
 * `NODE_ENV=production`); everywhere else `NODE_ENV` decides.
 */
export function resolveEnvName(nodeEnv: NodeEnv, vercelEnv: EnvName | undefined): EnvName {
  if (nodeEnv === "test") {
    return "test";
  }
  if (vercelEnv !== undefined) {
    return vercelEnv;
  }
  return nodeEnv === "production" ? "production" : "development";
}

export interface FeatureInputs {
  readonly isProduction: boolean;
  readonly hasAnthropicKey: boolean;
  readonly hasRedisUrl: boolean;
  readonly supabaseEnabled: boolean;
}

/**
 * Section 4.5: an unmetered model endpoint is a cost risk, so in production
 * `/api/explain` stays off unless Redis is configured for the rate limiter.
 */
export function deriveFeatureFlags(inputs: FeatureInputs): FeatureFlags {
  return Object.freeze({
    explainEnabled: inputs.hasAnthropicKey && (!inputs.isProduction || inputs.hasRedisUrl),
    redisEnabled: inputs.hasRedisUrl,
    supabaseEnabled: inputs.supabaseEnabled,
  });
}

/** Parses every variable. The result holds secrets: server only. */
export function parseServerEnv(env: EnvRecord): ServerConfig {
  const publicResult = publicSchema.safeParse(pickEnv(env, PUBLIC_ENV_KEYS));
  const serverResult = serverSchema.safeParse(pickEnv(env, SERVER_ENV_KEYS));
  if (!publicResult.success || !serverResult.success) {
    // Report every problem at once, from both halves.
    throw new ConfigError([
      ...(publicResult.success ? [] : toConfigError(publicResult.error).issues),
      ...(serverResult.success ? [] : toConfigError(serverResult.error).issues),
    ]);
  }

  const values = serverResult.data;
  const publicConfig = toPublicConfig(publicResult.data);
  const isProduction = values.NODE_ENV === "production";
  const liveFlag = values.RUN_LIVE_AI_TESTS === "1" || values.RUN_LIVE_AI_TESTS === "true";

  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    isProduction,
    envName: resolveEnvName(values.NODE_ENV, values.VERCEL_ENV),
    buildId: values.VERCEL_GIT_COMMIT_SHA ?? DEFAULT_BUILD_ID,
    anthropicApiKey: values.ANTHROPIC_API_KEY,
    anthropicModel: values.ANTHROPIC_MODEL,
    redisUrl: values.REDIS_URL,
    supabaseServiceRoleKey: values.SUPABASE_SERVICE_ROLE_KEY,
    runLiveAiTests: liveFlag && values.ANTHROPIC_API_KEY !== undefined,
    public: publicConfig,
    features: deriveFeatureFlags({
      isProduction,
      hasAnthropicKey: values.ANTHROPIC_API_KEY !== undefined,
      hasRedisUrl: values.REDIS_URL !== undefined,
      supabaseEnabled: publicConfig.supabaseEnabled,
    }),
  });
}

/** Runs `produce` on first use and keeps the result. A throw is not cached. */
export function once<T>(produce: () => T): () => T {
  let cached: { readonly value: T } | undefined;
  return () => {
    cached ??= { value: produce() };
    return cached.value;
  };
}
