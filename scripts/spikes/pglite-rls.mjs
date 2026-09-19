#!/usr/bin/env node
/**
 * Spike A, "RLS inside PGlite", as a plain Node script.
 *
 *   node scripts/spikes/pglite-rls.mjs
 *
 * Prints one PASS/FAIL line per claim, the evidence behind it, and exits non-zero when any claim
 * fails. The claims themselves live in tests/spikes/pglite-rls.claims.mts, which the Vitest suite
 * tests/spikes/pglite-rls.test.ts runs as well, so the script and the regression test can never
 * disagree. Both TypeScript files are loaded through Node's built-in type stripping (Node 22.18
 * or newer; the project requires 22.22.2).
 *
 * Node prints one MODULE_TYPELESS_PACKAGE_JSON warning on stderr for supabase-shim.ts, because
 * package.json does not say "type": "module". It is harmless.
 */
import { PGlite } from "@electric-sql/pglite";

import { SUPABASE_SHIM_SQL, supabaseDefaultGrantsSql } from "../../src/lib/engine/supabase-shim.ts";
import { claims } from "../../tests/spikes/pglite-rls.claims.mts";

const context = { shimSql: SUPABASE_SHIM_SQL, defaultGrantsSql: supabaseDefaultGrantsSql };

async function describeEngine() {
  const db = new PGlite();
  try {
    await db.waitReady;
    const result = await db.query("select version() as version");
    return result.rows[0]?.version ?? "unknown";
  } finally {
    await db.close();
  }
}

function describeFailure(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = typeof error.code === "string" ? ` [${error.code}]` : "";
  return `${error.name}${code}: ${error.message}`;
}

console.log(`Spike A: RLS inside PGlite, Node ${process.version}`);
console.log(await describeEngine());
console.log("");

let failures = 0;
const startedAt = performance.now();

for (const claim of claims) {
  const claimStartedAt = performance.now();
  try {
    const evidence = await claim.run(context);
    const took = (performance.now() - claimStartedAt).toFixed(0);
    console.log(`PASS  claim ${claim.id}: ${claim.title} (${took} ms)`);
    console.log(`      ${evidence}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  claim ${claim.id}: ${claim.title}`);
    console.log(`      ${describeFailure(error).replaceAll("\n", "\n      ")}`);
  }
}

const total = ((performance.now() - startedAt) / 1000).toFixed(1);
console.log("");
console.log(
  failures === 0
    ? `All ${claims.length} claims hold (${total} s).`
    : `${failures} of ${claims.length} claims FAILED (${total} s).`,
);

process.exit(failures === 0 ? 0 : 1);
