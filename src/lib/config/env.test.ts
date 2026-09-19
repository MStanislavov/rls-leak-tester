import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ConfigError,
  DEFAULT_APP_NAME,
  DEFAULT_BUILD_ID,
  deriveFeatureFlags,
  once,
  parsePublicEnv,
  parseServerEnv,
  pickEnv,
  PUBLIC_ENV_KEYS,
  resolveEnvName,
  SERVER_ENV_KEYS,
  toConfigError,
  type EnvRecord,
} from "./env";

const FIXTURE_PASSWORD = "fixture-password";

/** Assembled at run time, so no credential-shaped literal sits in the repository (SEC-003). */
function urlWithPassword(scheme: string, user: string, host: string): string {
  return `${scheme}://${user}:${FIXTURE_PASSWORD}@${host}`;
}

const SECRET_REDIS_URL = urlWithPassword("rediss", "default", "eu1-example.upstash.io:6379");

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConfigError, but nothing was thrown");
}

describe("pickEnv", () => {
  it("keeps only the named keys", () => {
    expect(pickEnv({ A: "1", B: "2" }, ["A"])).toEqual({ A: "1" });
  });

  it("treats empty and whitespace-only values as unset and trims the rest", () => {
    expect(pickEnv({ A: "", B: "   ", C: "  x  " }, ["A", "B", "C", "D"])).toEqual({
      A: undefined,
      B: undefined,
      C: "x",
      D: undefined,
    });
  });
});

describe("parsePublicEnv", () => {
  it("gives the defaults for an empty environment", () => {
    expect(parsePublicEnv({})).toEqual({
      appName: DEFAULT_APP_NAME,
      siteUrl: undefined,
      supabaseUrl: undefined,
      supabaseAnonKey: undefined,
      supabaseEnabled: false,
    });
  });

  it("treats every empty string as unset, exactly like .env.example", () => {
    const env = Object.fromEntries(PUBLIC_ENV_KEYS.map((key) => [key, ""]));
    expect(parsePublicEnv(env)).toEqual(parsePublicEnv({}));
  });

  it("reads the app name and normalises the URLs", () => {
    const config = parsePublicEnv({
      NEXT_PUBLIC_APP_NAME: "  My Lab ",
      NEXT_PUBLIC_SITE_URL: "https://rls.example.com/some/path/",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321//",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon.key.value",
    });
    expect(config).toEqual({
      appName: "My Lab",
      siteUrl: "https://rls.example.com",
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseAnonKey: "anon.key.value",
      supabaseEnabled: true,
    });
  });

  it("keeps a path on the Supabase URL", () => {
    const config = parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://db.example.com/proxy/" });
    expect(config.supabaseUrl).toBe("https://db.example.com/proxy");
  });

  it.each([
    ["only the URL", { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" }],
    ["only the key", { NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }],
  ])("keeps Supabase off with %s", (_label, env: EnvRecord) => {
    expect(parsePublicEnv(env).supabaseEnabled).toBe(false);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(parsePublicEnv({}))).toBe(true);
  });

  it.each([
    ["NEXT_PUBLIC_SITE_URL", "not a url"],
    ["NEXT_PUBLIC_SITE_URL", "ftp://example.com"],
    ["NEXT_PUBLIC_SITE_URL", "example.com"],
    ["NEXT_PUBLIC_SUPABASE_URL", "javascript:alert(1)"],
    ["NEXT_PUBLIC_SUPABASE_URL", `https://${"a".repeat(2050)}.example.com`],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "two words"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "k".repeat(4097)],
    ["NEXT_PUBLIC_APP_NAME", "n".repeat(81)],
  ])("rejects %s and names it without echoing the value", (variable, value) => {
    const error = captureConfigError(() => parsePublicEnv({ [variable]: value }));
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
    expect(error.message).toContain(variable);
    expect(error.message).not.toContain(value);
    expect(JSON.stringify(error.issues)).not.toContain(value);
  });
});

