/**
 * Helpers of the lab specs. The conventions they rely on (all set by `src/components/lab`):
 *
 *   [data-testid="lab-root"]      data-run-status = idle | setting-up | running | done | failed | cancelled
 *                                 data-dirty, data-origin = template | blank | saved | imported
 *   [data-testid="verdict"]       data-verdict = ISOLATED | LEAKING | NOT PROVEN | none
 *   [data-testid="matrix-cell"]   data-cell-id, data-status, data-persona, data-schema, data-table,
 *                                 data-operation, data-dimmed, data-timed-out (an inconclusive
 *                                 cell whose probe timed out reads "Timed out")
 *   [data-testid="setup-error"]   data-phase, data-sqlstate, data-line, data-timed-out
 *
 * The panels mounted through `lab-extensions.tsx` name their parts by prefix:
 *
 *   export-ci-*   button, dialog, files, stale, rerun, note, outcome, download-both, download-all,
 *                 and per file tab-<name>, preview-<name>, download-<name>   (e2e/lab-export.spec.ts)
 *   explain-*     panel, button, off-notice, payload, payload-json, sql, confidence, announcement
 *   fix-*         label (data-fix-status = unverified | no-sql | verifying | incomplete | verified |
 *                 applied | did-not-pass), verdict-after, fixed, also-fixed, cell, apply, applied
 *                                                                           (e2e/lab-explain.spec.ts)
 *   share-*       button, dialog, disabled-dialog, signed-out, submit, link, visibility-<option>
 *   shared-*      notice, loading, failure, retry, scenario, scenario-delete  (e2e/share.spec.ts)
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { PageGuard } from "./page-guard";

export const FAILING_CELLS =
  '[data-testid="matrix-cell"][data-status="leak"], [data-testid="matrix-cell"][data-status="escape"]';

export interface CellKey {
  readonly personaId: string;
  readonly schema: string;
  readonly table: string;
  readonly operation: string;
  readonly status: string;
}

export async function openLab(
  page: Page,
  query = "",
  colorScheme: "light" | "dark" = "light",
): Promise<PageGuard> {
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  const guard = await PageGuard.attach(page);
  await page.goto(`/lab${query}`);
  // The workbench is client-only (`ssr: false`): the Run button exists once it has mounted.
  await expect(page.getByTestId("run-button")).toBeVisible();
  await guard.waitForHydration('[data-testid="run-button"]');
  return guard;
}

export function labRoot(page: Page): Locator {
  return page.getByTestId("lab-root");
}

export async function expectRunStatus(page: Page, status: string, timeout?: number): Promise<void> {
  await expect(labRoot(page)).toHaveAttribute(
    "data-run-status",
    status,
    timeout === undefined ? undefined : { timeout },
  );
}

/** Presses Run and waits for the run to end in `done`. */
export async function runToTheEnd(page: Page): Promise<void> {
  await page.getByTestId("run-button").click();
  await expectRunStatus(page, "done");
}

export async function expectVerdict(page: Page, verdict: string): Promise<void> {
  await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", verdict);
}

export async function failingCells(page: Page): Promise<CellKey[]> {
  return page.locator(FAILING_CELLS).evaluateAll((cells) =>
    cells.map((cell) => {
      const data = (cell as HTMLElement).dataset;
      return {
        personaId: data.persona ?? "",
        schema: data.schema ?? "",
        table: data.table ?? "",
        operation: data.operation ?? "",
        status: data.status ?? "",
      };
    }),
  );
}

/** Replaces the whole text of a SQL editor, the way a paste does. */
export async function setEditorText(
  page: Page,
  kind: "schema" | "seed",
  text: string,
): Promise<void> {
  await page.getByTestId(`tab-${kind}`).click();
  const content = page.locator(`[data-testid="sql-editor-${kind}"] .cm-content`);
  await content.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

export async function importScenario(page: Page, name: string, json: string): Promise<void> {
  await page.getByTestId("scenario-import-input").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(json, "utf8"),
  });
}

export async function expectCleanBrowser(guard: PageGuard): Promise<void> {
  expect(await guard.cspViolations(), "securitypolicyviolation events").toEqual([]);
  expect(guard.consoleProblems, "console errors and CSP messages").toEqual([]);
  expect(guard.pageErrors, "uncaught page errors").toEqual([]);
}

export function focusedCellId(page: Page): Promise<string | null> {
  return page.evaluate(() =>
    document.activeElement instanceof HTMLElement
      ? (document.activeElement.dataset.cellId ?? null)
      : null,
  );
}
