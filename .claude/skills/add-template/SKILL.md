---
name: add-template
description: Use when adding or changing a built-in scenario template of the lab (a demo schema with a leaky and a fixed variant), or when a template's declared failing cells, static findings, golden snapshot or lab end-to-end test disagree after such a change.
---

# Add a scenario template

A template is data that the golden tests hold the real runner to. One bug, one changed policy
expression, one cause per failing cell. Conventions: `docs/adr/0014-templates.md`.

## Steps

1. Write `src/lib/scenario/templates/<id>.ts` with `defineTemplate` and `buildExpectations`
   (`build.ts`) and the personas of `shared.ts`; copy the shape of `todos-sharing.ts`. Pure code
   (ARCH-001).
   - Leaky and fixed share seed, personas, tables and expectations. Only the policy differs.
   - Every persona x table x operation is explicit; `buildExpectations` throws on a gap.
   - Leaky declares `expectedVerdict`, `expectedFailures` (persona, table, operation, `leak` or
     `escape`, in matrix order) and `expectedStaticChecks`. Fixed declares none.
   - Literal seed keys (no `gen_random_uuid()`, no `now()`), single key `id`, no second unique
     constraint, `on delete cascade` towards probed parents.
2. Register it in `TEMPLATES` (`src/lib/scenario/templates/index.ts`) and in the order test of
   `tests/templates/templates.test.ts`.
3. Prove the leak without the runner: hand-written, role-switched statements in
   `tests/templates/templates-sql.integration.test.ts`.
4. The golden suites loop over `TEMPLATES` and write the two new snapshots:

```sh
npx vitest run tests/templates tests/golden
git status --short tests/golden/__snapshots__   # new files for the new id, nothing modified
```

5. Parity in the browser and on a real Postgres; both loop over `TEMPLATES`:

```sh
npm run build && npx playwright test e2e/lab.spec.ts e2e/site.spec.ts
sh scripts/verify-export-postgres.sh            # needs Docker
```

6. Docs entry: an ADR in `docs/adr/` (DOCS-001) with the schema decisions and the declared
   failures row, like `docs/adr/0021-self-template.md`. The landing card and the lab picker come
   from `TEMPLATES`.

## Red?

Declaration and runner disagree: use the debug-probe skill. Never edit `expectedFailures` or a
snapshot to get green (QUAL-002, FA-6). A modified existing snapshot means you broke something.