describe("parseServerEnv", () => {
  it("gives a fully working default for an empty environment", () => {
    expect(parseServerEnv({})).toEqual({
      nodeEnv: "development",
      isProduction: false,
      envName: "development",
      buildId: DEFAULT_BUILD_ID,
      anthropicApiKey: undefined,
      anthropicModel: undefined,
      redisUrl: undefined,
      supabaseServiceRoleKey: undefined,
      runLiveAiTests: false,
      public: parsePublicEnv({}),
      features: { explainEnabled: false, redisEnabled: false, supabaseEnabled: false },
    });
  });

  it("treats every empty string as unset, exactly like .env.example", () => {
    const keys = [...PUBLIC_ENV_KEYS, ...SERVER_ENV_KEYS];
    const env = Object.fromEntries(keys.map((key) => [key, ""]));
    expect(parseServerEnv(env)).toEqual(parseServerEnv({}));
  });

  it("reads every variable", () => {
    const config = parseServerEnv({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "0123abc",
      ANTHROPIC_API_KEY: "key-value",
      ANTHROPIC_MODEL: "some-model-1",
      REDIS_URL: SECRET_REDIS_URL,
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      RUN_LIVE_AI_TESTS: "1",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      UNRELATED: "ignored",
    });
    expect(config).toMatchObject({
      nodeEnv: "production",
      isProduction: true,
      envName: "preview",
      buildId: "0123abc",
      anthropicApiKey: "key-value",
      anthropicModel: "some-model-1",
      redisUrl: SECRET_REDIS_URL,
      supabaseServiceRoleKey: "service-role",
      runLiveAiTests: true,
      features: { explainEnabled: true, redisEnabled: true, supabaseEnabled: true },
    });
    expect(config.public.supabaseEnabled).toBe(true);
    expect(Object.keys(config)).not.toContain("UNRELATED");
  });

  it("returns frozen objects", () => {
    const config = parseServerEnv({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.features)).toBe(true);
    expect(Object.isFrozen(config.public)).toBe(true);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
  ])("RUN_LIVE_AI_TESTS=%s with a key gives %s", (flag, expected) => {
    const config = parseServerEnv({ RUN_LIVE_AI_TESTS: flag, ANTHROPIC_API_KEY: "key" });
    expect(config.runLiveAiTests).toBe(expected);
  });

  it("never runs live AI tests without an API key", () => {
    expect(parseServerEnv({ RUN_LIVE_AI_TESTS: "1" }).runLiveAiTests).toBe(false);
  });

  it("refuses to enable explain in production without Redis", () => {
    const env = { NODE_ENV: "production", ANTHROPIC_API_KEY: "key" };
    expect(parseServerEnv(env).features.explainEnabled).toBe(false);
    expect(parseServerEnv({ ...env, REDIS_URL: "redis://cache:6379" }).features).toMatchObject({
      explainEnabled: true,
      redisEnabled: true,
    });
  });

  it("enables explain in development with a key alone", () => {
    const config = parseServerEnv({ NODE_ENV: "development", ANTHROPIC_API_KEY: "key" });
    expect(config.features).toMatchObject({ explainEnabled: true, redisEnabled: false });
  });

  it.each([
    "redis://localhost:6379",
    urlWithPassword("redis", "", "127.0.0.1:6379/0"),
    SECRET_REDIS_URL,
  ])("accepts the Redis URL form %#", (url) => {
    expect(parseServerEnv({ REDIS_URL: url }).redisUrl).toBe(url);
  });

  it.each([
    ["REDIS_URL", urlWithPassword("http", "user", "cache.example.com")],
    ["REDIS_URL", "localhost:6379"],
    ["REDIS_URL", "redis:///0"],
    ["REDIS_URL", `redis://${"h".repeat(2050)}`],
    ["NODE_ENV", "staging"],
    ["VERCEL_ENV", "qa"],
    ["VERCEL_GIT_COMMIT_SHA", "<script>"],
    ["ANTHROPIC_API_KEY", "key with spaces"],
    ["ANTHROPIC_MODEL", "model id with spaces"],
    ["SUPABASE_SERVICE_ROLE_KEY", "line\nbreak"],
    ["RUN_LIVE_AI_TESTS", "yes"],
  ])("rejects %s and names it without echoing the value", (variable, value) => {
    const error = captureConfigError(() => parseServerEnv({ [variable]: value }));
    expect(error.name).toBe("ConfigError");
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
    expect(error.message).toContain(`- ${variable}: `);
    expect(error.message).not.toContain(value);
    expect(JSON.stringify(error.issues)).not.toContain(value);
  });

  it("never leaks a password from a rejected URL", () => {
    const error = captureConfigError(() =>
      parseServerEnv({ REDIS_URL: urlWithPassword("https", "default", "cache.example.com") }),
    );
    expect(error.message).not.toContain(FIXTURE_PASSWORD);
    expect(JSON.stringify(error)).not.toContain(FIXTURE_PASSWORD);
    expect(String(error.stack)).not.toContain(FIXTURE_PASSWORD);
  });

  it("reports public and server problems together", () => {
    const error = captureConfigError(() =>
      parseServerEnv({ NEXT_PUBLIC_SITE_URL: "nope", REDIS_URL: "nope", NODE_ENV: "nope" }),
    );
    expect(error.issues.map((issue) => issue.variable)).toEqual([
      "NEXT_PUBLIC_SITE_URL",
      "NODE_ENV",
      "REDIS_URL",
    ]);
  });

  it("reports a public problem when the server half is valid, and the reverse", () => {
    const publicOnly = captureConfigError(() => parseServerEnv({ NEXT_PUBLIC_SITE_URL: "nope" }));
    expect(publicOnly.issues).toHaveLength(1);
    const serverOnly = captureConfigError(() => parseServerEnv({ REDIS_URL: "nope" }));
    expect(serverOnly.issues).toHaveLength(1);
  });
});

