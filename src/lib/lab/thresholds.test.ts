import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_EXEC_TIMEOUT_MS } from "@/lib/engine/worker/client";
import { PROBE_TIMEOUT_MS, RUN_CEILING_MS } from "./thresholds";

const Rules = z.object({
  thresholds: z.object({
    runner: z.object({ probe_timeout_ms: z.number(), run_ceiling_ms: z.number() }),
  }),
});

describe("lab thresholds", () => {
  const path = fileURLToPath(new URL("../../../rules.yaml", import.meta.url));
  const rules = Rules.parse(parse(readFileSync(path, "utf8")));

  it("takes the probe timeout from rules.yaml, the same one the worker client uses", () => {
    expect(PROBE_TIMEOUT_MS).toBe(rules.thresholds.runner.probe_timeout_ms);
    expect(PROBE_TIMEOUT_MS).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  it("takes the run ceiling from rules.yaml", () => {
    expect(RUN_CEILING_MS).toBe(rules.thresholds.runner.run_ceiling_ms);
  });
});
