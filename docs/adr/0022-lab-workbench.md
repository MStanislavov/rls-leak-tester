# ADR: the lab workbench

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 5, task U2
- Versions: Next.js 16.3.5 (Turbopack), React 19.2.8, zod 4.6.5, CodeMirror 6 (`codemirror`
  6.0.2, `@codemirror/view` 6.43), `@electric-sql/pglite` 0.5.8, Playwright 1.63 with Chromium,
  `@axe-core/playwright` 4.13

## Context

`/lab` was the Phase 1 spike (one proof query, a slow-query button). This slice replaces it with
the product's main screen: scenario editors, personas, expectations, Run, the result matrix, the
cell drawer, static findings, setup errors, local save and scenario files. Everything below was
run and read on this machine.

## Shape

| Where                        | What                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/lab/`               | Pure state and view logic with unit tests: reducer, run host, view models, grid navigation, URL parameters, scenario edits      |
| `src/components/lab/`        | The UI. `lab-engine.ts` is the only module that reaches `src/lib/engine`, through `import()` from a `"use client"` module       |
| `src/app/lab/`               | `page.tsx` (server: parses `searchParams` with zod), `lab-loader.tsx` (`next/dynamic`, `ssr: false`), `lab.css` (syntax tokens) |
| `e2e/lab.spec.ts`            | The workbench end to end                                                                                                        |
| `e2e/lab-pglite-csp.spec.ts` | ADR 0003's proofs, now on the real lab                                                                                          |

## Decisions

### 1. Matrix orientation: row groups are tables, rows are personas, columns are the four operations

The brief leaves it open ("rows = tables, column groups = personas x operations, or the other way
round"). With 3 to 6 personas, persona x operation columns are 12 to 24 columns of icon plus word:
about 1 300 px for five personas, so it does not fit the required 1 024 px. Four operation columns
always fit (the grid is 33 rem wide at its narrowest) and still read on a phone. A static finding
highlights the row GROUP of its table.

### 2. The scenario is one panel with four tabs

Schema SQL, Seed SQL, Personas, Expectations. The brief lists personas and expectations as panels
of their own; stacked under a 30 rem editor they made the left column about 4 000 px tall for the
first template (measured on a screenshot) and pushed the expectations out of sight. Mode and
default grants stay above the tabs because they apply to all four. A setup error switches to the
tab of the editor that holds the statement (reducer, `activeTab`).

### 3. zod must not probe for `eval` in the browser (found by the production e2e run)

zod 4 compiles object parsers with `new Function` when it can, and finds out by trying, **when an
object schema is constructed** (`node_modules/zod/v4/core/schemas.js`, `const fastEnabled = jit &&
allowsEval.value` inside the `$ZodObject` initializer; `util.allowsEval` runs `new Function("")`
in a try). Under the production policy (no `'unsafe-eval'`) the attempt is blocked, zod falls back,
and the browser has already fired `securitypolicyviolation` (`script-src`, blocked URI `eval`).
Observed: `npm run e2e`-style run in prod mode, 13 of 21 lab tests failed on `expectCleanBrowser`
with exactly that event; in dev mode nothing, because the dev policy allows eval.

Fix: `src/lib/lab/zod-csp.ts` calls `z.config({ jitless: true })` as a side effect and is the FIRST
import of `src/components/lab/lab-workbench.tsx`, so it runs before `@/lib/scenario/schema` is
evaluated. zod's own source documents this use of `jitless`. It is not part of `@/lib/lab`'s index
on purpose: the setting is global to zod and the server imports that index too. After the change
the same 21 tests pass in prod mode with zero violations.

**For other client code:** any other client entry that builds zod object schemas on a page with
this CSP needs the same first import, or it will report the same violation.

### 4. Cancel and the run ceiling terminate the worker; `engine.close()` cannot

`createProtocolEngine().close()` is queued behind the statement that is running (`exclusive`), so
closing an engine that is stuck in `pg_sleep` waits for the 5 s statement timeout. Observed: the
first version of Cancel called `engine.close()` and the e2e test saw `setting-up` for more than
3 s after the click. The engine library was NOT changed. Instead the lab's port carries a second
handle:

```ts
interface LabEngineHandle {
  engine: SqlEngine;
  terminate(): void;
}
```

In the browser `terminate` is `PgliteWorkerClient.dispose()`, which terminates the worker at once
and rejects what is in flight with a lost-database error. `runLab` aborts the runner's signal AND
terminates; its engine wrapper then refuses every further call, so a half-finished cell does not
boot a new worker only to fail. The run ceiling (`thresholds.runner.run_ceiling_ms`, 60 s) uses the
same path and ends in `failed / ceiling`. `src/lib/lab/thresholds.test.ts` pins both numbers to
`rules.yaml`.

### 5. A statement of the user's SQL that times out is shown like any other setup error

`setupDatabase` passes a lost database through unchanged, so a seed of `select pg_sleep(60)` came
back as a bare `EngineTimeoutError` without statement or line. `runLab` wraps the engine, remembers
the last script `exec` was given and how often that same text had run, and looks the text up among
the statements of schema then seed (`locateTimedOutStatement`). The panel shows phase, statement,
line and "timed out", with SQLSTATE empty (Postgres never judged it). A timeout in the product's
own SQL (shim, grants) has no statement of the user's and stays an engine failure.

### 6. The editors are uncontrolled; a result is dated by revision

CodeMirror holds the document. Changes reach the reducer debounced (200 ms), on blur, on unmount,
and through `handle.flush()`; Run, Save, Export and the unsaved-changes check read the editors
directly (`getScenario()`), so none of them can miss the last keystrokes. The reducer records the
revision at `run/start`; an edit afterwards marks the result stale, the flush right before it does
not, and a title change never does.

Syntax colours are CSS variables (`--cm-*` in `src/app/lab/lab.css`, light and dark, AA on
`--card`), so the theme class switches the editor without a reconfigure. CodeMirror's default and
one-dark highlight styles were not used: their fixed colours are not all AA on this palette. Tab
is not bound (no keyboard trap); `tabindex="0"` on the content element is what makes axe accept
the scroller as keyboard-reachable (`scrollable-region-focusable` failed without it).

### 7. Status visuals and words are shared with the site

Icons, classes and words for statuses, verdicts and severities come from
`src/components/site/status-badge.tsx`, `severity-badge.tsx` and `src/lib/site/status.ts`. In the
matrix a `pass` cell has no tint so that what is not a pass stands out, and a cell outside the
status filter is neutral instead of transparent (opacity would break AA contrast). Icon and word
stay in every case.

### 8. e2e: what replaced the spike's tests

`e2e/lab-pglite-csp.spec.ts` kept its CSP header test and gained three on the real lab: hydration
with a nonce on every inline script and NO worker or WASM before the first Run; every run on a
worker of its own (the template's plain `CREATE TABLE` would fail with 42P07 on a surviving
database, which replaces the spike's marker table); a statement that exceeds its timeout kills the
worker (Playwright's `close` event, by identity), nothing arrives after the point where it would
have returned, and a new worker answers. Its landing and 404 tests were removed because
`e2e/site.spec.ts` now holds equivalent ones. Wall-clock upper bounds were dropped after one
failed under six parallel Postgres boots (9 089 ms against a 9 000 ms bound); the proof does not
need them: without the timeout the statement would finish and the run would end in a verdict.

## Extension points and conventions

`src/components/lab/lab-extensions.tsx`: `LAB_TOOLBAR_EXTENSIONS` (rendered left of Run) and
`LAB_CELL_DRAWER_EXTENSIONS` (rendered in the drawer footer with the open cell). Components
receive `LabSlotProps` / `LabCellSlotProps`: scenario, `getScenario()`, validation, run state,
result, `matrixRun` (with `cellContexts` for the export), catalog, findings, `runIsolated()` (a
run on its own worker that does not touch the lab's state, for the verified-fix re-run) and
`loadScenario()`. `/lab?saved=<id>` opens an entry of the local store, which is how a fork can
hand a scenario over. The `data-testid` and `data-*` conventions are listed at the top of
`e2e/support/lab.ts`.

## Not done, known limits

- `@lezer/highlight` is imported by `sql-editor.tsx` (`tags`) but is only a transitive dependency
  of `@codemirror/language`. It resolves today (1.2.3, hoisted); it should be added to
  `package.json` by whoever may run npm.
- The ceiling path is unit-tested with scripted engines; no e2e test waits 60 s for it.
- The 200 KB editor test measures that typing is reflected within 3 s and that the viewport
  renders fewer than 400 lines; it is a guard against a regression to a controlled editor, not a
  benchmark.
- `CodeMirror`'s search panel and autocompletion tooltips were not scanned with axe (they are
  closed during the scans).

## Verification

See the final report of this slice for the commands and their output.
