/**
 * The same contract suite on a real Redis. It runs when whoever started the test
 * run provided REDIS_URL (CI does; locally `docker compose up -d --wait redis` and
 * `REDIS_URL=redis://127.0.0.1:6379 npx vitest run tests/redis`). The network guard
 * of TEST-001 only lets a loopback Redis through.
 *
 * Every key of a run sits under its own `test-<random>` environment segment, and
 * the clean-up deletes that prefix only, so a shared Redis is safe to point at.
 */
import { describe, it } from "vitest";

import { describeRedisContract } from "./contract";
import { createRedisHarness } from "./harness";

const redisUrl = process.env.REDIS_URL?.trim() ?? "";

if (redisUrl === "") {
  describe("Redis layer contract: real Redis", () => {
    it.skip("needs REDIS_URL (docker compose up -d --wait redis)", () => undefined);
  });
} else {
  describeRedisContract("real Redis", createRedisHarness(redisUrl));
}
