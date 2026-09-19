/**
 * Spike A, "RLS inside PGlite", kept as a permanent regression test: if a PGlite upgrade changes
 * any behaviour the matrix runner relies on, this suite says so before a verdict can go wrong.
 *
 * The claims are defined once in pglite-rls.claims.mts and shared with the Node script
 * scripts/spikes/pglite-rls.mjs. Findings: docs/adr/0002-spike-a-pglite-rls.md.
 */
import { describe, expect, it } from "vitest";

import { SUPABASE_SHIM_SQL, supabaseDefaultGrantsSql } from "@/lib/engine/supabase-shim";

import { claims, type SpikeContext } from "./pglite-rls.claims.mjs";

const context: SpikeContext = {
  shimSql: SUPABASE_SHIM_SQL,
  defaultGrantsSql: supabaseDefaultGrantsSql,
};

describe("Spike A: RLS inside PGlite", () => {
  it("covers all ten claims of the brief", () => {
    const covered = new Set(claims.map((claim) => claim.id.replace(/[a-z]$/, "")));
    expect([...covered]).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  for (const claim of claims) {
    it(`claim ${claim.id}: ${claim.title}`, { timeout: 60_000 }, async () => {
      const evidence = await claim.run(context);
      expect(evidence).not.toBe("");
    });
  }
});
