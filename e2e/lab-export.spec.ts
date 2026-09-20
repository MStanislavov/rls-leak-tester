/**
 * "Export CI check" in the lab (brief 3.8), in Chromium under the real Content-Security-Policy:
 * the button follows the run, the dialog previews both files, both are saved as Blob downloads
 * under their exact names, the SQL carries the persona roles and a DO block per failing cell,
 * the workflow is YAML, and a stale result is said so with the offer to run again.
 *
 * That the exported files PROVE what the matrix says is tested by executing them: tests/export.
 */
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Download, type Page } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { MULTI_TENANT_SAAS, TODOS_SHARING } from "../src/lib/scenario/templates";
import {
  expectCleanBrowser,
  expectRunStatus,
  expectVerdict,
  failingCells,
  openLab,
  runToTheEnd,
  setEditorText,
} from "./support/lab";
import { e2eMode } from "./support/page-guard";

const mode = e2eMode();
const TEST_SQL = "rls-isolation.test.sql";
const WORKFLOW = "rls-isolation.yml";

const workflowSchema = z.object({
  name: z.string().min(1),
  permissions: z.object({ contents: z.literal("read") }),
  jobs: z.record(
    z.string(),
    z.object({
      services: z.object({ postgres: z.object({ image: z.string().startsWith("postgres:") }) }),
      steps: z.array(z.looseObject({ name: z.string().optional(), run: z.string().optional() })),
    }),
  ),
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Collects the downloads that `action` starts, until `count` of them have arrived. */
async function downloadsOf(
  page: Page,
  count: number,
  action: () => Promise<void>,
): Promise<Map<string, string>> {
  const arrived: Download[] = [];
  const all = new Promise<void>((resolve) => {
    const onDownload = (download: Download): void => {
      arrived.push(download);
      if (arrived.length === count) {
        page.off("download", onDownload);
        resolve();
      }
    };
    page.on("download", onDownload);
  });
  await action();
  await all;
  const files = new Map<string, string>();
  for (const download of arrived) {
    files.set(download.suggestedFilename(), await readFile(await download.path(), "utf8"));
  }
  return files;
}

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.map((pass) => pass.id)).toContain("color-contrast");
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

test.describe(`export CI check (${mode})`, () => {
  test("run a leaky template, export, and get both files as downloads", async ({ page }) => {
    const template = MULTI_TENANT_SAAS;
    const guard = await openLab(page, `?template=${template.id}&variant=leaky`);
    const button = page.getByTestId("export-ci-button");
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("data-readiness", "no-run");

    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    const failing = await failingCells(page);
    expect(failing).toEqual(template.leaky.expectedFailures);
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("data-readiness", "ready");

    await button.click();
    const dialog = page.getByTestId("export-ci-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("export-ci-files")).toBeVisible();

    // Both previews, read-only text, with where they go and where the verdict comes from.
    const sqlPreview = dialog.getByTestId(`export-ci-preview-${TEST_SQL}`);
    await expect(sqlPreview).toContainText("do $rls$");
    const previewedSql = await sqlPreview.evaluate((node) => node.textContent);
    await expect(dialog.getByTestId(`export-ci-copy-${TEST_SQL}`)).toBeVisible();
    await dialog.getByTestId(`export-ci-tab-${WORKFLOW}`).click();
    await expect(dialog.getByTestId(`export-ci-preview-${WORKFLOW}`)).toContainText(
      "ON_ERROR_STOP",
    );
    await expect(dialog.getByTestId(`export-ci-copy-${WORKFLOW}`)).toBeVisible();
    const note = dialog.getByTestId("export-ci-note");
    await expect(note).toContainText(".github/workflows/rls-isolation.yml");
    await expect(note).toContainText("rls-isolation/");
    await expect(note).toContainText("same probes");
    await expect(dialog.getByTestId("export-ci-outcome")).toHaveAttribute(
      "data-failing-cells",
      String(failing.length),
    );

    const files = await downloadsOf(page, 2, () =>
      dialog.getByTestId("export-ci-download-both").click(),
    );
    expect([...files.keys()].sort()).toEqual([TEST_SQL, WORKFLOW].sort());

    const sql = files.get(TEST_SQL) ?? "";
    expect(previewedSql, "the preview is the file").toBe(sql);
    for (const persona of template.leaky.scenario.personas) {
      expect(sql, `role of ${persona.id}`).toContain(
        `set_config('role', '${persona.dbRole}', true)`,
      );
    }
    for (const cell of failing) {
      const id = `${cell.personaId}|${cell.schema}.${cell.table}|${cell.operation}`;
      // The cell's heading, its remarks, then its own DO block that names the cell.
      const block = new RegExp(
        String.raw`^-- \[\d+/\d+\] ${escapeRegExp(id)}: [^\n]*\n(?:--[^\n]*\n)*do \$rls\$\n[^$]*p_cell => '${escapeRegExp(id)}'`,
        "m",
      );
      expect(sql, `DO block of ${id}`).toMatch(block);
    }

    const workflow = workflowSchema.parse(parseYaml(files.get(WORKFLOW) ?? ""));
    const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run));
    expect(runs.some((run) => run?.includes("ON_ERROR_STOP=1") === true)).toBe(true);
    expect(files.get(WORKFLOW)).toContain(`rls-isolation/${TEST_SQL}`);

    // A single file, and what the workflow loads before the test.
    const single = await downloadsOf(page, 1, () =>
      dialog.getByTestId("export-ci-download-rls-isolation.schema.sql").click(),
    );
    expect([...single.keys()]).toEqual(["rls-isolation.schema.sql"]);
    expect(single.get("rls-isolation.schema.sql")).toContain(
      template.leaky.scenario.schemaSql.trim(),
    );

    await expectCleanBrowser(guard);
  });

  test("an edit after the run makes the export stale, and it offers the run", async ({ page }) => {
    const template = TODOS_SHARING;
    const guard = await openLab(page, `?template=${template.id}&variant=leaky`);
    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");

    // Typed right before the click: the text is still in the editor's debounce.
    await setEditorText(page, "schema", template.fixed.scenario.schemaSql);
    await page.getByTestId("export-ci-button").click();
    const dialog = page.getByTestId("export-ci-dialog");
    await expect(dialog).toHaveAttribute("data-readiness", "stale");
    await expect(dialog.getByTestId("export-ci-stale")).toContainText("changed since the last run");
    await expect(dialog.getByTestId("export-ci-files")).toHaveCount(0);

    await dialog.getByTestId("export-ci-rerun").click();
    await expectRunStatus(page, "done");
    await expectVerdict(page, "ISOLATED");
    await expect(dialog).toHaveAttribute("data-readiness", "ready");
    await expect(dialog.getByTestId("export-ci-outcome")).toHaveAttribute(
      "data-failing-cells",
      "0",
    );

    const files = await downloadsOf(page, 2, () =>
      dialog.getByTestId("export-ci-download-both").click(),
    );
    expect([...files.keys()].sort()).toEqual([TEST_SQL, WORKFLOW].sort());
    await expectCleanBrowser(guard);
  });

  test("a seed that leaves its keys to gen_random_uuid() is warned about before the download", async ({
    page,
  }) => {
    const template = TODOS_SHARING;
    const guard = await openLab(page, `?template=${template.id}&variant=fixed`);
    // The usual Supabase seed: no id column, so every load gets other keys than the exported ones.
    const [users = "", todos = ""] = template.fixed.scenario.seedSql.split(
      "insert into public.todos (id, user_id,",
    );
    const seed = `${users}insert into public.todos (user_id,${todos.replaceAll(/\n {2}\('[0-9a-f-]{36}', /g, "\n  (")}`;
    expect(todos).not.toBe("");
    expect(seed).not.toMatch(/\n {2}\('[0-9a-f-]{36}', '[0-9a-f-]{36}', '/);
    await setEditorText(page, "seed", seed);
    await runToTheEnd(page);

    await page.getByTestId("export-ci-button").click();
    const dialog = page.getByTestId("export-ci-dialog");
    const warnings = dialog.getByTestId("export-ci-warnings");
    await expect(warnings).toBeVisible();
    await expect(warnings).toContainText("public.todos");
    await expect(warnings).toContainText("gen_random_uuid()");
    await expect(warnings).toContainText("Give the seed explicit keys");
    await expect(dialog.getByTestId("export-ci-outcome")).toContainText(
      "stops at its preflight on every run",
    );
    expect(await axeViolations(page)).toEqual([]);
    await expectCleanBrowser(guard);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`no axe violation in the export dialog, ${colorScheme} theme`, async ({ page }) => {
      const guard = await openLab(
        page,
        `?template=${MULTI_TENANT_SAAS.id}&variant=leaky`,
        colorScheme,
      );
      await runToTheEnd(page);
      await page.getByTestId("export-ci-button").click();
      const dialog = page.getByTestId("export-ci-dialog");
      await expect(dialog.getByTestId("export-ci-files")).toBeVisible();
      expect(await axeViolations(page), "test file tab").toEqual([]);
      await dialog.getByTestId(`export-ci-tab-${WORKFLOW}`).click();
      await expect(dialog.getByTestId(`export-ci-preview-${WORKFLOW}`)).toBeVisible();
      expect(await axeViolations(page), "workflow tab").toEqual([]);
      await expectCleanBrowser(guard);
    });
  }
});
