import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/config/env";
import { buildHealthReport } from "./health";

const SECRETS = {
  NODE_ENV: "production",
  VERCEL_GIT_COMMIT_SHA: "abc1234",
  ANTHROPIC_API_KEY: "anthropic-key-value",
  ANTHROPIC_MODEL: "model-override-value",
  REDIS_URL: "rediss://default:redis-password-value@cache.example.test:6379",
  NEXT_PUBLIC_SUPABASE_URL: "https://project-ref-value.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
} as const;

describe("buildHealthReport", () => {
  it("reports the build id and booleans, never a configured value", () => {
    const report = buildHealthReport(parseServerEnv(SECRETS));

    expect(report).toEqual({
      status: "ok",
      buildId: "abc1234",
      features: { explain: true, redis: true, supabase: true },
    });
    const text = JSON.stringify(report);
    for (const value of Object.values(SECRETS).filter((value) => value !== "abc1234")) {
      expect(text).not.toContain(value);
    }
    expect(Object.values(report.features).every((flag) => typeof flag === "boolean")).toBe(true);
  });

  it("reports everything off with an empty environment", () => {
    expect(buildHealthReport(parseServerEnv({}))).toEqual({
      status: "ok",
      buildId: "dev",
      features: { explain: false, redis: false, supabase: false },
    });
  });
});
