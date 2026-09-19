/**
 * The route files themselves: thin wiring over `@/lib/ai`. The configuration is mocked so that
 * the environment of whoever runs the tests (a real key, a real Redis) cannot leak in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { explainErrorSchema } from "@/lib/ai/schema";
import { parseServerEnv, type EnvRecord } from "@/lib/config/env";
import { resetRedisServices } from "@/lib/redis";

import { post, validRequest } from "./fixtures";

const env = vi.hoisted((): { current: Record<string, string | undefined> } => ({ current: {} }));

vi.mock("@/lib/config/server", () => ({
  getServerConfig: () => parseServerEnv(env.current as EnvRecord),
}));

afterEach(() => {
  env.current = {};
  resetRedisServices();
});

describe("POST /api/explain", () => {
  it("runs on the Node.js runtime and exports POST only", async () => {
    const route = await import("@/app/api/explain/route");

    expect(route.runtime).toBe("nodejs");
    expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name))).toEqual(["POST"]);
  });

  it("answers the not-configured notice with zero environment variables", async () => {
    const { POST } = await import("@/app/api/explain/route");

    const response = await POST(post(validRequest()));

    expect(response.status).toBe(503);
    expect(explainErrorSchema.parse(await response.json()).error.code).toBe("not_configured");
  });

  it("validates before anything else once it is configured", async () => {
    env.current = { NODE_ENV: "test", ANTHROPIC_API_KEY: "test-key" };
    const { POST } = await import("@/app/api/explain/route");

    const response = await POST(post({ seedSql: "insert into t values (1);" }));

    expect(response.status).toBe(400);
    expect(explainErrorSchema.parse(await response.json()).error.code).toBe("invalid_request");
  });
});

describe("GET /api/health", () => {
  it("returns the build id and booleans only", async () => {
    env.current = {
      ANTHROPIC_API_KEY: "anthropic-key-value",
      REDIS_URL: "redis://:redis-password-value@127.0.0.1:6379",
    };
    const { GET, runtime } = await import("@/app/api/health/route");

    const response = GET();
    const text = await response.text();

    expect(runtime).toBe("nodejs");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({
      status: "ok",
      buildId: "dev",
      features: { explain: true, redis: true, supabase: false },
    });
    expect(text).not.toContain("value");
  });
});

describe("instrumentation", () => {
  it("parses the configuration at boot and fails loudly on an invalid one", async () => {
    const { register } = await import("@/instrumentation");

    expect(() => register()).not.toThrow();
    env.current = { REDIS_URL: "not-a-url" };
    expect(() => register()).toThrow(/REDIS_URL/);
  });
});