describe("toConfigError", () => {
  it("falls back to a generic name for an issue without a path", () => {
    const result = z.string().safeParse(42);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toConfigError(result.error).issues[0]?.variable).toBe("(environment)");
    }
  });

  it("joins nested paths", () => {
    const result = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toConfigError(result.error).issues[0]?.variable).toBe("a.b");
    }
  });
});

describe("resolveEnvName", () => {
  it.each([
    ["test", undefined, "test"],
    ["test", "production", "test"],
    ["production", undefined, "production"],
    ["production", "preview", "preview"],
    ["production", "production", "production"],
    ["development", undefined, "development"],
    ["development", "development", "development"],
  ] as const)("NODE_ENV=%s with VERCEL_ENV=%s gives %s", (nodeEnv, vercelEnv, expected) => {
    expect(resolveEnvName(nodeEnv, vercelEnv)).toBe(expected);
  });
});

describe("deriveFeatureFlags", () => {
  const base = {
    isProduction: false,
    hasAnthropicKey: false,
    hasRedisUrl: false,
    supabaseEnabled: false,
  };

  it.each([
    [{ ...base }, false],
    [{ ...base, hasAnthropicKey: true }, true],
    [{ ...base, hasRedisUrl: true }, false],
    [{ ...base, isProduction: true, hasAnthropicKey: true }, false],
    [{ ...base, isProduction: true, hasRedisUrl: true }, false],
    [{ ...base, isProduction: true, hasAnthropicKey: true, hasRedisUrl: true }, true],
  ])("explainEnabled for %o is %s", (inputs, expected) => {
    expect(deriveFeatureFlags(inputs).explainEnabled).toBe(expected);
  });

  it("passes the Redis and Supabase flags through", () => {
    expect(deriveFeatureFlags({ ...base, hasRedisUrl: true, supabaseEnabled: true })).toEqual({
      explainEnabled: false,
      redisEnabled: true,
      supabaseEnabled: true,
    });
  });
});

describe("once", () => {
  it("produces the value a single time, even when it is undefined", () => {
    const produce = vi.fn(() => undefined);
    const get = once(produce);
    expect(get()).toBeUndefined();
    expect(get()).toBeUndefined();
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure", () => {
    let calls = 0;
    const get = once(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error("first call fails");
      }
      return calls;
    });
    expect(() => get()).toThrow("first call fails");
    expect(get()).toBe(2);
    expect(get()).toBe(2);
  });
});
