import { afterEach, describe, expect, it, vi } from "vitest";
import { isDevelopment, isDevelopmentEnv, isProduction, isProductionEnv } from "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pure predicates", () => {
  it.each([
    ["production", true, false],
    ["development", false, true],
    ["test", false, false],
    ["", false, false],
    [undefined, false, false],
  ])("NODE_ENV=%s: production %s, development %s", (nodeEnv, production, development) => {
    expect(isProductionEnv(nodeEnv)).toBe(production);
    expect(isDevelopmentEnv(nodeEnv)).toBe(development);
  });
});

describe("process readers", () => {
  it("sees production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isProduction()).toBe(true);
    expect(isDevelopment()).toBe(false);
  });

  it("sees development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isProduction()).toBe(false);
    expect(isDevelopment()).toBe(true);
  });

  it("treats the test environment as neither, so the strict CSP applies", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(isProduction()).toBe(false);
    expect(isDevelopment()).toBe(false);
  });
});
