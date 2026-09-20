# ADR draft: "Export CI check" in the lab

Status: accepted (Phase 5, task U5). Builds on the CI export ADR (generator) and the lab
workbench ADR (extension points).

## Context

Brief 3.8 asks for a button that generates `rls-isolation.test.sql` and `rls-isolation.yml`.
The generator (`@/lib/export`) needs a completed `MatrixRun` of the scenario, which the lab keeps
after every run (`matrixRun` in the slot props), so exporting needs no second database.

## Decisions

1. **Mounted as a toolbar extension.** `ExportCiCheck`
   (`src/components/lab/export/export-ci-check.tsx`) is the first entry of
   `LAB_TOOLBAR_EXTENSIONS`. Pure logic lives in `src/lib/lab/export-ci.ts`
   (`ciExportReadiness`, `buildCiExportView`) and is unit tested against real runs.
2. **Readiness is derived, not stored.** `no-run | running | stale | ready` comes from the slot
   props on every render. The button is enabled once a run has completed and nothing is in
   flight. Its click handler calls `getScenario()`, which flushes the editors, so text that is
   still in an editor's debounce makes the result stale before the dialog looks at it.
3. **Stale: say so and offer the lab's own run.** The export is never generated from a run of an
   older text. The dialog shows why and a "Run again" button; it stays open during the run and
   shows the files when the run is done, because everything it shows is derived from the props.
   This needed one additive slot prop, `LabSlotProps.startRun` (what the Run button does), wired
   in `lab-workbench.tsx`. `runIsolated` was not used: the matrix on screen and the exported
   files must describe the same run.
4. **Two files previewed, the companions offered.** Deviation from the letter of the brief, which
   follows from the generator's: the workflow loads the Supabase setup (supabase mode), the
   schema and the seed before the test, so the dialog previews the two files of the brief (tabs,
   read-only `<pre>`, copy and download each, "Download both files") and lists the companion
   files as single downloads plus "Download all".
5. **Downloads are Blob URLs on an `<a download>`**, one per file (no zip dependency). Verified
   under the production CSP in `e2e/lab-export.spec.ts`: no directive applies to a download, so
   `blob:` needed no new entry and `script-src` is untouched; the spec asserts zero
   `securitypolicyviolation` events. A browser may ask once before it saves several files from
   one click; the dialog says so, and every file also has a button of its own.
6. **The Supabase setup SQL comes from `loadLabPorts()`**, the lab's only door to
   `src/lib/engine` (SEC-004). A completed run has already loaded that chunk.

## Test ids

`export-ci-button[data-readiness]`, `export-ci-dialog[data-readiness]`, `export-ci-files`,
`export-ci-tab-<file>`, `export-ci-preview-<file>`, `export-ci-copy-<file>`,
`export-ci-download-<file>`, `export-ci-download-both`, `export-ci-download-all`,
`export-ci-note`, `export-ci-outcome[data-failing-cells]`, `export-ci-stale`, `export-ci-rerun`,
`export-ci-waiting`, `export-ci-error`.
