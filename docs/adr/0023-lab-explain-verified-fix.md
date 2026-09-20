# Explain in the lab and the verified-fix loop

Status: draft (Phase 6, client side; the endpoint is ADR 0018)

## Context

Brief 3.2, 3.7, 4.7, 4.8 and rules.yaml AI-002: the model explains a failure the engine proved and
proposes SQL; the SQL is a fix only after the matrix was re-run with it. ADR 0018 left the UI and
the loop to this slice.

## Decisions

### Where it lives

- `src/lib/lab/verify-fix.ts` (pure): `appendFixSql`, `applyProposedFix`, `compareRuns`,
  `verifyProposedFix`, `unexpectedStatements`, `cellChangeTitle`, `cellChangeText`.
- `src/lib/lab/explain-state.ts` (pure): the panel's reducer, `isExplainable`, the notices for
  every error shape of `/api/explain`, `fixLabelOf`, `announcementOf`, `restorableState`.
- `src/lib/lab/explain-health.ts`: `fetchExplainAvailability()` reads `GET /api/health` and parses
  it with zod; it never throws and answers `on | off | unknown`.
- `src/components/lab/explain/`: `ExplainCell` is the one entry of `LAB_CELL_DRAWER_EXTENSIONS`.
  The modules are imported by path; `@/lib/lab`'s index was not touched.

### Explain is offered on leak, escape AND overblock

An overblock is a failure the engine proved (rows the persona should reach are out of reach), the
endpoint accepts it (`FAILING_STATUSES`), and the loop judges it the same way: the cell must be
`pass` afterwards. `inconclusive` and `skipped` proved nothing, so they get no panel at all.

### What "Verified fix" means (`compareRuns`)

`verified` only when the re-run finished and

1. every target cell failed before (leak, escape or overblock) and is `pass` now, and
2. no other cell regressed:
   - a cell that passed must still pass; becoming leak, escape, overblock, inconclusive or skipped,
     or no longer existing, is a regression (stricter than the task text, which did not name
     `skipped` and a vanished cell: a cell that is no longer measured is no longer proven);
   - a cell that was no isolation failure must not become `leak` or `escape`;
   - a cell that leaked must not leak MORE rows. Counts are compared, not keys: keys made by
     `gen_random_uuid()` differ between two builds of the database;
   - a cell that did not exist before (the SQL created a table) must not fail.

Cells that failed before and still fail, and are no target, are no regression. A verified outcome
lists them (`remaining`) next to `verdictAfter`, so "Verified fix" is a statement about the cell,
and the panel still says when the scenario as a whole stays LEAKING.

Everything else is `did-not-pass` (with the cells still failing, the cells made worse, or the setup
error when the SQL did not apply) or `incomplete` (cancelled, run ceiling, engine failure, a
proposal that cannot be applied, a target that did not fail). `incomplete` keeps the label
"Proposed (not yet verified)" and offers the re-run again; it is never worded as a failure of the
SQL, because nothing was measured.

The target is the one cell the explanation was asked for. `compareRuns` takes a list, so a later
"explain all failures of this table" needs no new logic.

### How the SQL is applied to the copy

`appendFixSql` puts the proposal at the END of `schemaSql`, behind a comment line
(`FIX_COMMENT`), so it runs after everything the user wrote and before the seed. A last statement
without a terminator gets one; whether it needs one is asked of `splitSqlStatements` (strings,
comments and dollar quotes are its business), not of a search for `;`. The copy goes through
`parseScenario`, so a proposal that makes the schema longer than a scenario may be is refused
before anything runs. The re-run uses the lab's `runIsolated`: its own worker, a fresh database,
no effect on the lab's state.

Statements other than CREATE/DROP/ALTER POLICY, ALTER TABLE, GRANT and REVOKE (what the prompt
asks for) are NOT refused: the matrix judges the result, and refusing by keyword would be a second,
weaker judge. The panel points them out before the user applies them.

### The flow in the drawer

- Availability: one `GET /api/health` per page. `off`: a calm notice that names
  `ANTHROPIC_API_KEY` and says that everything else works; no button. `unknown` (health not
  readable): a notice with "Check again". Nothing is rendered for cells that did not fail.
- Before the click: "What leaves your browser" shows the exact JSON `buildExplainRequest` built
  (the body is `JSON.stringify` of the same object; the e2e compares the two) and its size. A
  request that cannot be built (`too-large`, a cell that no longer matches) shows why instead of
  the button; nothing is sent.
