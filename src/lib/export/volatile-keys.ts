/**
 * Keys that no second load reproduces. The test file compares LITERAL keys, so a seed that leaves
 * its primary key to `gen_random_uuid()` or `now()` exports a check that can never pass: CI loads
 * the seed again and gets other keys. Pure, so it cannot load the seed twice and compare; it reads
 * what the run already knows instead:
 *
 * - a key column has a default that is not a sequence (`nextval` counts from 1 again on a fresh
 *   database, so serial and identity keys ARE reproducible), and
 * - a value of that column in the ground truth is nowhere in the scenario's SQL. A key the seed
 *   spells out is in its text; a generated one is not.
 *
 * Both together are strong evidence, not proof (a seed may compute explicit keys), so the
 * sentences say "most likely". They are shown before the export (`CiExport.warnings`) and by the
 * seed check of the test file when it fails.
 */
import { parseKey, type CellPlanContext } from "@/lib/runner";
import { commentLine } from "./sql-text";

export interface VolatileKey {
  /** `schema.table`. */
  readonly table: string;
  readonly column: string;
  /** The default expression, on one line and cut to a readable length. */
  readonly expression: string;
}

const REPRODUCIBLE_DEFAULT = /^nextval\(/i;
const EXPRESSION_LENGTH = 80;

function shortened(expression: string): string {
  const line = commentLine(expression);
  return line.length > EXPRESSION_LENGTH ? `${line.slice(0, EXPRESSION_LENGTH)}...` : line;
}

/**
 * The first key column of the table whose seeded values most likely come from a volatile default;
 * `null` when every key is spelled in `sql` or no key column has such a default.
 *
 * @param sql the schema and the seed of the scenario: where an explicit key would be written
 */
export function volatileKeyOf(
  context: Pick<CellPlanContext, "table" | "truth">,
  sql: string,
): VolatileKey | null {
  const { table, truth } = context;
  const haystack = sql.toLowerCase();
  const keys = truth.rows.map((row) => parseKey(row.key));
  for (const [index, name] of truth.primaryKey.entries()) {
    const column = table.columns.find((candidate) => candidate.name === name);
    const expression = column?.default ?? null;
    if (expression === null || REPRODUCIBLE_DEFAULT.test(expression)) {
      continue;
    }
    const unspelled = keys.some((key) => !haystack.includes((key[index] ?? "").toLowerCase()));
    if (unspelled) {
      return {
        table: `${truth.schema}.${truth.name}`,
        column: name,
        expression: shortened(expression),
      };
    }
  }
  return null;
}

/** For the person who is about to export: what will happen, and what to do instead. */
export function volatileKeyWarning(found: VolatileKey): string {
  return `${found.table}: the keys of the seeded rows are not in the seed and the key column ${found.column} defaults to ${found.expression}, so they most likely differ on every load. The exported check would then stop at its preflight on every run. Give the seed explicit keys, run the matrix and export again.`;
}

/** For the failed seed check of the test file: the likely cause, in place of "the seed changed". */
export function volatileKeyAdvice(found: VolatileKey): string {
  return `The key column ${found.column} defaults to ${found.expression} and the seed does not spell the exported keys: they most likely come from that default and differ on every load, so this check cannot pass. Give the seed explicit keys, then run the matrix and export the check again.`;
}
