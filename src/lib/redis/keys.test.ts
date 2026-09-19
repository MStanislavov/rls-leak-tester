import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assertKeyPrefix, createKeyBuilder, safeKeyId } from "./keys";

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

describe("createKeyBuilder", () => {
  const keys = createKeyBuilder("production");

  it("builds rlsleak:{env}:{purpose}:{id}", () => {
    const hash = "a".repeat(64);
    expect(keys.env).toBe("production");
    expect(keys.prefix).toBe("rlsleak:production:");
    expect(keys.explanation(hash)).toBe(`rlsleak:production:explain:${hash}`);
    expect(keys.explanationLock(hash)).toBe(`rlsleak:production:lock:${hash}`);
    expect(keys.scenario("my-slug_1")).toBe("rlsleak:production:scenario:my-slug_1");
    expect(keys.build("scenario", "abc")).toBe("rlsleak:production:scenario:abc");
  });

  it("separates environments", () => {
    const preview = createKeyBuilder("preview");
    expect(preview.scenario("s")).toBe("rlsleak:preview:scenario:s");
    expect(preview.owns(keys.scenario("s"))).toBe(false);
    expect(keys.owns(keys.scenario("s"))).toBe(true);
    expect(keys.owns("rlsleak:production-2:scenario:s")).toBe(false);
  });

  it("always hashes a rate-limit subject and keeps scope and kind readable", () => {
    const key = keys.rateLimit("explain", "ip", "203.0.113.7");
    expect(key).toBe(
      `rlsleak:production:ratelimit:explain.ip.${sha256("203.0.113.7").slice(0, 32)}`,
    );
    expect(key).not.toContain("203.0.113.7");
    expect(keys.rateLimit("scenario-writes", "user", "u1")).toMatch(
      /^rlsleak:production:ratelimit:scenario-writes\.user\.[0-9a-f]{32}$/,
    );
    expect(keys.rateLimit("explain", "ip", "x")).not.toBe(keys.rateLimit("explain", "user", "x"));
  });

  it.each([
    "a:b",
    "rlsleak:production:lock:x",
    "slug with spaces",
    "*",
    "{tag}",
    "new\nline",
    "",
    "é",
    "a.b",
    "x".repeat(65),
  ])("never lets the id %j add structure to a key", (hostile) => {
    for (const key of [
      keys.scenario(hostile),
      keys.explanation(hostile),
      keys.explanationLock(hostile),
      keys.build("ratelimit", hostile),
      keys.rateLimit("explain", "ip", hostile),
    ]) {
      expect(key.split(":")).toHaveLength(4);
      expect(key).toMatch(/^rlsleak:production:[a-z]+:[A-Za-z0-9_.-]{1,100}$/);
    }
    expect(keys.scenario(hostile)).toBe(`rlsleak:production:scenario:h.${sha256(hostile)}`);
  });

  it("cannot make a hashed id collide with a plain one", () => {
    const hostile = "a:b";
    const digestAsSlug = sha256(hostile);
    expect(keys.scenario(digestAsSlug)).not.toBe(keys.scenario(hostile));
    expect(safeKeyId(`h.${digestAsSlug}`)).not.toBe(safeKeyId(hostile));
  });

  it.each(["", "Production", "a:b", "-x", "x".repeat(41), "a b", "prod*"])(
    "refuses the env segment %j",
    (env) => {
      expect(() => createKeyBuilder(env)).toThrow(RangeError);
    },
  );

  it.each(["production", "preview", "development", "test", "test-0a1b2c3d4e5f"])(
    "accepts the env segment %j",
    (env) => {
      expect(createKeyBuilder(env).prefix).toBe(`rlsleak:${env}:`);
    },
  );
});

describe("assertKeyPrefix", () => {
  it("passes a key of the prefix and throws for any other", () => {
    expect(() => {
      assertKeyPrefix("rlsleak:test:", "rlsleak:test:lock:x");
    }).not.toThrow();
    expect(() => {
      assertKeyPrefix("rlsleak:test:", "rlsleak:production:lock:x");
    }).toThrow(RangeError);
    expect(() => {
      assertKeyPrefix("rlsleak:test:", "lock:x");
    }).toThrow(RangeError);
  });
});
