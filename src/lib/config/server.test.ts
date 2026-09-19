import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_ENV_KEYS, SERVER_ENV_KEYS } from "./env";

async function loadModule(): Promise<typeof import("./server")> {
  vi.resetModules();
  return import("./server");
}

beforeEach(() => {
  // Hermetic: whatever the developer's shell exports must not leak in.
  for (const key of [...PUBLIC_ENV_KEYS, ...SERVER_ENV_KEYS]) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getServerConfig", () => {
  it("gives a working default with nothing set", async () => {
    const { getServerConfig } = await loadModule();
    expect(getServerConfig()).toMatchObject({
      nodeEnv: "development",
      envName: "development",
      buildId: "dev",
      features: { explainEnabled: false, redisEnabled: false, supabaseEnabled: false },
    });
  });

  it("reads the process environment", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ANTHROPIC_API_KEY", "key");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234");
    const { getServerConfig } = await loadModule();
    expect(getServerConfig()).toMatchObject({
      nodeEnv: "test",
      envName: "test",
      buildId: "abc1234",
      anthropicApiKey: "key",
      redisUrl: "redis://localhost:6379",
      features: { explainEnabled: true, redisEnabled: true },
    });
  });

  it("parses once and then serves the cached object", async () => {
    const { getServerConfig } = await loadModule();
    const first = getServerConfig();
    vi.stubEnv("ANTHROPIC_API_KEY", "set-later");
    expect(getServerConfig()).toBe(first);
    expect(getServerConfig().anthropicApiKey).toBeUndefined();
  });

  it("throws a ConfigError that names the variable and hides the value", async () => {
    // Assembled at run time, so no credential-shaped literal sits in the repository (SEC-003).
    vi.stubEnv("REDIS_URL", ["https://user", "hunter2@cache.example.com"].join(":"));
    const { getServerConfig, ConfigError } = await loadModule();
    expect(() => getServerConfig()).toThrow(ConfigError);
    expect(() => getServerConfig()).toThrow(/REDIS_URL/);
    expect(() => getServerConfig()).not.toThrow(/hunter2/);
  });
});

describe("assertServerRuntime", () => {
  it("accepts a server global object", async () => {
    const { assertServerRuntime } = await loadModule();
    expect(() => assertServerRuntime()).not.toThrow();
    expect(() => assertServerRuntime({})).not.toThrow();
  });

  it("rejects a browser global object", async () => {
    const { assertServerRuntime } = await loadModule();
    expect(() => assertServerRuntime({ window: {} })).toThrow(/@\/lib\/config\/public/);
  });

  it("refuses to load at all where a window exists", async () => {
    vi.stubGlobal("window", {});
    await expect(loadModule()).rejects.toThrow(/loaded in a browser/);
  });
});
