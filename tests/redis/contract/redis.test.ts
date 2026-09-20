/**
 * The same contract suite on a real Redis. It runs when whoever started the test
 * run provided REDIS_URL (CI does; locally `docker compose up -d --wait redis` and
 * `REDIS_URL=redis://127.0.0.1:6379 npx vitest run tests/redis`). The network guard
 * of TEST-001 only lets a loopback Redis through.
 *
 * Every key of a run sits under its own `test-<random>` environment segment, and
 * the clean-up deletes that prefix only, so a shared Redis is safe to point at.
 */
import { describe, expect, it } from "vitest";

import { describeRedisContract } from "./contract";
import { createRedisHarness } from "./harness";

const redisUrl = process.env.REDIS_URL?.trim() ?? "";

// Without REDIS_URL there is no Redis to ask (docker compose up -d --wait redis): the run reports
// this suite as skipped, never as passed.
describe.skipIf(redisUrl === "")("Redis layer contract: the real Redis harness", () => {
  it("starts empty, under a key prefix that no other run shares", async () => {
    const createHarness = createRedisHarness(redisUrl);
    const [one, other] = await Promise.all([createHarness(), createHarness()]);
    try {
      expect(await one.liveKeys()).toEqual([]);
      expect(one.keys.prefix).not.toBe(other.keys.prefix);
    } finally {
      await Promise.all([one.dispose(), other.dispose()]);
    }
  });
});

if (redisUrl !== "") describeRedisContract("real Redis", createRedisHarness(redisUrl));
