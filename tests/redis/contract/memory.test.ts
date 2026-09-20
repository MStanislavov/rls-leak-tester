/** The contract suite on the in-memory adapters. Hermetic: it runs on every `npm test`. */
import { describe, expect, it } from "vitest";

import { describeRedisContract } from "./contract";
import { createMemoryHarness } from "./harness";

describe("Redis layer contract: the in-memory harness", () => {
  it("starts empty, under a key prefix that no other run shares", async () => {
    const [one, other] = await Promise.all([createMemoryHarness(), createMemoryHarness()]);

    expect(await one.liveKeys()).toEqual([]);
    expect(one.keys.prefix).not.toBe(other.keys.prefix);
  });
});

describeRedisContract("in-memory adapters", createMemoryHarness);
