/**
 * rules.yaml is the one home of the runner's numbers (CLAUDE.md, "Numbers are not scattered").
 * The worker client carries the probe timeout as a constant because a pure browser module cannot
 * read a YAML file; this test is what keeps the two from drifting apart.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_EXEC_TIMEOUT_MS } from "@/lib/engine/worker/client";

const Rules = z.object({
  thresholds: z.object({
    runner: z.object({ probe_timeout_ms: z.number(), run_ceiling_ms: z.number() }),
  }),
});

describe("engine thresholds", () => {
  it("uses the probe timeout of rules.yaml as the default timeout of every engine call", () => {
    const path = fileURLToPath(new URL("../../rules.yaml", import.meta.url));
    const rules = Rules.parse(parse(readFileSync(path, "utf8")));
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(rules.thresholds.runner.probe_timeout_ms);
    expect(rules.thresholds.runner.run_ceiling_ms).toBeGreaterThan(DEFAULT_EXEC_TIMEOUT_MS);
  });
});
