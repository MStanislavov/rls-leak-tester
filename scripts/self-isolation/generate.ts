/**
 * Writes the self-isolation proof for the CI job (brief 5.3). Not a test:
 *
 *   npx tsx scripts/self-isolation/generate.ts <directory>
 *
 * The directory then holds rls-isolation.setup.sql, rls-isolation.seed.sql and
 * rls-isolation.test.sql. The job loads, each with `psql -v ON_ERROR_STOP=1` and PGTZ=UTC:
 * the setup file, every file of supabase/migrations in name order, the seed, the test file.
 * `scripts/self-isolation/verify-postgres.sh` does exactly that against Postgres in Docker.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSelfProof } from "./self-proof";

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (directory === undefined || directory === "") {
    throw new Error("Usage: npx tsx scripts/self-isolation/generate.ts <directory>");
  }
  const proof = await buildSelfProof();
  mkdirSync(directory, { recursive: true });
  for (const file of proof.files) {
    writeFileSync(path.join(directory, file.name), file.content);
  }
  const { result } = proof.matrix;
  console.log(
    `${proof.scenario.id}: ${result.verdict} on PGlite, ${proof.ciExport.checkedCells} cells exported to ${directory}`,
  );
  for (const file of proof.files) {
    console.log(`  ${file.name} (${file.content.length} characters)`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
