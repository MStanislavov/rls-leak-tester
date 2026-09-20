---
name: debug-probe
description: Use when one matrix cell disagrees with what was expected - a golden, template, runner or export test is red, a cell shows leak, escape, overblock or inconclusive that nobody can explain, PGlite and real Postgres differ - and before touching any expectation, declared failure or snapshot.
---

# Debug one probe

Reproduce the cell by hand, then decide who is wrong: the policy, the expectation or the runner.
Never edit an expectation, `expectedFailures` or a snapshot to get green (QUAL-002, FA-6).
`tests/golden/replay.golden.test.ts` is this method, automated.

## Reproduce

`cell.sql` is the transcript the runner sent: `begin`, `select set_config('role', ..., true)`, the
claims, pinned settings, a whoami, the probe, `rollback` (RUN-001). Save as `probe.ts` outside the
repository; run it from the root so `@/` resolves:

```ts
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { runMatrix } from "@/lib/runner";
import { setupDatabase } from "@/lib/runner/setup";
import { splitSqlStatements } from "@/lib/scenario";
import { findTemplateVariant } from "@/lib/scenario/templates";

async function main(): Promise<void> {
  const scenario = findTemplateVariant("todos-sharing-leaky")?.scenario;
  if (scenario === undefined) throw new Error("unknown scenario");
  const options = { createEngine: () => createPgliteEngine(), supabase: SUPABASE_SETUP_SQL };
  const { result } = await runMatrix(scenario, options);
  const cell = result.cells.find((c) => c.id === "alice|public.todos|select");
  if (cell === undefined) throw new Error("unknown cell");
  console.log(cell.status, cell.expectedKeys, cell.actualKeys, cell.error);
  const engine = await createPgliteEngine();
  await setupDatabase(engine, scenario, SUPABASE_SETUP_SQL);
  await engine.transaction(async (tx) => {
    for (const { text } of splitSqlStatements(cell.sql).slice(1, -1)) {
      console.log(text, (await tx.query(text)).rows);
    }
    await tx.rollback();
  });
  await engine.close();
}
void main();
```

```sh
npx tsx /path/to/probe.ts
```

Inside the callback use `tx` only; `engine.query` there never resolves. To try another statement
keep the transcript's head and replace the probe. An escape needs both shapes: targeted, then
without `WHERE` and `RETURNING`.

## Decide

| By hand                                                 | Wrong       | Do                                                           |
| ------------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| whoami is not the persona's role, or `row_security` off | runner      | failing test in `tests/runner`, then fix `src/lib/runner`    |
| rows differ from `cell.actualKeys`                      | runner      | same                                                         |
| same rows, and the persona must not reach them          | policy      | the leak is real: fix the SQL                                |
| same rows, and the scenario's intent grants them        | expectation | change the scope, with the reason in the commit, and an ADR  |
| SQLSTATE other than `42501` (`23505`, `23503`, `22023`) | schema/seed | constraint or missing role; see `docs/adr/0014-templates.md` |