- The answer streams into the panel through `requestExplanation` (`onPartial`); all model text is
  text nodes. The SQL is a read-only `<pre>` with Copy. The model's `confidence` is shown as the
  model's own, with the words that it decides nothing.
- The re-run starts as soon as the answer is complete (brief 3.7: "the client then applies ... and
  re-runs"). Until `compareRuns` has spoken the label is "Proposed (not yet verified)". The re-run
  can be cancelled.
- "Apply to my scenario" exists only for a `verified` outcome, only while the result on screen is
  not stale, and only does something on the click.
- The result on screen must be the run the explanation is about: when the scenario was edited
  since (also when the editors hold text that has not reached the state yet), Explain, the re-run
  and Apply are off and a notice says to run again.
- A closed drawer unmounts the panel and aborts what is in flight. Settled state is kept in a
  `WeakMap` keyed by the `MatrixResult` object, so reopening a cell costs no second request (every
  request, also a cache hit, counts towards the rate limit); a new run drops it.
- 429: title, "Try again in N seconds" from `Retry-After`, and the remark that cache hits count.
  503 `not_configured`: the server's sentence, no retry button. 503 `unavailable`: retry with the
  time. 413 and 400: no retry (the same request would be refused again). Network, 502 and a broken
  stream: retry.

### Wiring edits outside this slice's directories (deviation: three small edits, not one)

"Apply" must change the editor's content and leave the scenario DIRTY. `loadScenario` cannot do
that: it replaces the baseline (not dirty) and asks to discard unsaved changes. So:

- `SqlEditorHandle.setValue(text)` (`sql-editor.tsx`): replaces the document as an edit and
  flushes, so `onChange` hears of it at once.
- `LabSlotProps.applySchemaSql(schemaSql)` (`lab-extensions.tsx`), implemented in
  `lab-workbench.tsx`: through the mounted schema editor, or `sql/set` when the schema tab is not
  on screen; then it shows the schema tab.
- `LAB_CELL_DRAWER_EXTENSIONS = [ExplainCell]`.

The drawer's footer stays sticky; the panel limits itself to 55 % of the viewport height and
scrolls inside, so the cell's evidence stays visible above the explanation.

## Evidence

- Unit tests (`verify-fix.test.ts`, `explain-state.test.ts`, `explain-health.test.ts` in
  `src/lib/lab`): 60 tests. `compareRuns`: fixed, still failing (also as
  leak, overblock, inconclusive, skipped), one of two targets, regression elsewhere (every status,
  vanished cell, new leaking table, more leaked rows, overblock or unproven to leak), setup error,
  NOT PROVEN after, cancelled, ceiling, engine failure, no or wrong target. One test runs the whole
  loop against a real PGlite in Node: the SQL of the template's fixed variant is `verified`
  (LEAKING to ISOLATED, the two sibling cells in `alsoFixed`), SQL that keeps `WITH CHECK (true)`
  is `did-not-pass` with the target cell, SQL on a missing table is a setup error (42P01).
- `e2e/lab-explain.spec.ts` (Chromium, `/api/health` and `/api/explain` intercepted with the
  endpoint's wire format, no model): not configured; verified fix including Apply (dirty, editor
  text, the user's own run is ISOLATED) and the request body equal to what was shown, valid against
  `explainRequestSchema` and free of seed values; wrong fix with the cell listed (dark theme) and
  restored after closing the drawer; SQL that does not apply; 429 then a successful retry. Axe
  scans of every drawer state, no CSP violation, markup in model text shown as characters.

### The reader is loaded on demand

`src/lib/ai/client.ts` imports `parsePartialJson` from `ai`, and Turbopack keeps part of the SDK
with it. Imported statically by the panel, the lab's chunk grew to 417 KB; with
`import("@/lib/ai/client")` inside the Explain click handler it is 253 KB and the reader is a chunk
of its own (161 KB) that is fetched when Explain is first used (sizes of `next build`, unzipped).
A chunk that cannot be fetched is reported as the `network` failure.

## Consequences and limits

- Playwright's `route.fulfill` sends a body at once, so the e2e does not show text arriving in
  pieces; the partial path is covered by the client helper's tests (ADR 0018) and the reducer's.
- The re-run costs a second database boot and a full matrix. It runs beside the lab's own worker
  and is bounded by the same probe timeout and run ceiling.
- The panel offers no countdown for `Retry-After`; it states the seconds once.
