import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./env";

const PUBLIC_KEYS = [
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

async function loadModule(): Promise<typeof import("./public")> {
  vi.resetModules();
  return import("./public");
}

beforeEach(() => {
  // Hermetic: whatever the developer's shell exports must not leak in.
  for (const key of PUBLIC_KEYS) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPublicConfig", () => {
  it("gives the defaults with nothing set", async () => {
    const { getPublicConfig } = await loadModule();
    expect(getPublicConfig()).toEqual({
      appName: "RLS Leak Tester",
      siteUrl: undefined,
      supabaseUrl: undefined,
      supabaseAnonKey: undefined,
      supabaseEnabled: false,
    });
  });

  it("reads each NEXT_PUBLIC_ variable from the process", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", "Custom Name");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://rls.example.com");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const { getPublicConfig } = await loadModule();
    expect(getPublicConfig()).toEqual({
      appName: "Custom Name",
      siteUrl: "https://rls.example.com",
      supabaseUrl: "https://x.supabase.co",
      supabaseAnonKey: "anon",
      supabaseEnabled: true,
    });
  });

  it("parses once and then serves the cached object", async () => {
    const { getPublicConfig } = await loadModule();
    const first = getPublicConfig();
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", "Changed Later");
    expect(getPublicConfig()).toBe(first);
    expect(getPublicConfig().appName).toBe("RLS Leak Tester");
  });

  it("throws a ConfigError for an invalid value", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not-a-url");
    const { getPublicConfig } = await loadModule();
    expect(() => getPublicConfig()).toThrow(/NEXT_PUBLIC_SITE_URL/);
    expect(() => getPublicConfig()).not.toThrow(/not-a-url/);
  });

  it("does not parse at import time", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not-a-url");
    await expect(loadModule()).resolves.toBeDefined();
    expect(ConfigError.name).toBe("ConfigError");
  });
});
