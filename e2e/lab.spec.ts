/**
 * The lab workbench, end to end, in Chromium: templates, the matrix as a keyboard grid, the
 * details drawer, user SQL errors, a UI that stays responsive while Postgres is stuck, recovery
 * from runaway SQL, the local store, scenario files, and accessibility in both themes.
 */
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { serializeScenario } from "../src/lib/scenario/serialize";
import { TEMPLATES, TODOS_SHARING } from "../src/lib/scenario/templates";
import {
  FAILING_CELLS,
  expectCleanBrowser,
  expectRunStatus,
  expectVerdict,
  failingCells,
  focusedCellId,
  importScenario,
  labRoot,
  openLab,
  runToTheEnd,
  setEditorText,
} from "./support/lab";
import { e2eMode } from "./support/page-guard";

const mode = e2eMode();

const BROKEN_SCHEMA = `create table public.ok (id int primary key);

create table public.broken (
  id int primary key,
  oops nonexistent_type
);`;

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.map((pass) => pass.id)).toContain("color-contrast");
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

test.describe(`lab workbench (${mode})`, () => {
  for (const template of TEMPLATES) {
    test(`${template.id}: leaky is LEAKING with exactly the declared cells, fixed is ISOLATED`, async ({
      page,
    }) => {
      const guard = await openLab(page, `?template=${template.id}&variant=leaky`);
      await expect(page.getByTestId("scenario-title")).toHaveValue(template.leaky.scenario.title);
      await expectVerdict(page, "none");

      await runToTheEnd(page);
      await expectVerdict(page, "LEAKING");
      expect(await failingCells(page)).toEqual(template.leaky.expectedFailures);
      // Every other cell was really measured and passed: nothing inconclusive hides behind it.
      const statuses = await page
        .getByTestId("matrix-cell")
        .evaluateAll((cells) => cells.map((cell) => (cell as HTMLElement).dataset.status));
      expect(statuses.length).toBeGreaterThan(0);
      expect(
        statuses.filter((status) => status !== "pass" && status !== "leak" && status !== "escape"),
      ).toEqual([]);
      // Never colour alone: each failing cell says its status in words.
      for (const cell of await page.locator(FAILING_CELLS).all()) {
        await expect(cell).toContainText(/Leak|Escape/);
        await expect(cell.locator("svg")).toHaveCount(1);
      }
      await expect(page.getByTestId("finding")).toHaveCount(
        template.leaky.expectedStaticChecks.length,
      );
      expect(
        await page
          .getByTestId("finding")
          .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.findingId)),
      ).toEqual(template.leaky.expectedStaticChecks.map((check) => check.id));

      await page.getByTestId("variant-fixed").click();
      await expect(page.getByTestId("scenario-title")).toHaveValue(template.fixed.scenario.title);
      await expect(page).toHaveURL(new RegExp(`template=${template.id}&variant=fixed`));
      await expectVerdict(page, "none");
      await runToTheEnd(page);
      await expectVerdict(page, "ISOLATED");
      await expect(page.locator(FAILING_CELLS)).toHaveCount(0);
      await expect(page.getByTestId("findings-empty")).toBeVisible();

      // Every run had a worker of its own, and none is left behind.
      expect(guard.workers).toHaveLength(2);
      await expect.poll(() => guard.closedWorkers.length).toBe(2);
      expect(page.workers()).toHaveLength(0);
      await expectCleanBrowser(guard);
    });
  }

  test("the matrix is a keyboard grid, and the drawer gives the focus back", async ({ page }) => {
    const guard = await openLab(page);
    await runToTheEnd(page);

    const grid = page.getByRole("grid");
    await expect(grid).toBeVisible();
    // Roving tabindex: exactly one cell is in the tab order.
    await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);

    const first = "anon|public.invoices|select";
    await page.locator(`[data-cell-id="${first}"]`).focus();
    expect(await focusedCellId(page)).toBe(first);
    await page.keyboard.press("ArrowRight");
    expect(await focusedCellId(page)).toBe("anon|public.invoices|insert");
    await page.keyboard.press("ArrowDown");
    expect(await focusedCellId(page)).toBe("alice|public.invoices|insert");
    await page.keyboard.press("End");
    expect(await focusedCellId(page)).toBe("alice|public.invoices|delete");
    await page.keyboard.press("Home");
    expect(await focusedCellId(page)).toBe("alice|public.invoices|select");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    expect(await focusedCellId(page)).toBe(first);
    await page.keyboard.press("ArrowLeft");
    expect(await focusedCellId(page)).toBe(first);
    await page.keyboard.press("Control+End");
    expect(await focusedCellId(page)).toBe("service|public.tenants|delete");
    await page.keyboard.press("Control+Home");
    expect(await focusedCellId(page)).toBe(first);
    // The focused cell is the one tab stop now.
    await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveAttribute(
      "data-cell-id",
      first,
    );

    // Down to the escaping cell: five personas per table, Alice is the second of public.projects.
    const escaping = "alice|public.projects|update";
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await focusedCellId(page)).toBe(escaping);

    await page.keyboard.press("Enter");
    const drawer = page.getByTestId("cell-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("cell-drawer-title")).toHaveText(
      "UPDATE public.projects as alice",
    );
    await expect(page.getByTestId("cell-drawer-status")).toHaveAttribute("data-status", "escape");
    await expect(page.getByTestId("cell-drawer-expected")).toHaveAttribute("data-count", "3");
    await expect(page.getByTestId("cell-drawer-leaked")).toHaveAttribute("data-count", "0");
    await expect(page.getByTestId("cell-drawer-sql")).toContainText(
      "select set_config('role', 'authenticated', true);",
    );
    await expect(page.getByTestId("cell-drawer-sql")).toContainText("rollback;");
    // Two escape shapes; the WHERE-less one is the one that gets through (ADR 0014).
    const escapes = drawer.locator('[data-testid="cell-drawer-subprobe"][data-status="escape"]');
    await expect(escapes).toHaveCount(1);
    await expect(escapes).toHaveAttribute("data-kind", "escape-bulk");
    await expect(drawer.getByTestId("cell-drawer-policy")).toContainText(["projects_update"]);
    await expect(page.getByTestId("cell-drawer-footer")).toBeAttached();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(await focusedCellId(page)).toBe(escaping);

    await page.keyboard.press(" ");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(await focusedCellId(page)).toBe(escaping);
    await expectCleanBrowser(guard);
  });

  test("status chips filter the matrix and a finding highlights its table", async ({ page }) => {
    await openLab(page);
    await runToTheEnd(page);
    await expect(page.getByTestId("matrix-cell")).toHaveCount(60);

    await page.locator('[data-testid="status-chip"][data-status="escape"]').click();
    await expect(page.getByTestId("matrix-table-group")).toHaveCount(1);
    await expect(page.getByTestId("matrix-cell")).toHaveCount(12);
    await expect(page.locator('[data-testid="matrix-cell"][data-dimmed="false"]')).toHaveCount(3);
    await page.getByTestId("status-chip-clear").click();
    await expect(page.getByTestId("matrix-cell")).toHaveCount(60);

    const projects = page.locator(
      '[data-testid="matrix-table-group"][data-table="public.projects"]',
    );
    await expect(projects).toHaveAttribute("data-highlighted", "false");
    const finding = page.getByTestId("finding").first();
    await expect(finding).toHaveAttribute("data-table", "public.projects");
    const docs = finding.getByRole("link", { name: /Documentation/ });
    await expect(docs).toHaveAttribute("rel", "noopener noreferrer");
    await expect(docs).toHaveAttribute("href", /^https:\/\//);
    await finding.getByTestId("finding-highlight").click();
    await expect(projects).toHaveAttribute("data-highlighted", "true");
    await expect(finding).toHaveAttribute("data-active", "true");
  });

  test("a broken schema shows phase, SQLSTATE, message, statement and line, and marks the line", async ({
    page,
  }) => {
    const guard = await openLab(page, "?template=blank");
    await setEditorText(page, "schema", BROKEN_SCHEMA);
    // Ctrl/Cmd+Enter inside the editor runs the matrix.
    await page.keyboard.press("ControlOrMeta+Enter");
    await expectRunStatus(page, "failed");

    const error = page.getByTestId("setup-error");
    await expect(error).toHaveAttribute("data-phase", "schema");
    await expect(error).toHaveAttribute("data-sqlstate", "42704");
    await expect(error).toHaveAttribute("data-line", "5");
    await expect(page.getByTestId("setup-error-sqlstate")).toHaveText("SQLSTATE 42704");
    await expect(page.getByTestId("setup-error-message")).toContainText(
      'type "nonexistent_type" does not exist',
    );
    await expect(page.getByTestId("setup-error-statement")).toContainText(
      "create table public.broken",
    );
    await expectVerdict(page, "none");

    const editor = page.getByTestId("sql-editor-schema");
    await expect(editor).toHaveAttribute("data-error-line", "5");
    await expect(editor.locator(".cm-lab-error-line")).toHaveText("  oops nonexistent_type");

    // A failing seed brings the seed editor to the front.
    await setEditorText(page, "schema", "create table public.ok (id int primary key);");
    await setEditorText(
      page,
      "seed",
      "insert into public.ok values (1);\ninsert into public.nowhere values (1);",
    );
    await page.getByTestId("tab-personas").click();
    await page.getByTestId("run-button").click();
    await expectRunStatus(page, "failed");
    await expect(error).toHaveAttribute("data-phase", "seed");
    await expect(error).toHaveAttribute("data-sqlstate", "42P01");
    await expect(error).toHaveAttribute("data-line", "2");
    await expect(page.getByTestId("tab-seed")).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("sql-editor-seed").locator(".cm-lab-error-line")).toHaveText(
      "insert into public.nowhere values (1);",
    );
    await expectCleanBrowser(guard);
  });

  test("the page stays responsive while Postgres is stuck, and a second run works", async ({
    page,
  }) => {
    const guard = await openLab(page, "?template=todos-sharing&variant=fixed");
    await setEditorText(page, "seed", "select pg_sleep(60);");
    await page.getByTestId("run-button").click();
    await expectRunStatus(page, "setting-up");

    // Postgres sleeps inside the worker; the main thread keeps answering.
    const title = page.getByTestId("scenario-title");
    await title.fill("Typed while Postgres sleeps");
    await expect(title).toHaveValue("Typed while Postgres sleeps");
    await page.getByTestId("tab-personas").click();
    await expect(page.getByTestId("persona-card").first()).toBeVisible();
    await page.getByTestId("persona-label").first().fill("Still typing");
    await expect(page.getByTestId("persona-label").first()).toHaveValue("Still typing");
    // All of that happened while the statement was still running.
    await expectRunStatus(page, "setting-up");

    // The per-statement timeout (rules.yaml: 5 s) cuts it off, far sooner than 60 s.
    const error = page.getByTestId("setup-error");
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(error).toHaveAttribute("data-phase", "seed");
    await expect(error).toHaveAttribute("data-timed-out", "true");
    await expect(error).toHaveAttribute("data-line", "1");
    await expect(page.getByTestId("setup-error-statement")).toHaveText("select pg_sleep(60)");
    await expectVerdict(page, "none");
    // The browser itself reports the stuck worker as gone.
    await expect.poll(() => guard.closedWorkers.length).toBe(1);
    expect(page.workers()).toHaveLength(0);

    // Back to the template (the edits are discarded on purpose) and run again: a new worker.
    await page.getByTestId("variant-leaky").click();
    await page.getByTestId("discard-confirm").click();
    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    expect(guard.workers).toHaveLength(2);
    await expectCleanBrowser(guard);
  });

  test("a runaway probe ends as one inconclusive cell; the database is rebuilt and the run goes on", async ({
    page,
  }) => {
    const guard = await openLab(page);
    const scenario = structuredClone(TODOS_SHARING.fixed.scenario);
    const stuck = scenario.expectations.find(
      (expectation) =>
        expectation.personaId === "anon" &&
        expectation.table === "todos" &&
        expectation.operation === "select",
    );
    expect(stuck).toBeDefined();
    if (stuck !== undefined) {
      stuck.scope = "custom";
      stuck.expectedRowsSql = "select id from public.todos where pg_sleep(60) is not null";
    }
    await importScenario(page, "runaway.scenario.json", serializeScenario(scenario));
    await expect(labRoot(page)).toHaveAttribute("data-origin", "imported");

    await page.getByTestId("run-button").click();
    await expectRunStatus(page, "done", 45_000);
    const cell = page.locator('[data-cell-id="anon|public.todos|select"]');
    await expect(cell).toHaveAttribute("data-status", "inconclusive");
    await expect(
      page.locator('[data-testid="matrix-cell"][data-status="inconclusive"]'),
    ).toHaveCount(1);
    await expect(page.locator(FAILING_CELLS)).toHaveCount(0);
    // The other cells were measured on the rebuilt database, so the verdict stands.
    await expectVerdict(page, "ISOLATED");
    await expect(page.getByTestId("verdict")).toContainText("database rebuilt 1 time");

    await cell.click();
    await expect(page.getByTestId("cell-drawer-reason")).toContainText("5000 ms");
    await page.keyboard.press("Escape");

    // First worker killed by the timeout, second one closed at the end of the run.
    expect(guard.workers).toHaveLength(2);
    await expect.poll(() => guard.closedWorkers.length).toBe(2);
    expect(page.workers()).toHaveLength(0);
    await expectCleanBrowser(guard);
  });

  test("Cancel stops a run at once and terminates its worker", async ({ page }) => {
    const guard = await openLab(page);
    await setEditorText(page, "seed", "select pg_sleep(60);");
    await page.getByTestId("run-button").click();
    await expectRunStatus(page, "setting-up");
    // Let the worker boot and reach the sleeping statement.
    await page.waitForTimeout(2_000);
    const cancelledAt = Date.now();
    await page.getByTestId("cancel-button").click();
    await expectRunStatus(page, "cancelled", 3_000);
    expect(Date.now() - cancelledAt).toBeLessThan(3_000);
    await expect(page.getByTestId("run-button")).toBeEnabled();
    await expect.poll(() => guard.closedWorkers.length).toBe(guard.workers.length);
    expect(page.workers()).toHaveLength(0);
  });

  test("the live region says when the verdict it reads out is stale or from before a cancelled run", async ({
    page,
  }) => {
    await openLab(page, "?template=todos-sharing&variant=fixed");
    const announcement = page.getByTestId("verdict-announcement");
    await expect(announcement).toHaveAttribute("role", "status");
    await runToTheEnd(page);
    await expectVerdict(page, "ISOLATED");
    await expect(announcement).toHaveText(
      /^Verdict: ISOLATED\. \d+ passes\. \d+ cells in total\.$/,
    );

    // The scenario now leaks, and its run never gets past setup: the old verdict stays on screen.
    await setEditorText(
      page,
      "schema",
      `${TODOS_SHARING.fixed.scenario.schemaSql}\nalter table public.todos disable row level security;\nselect pg_sleep(60);`,
    );
    await expect(page.getByTestId("result-stale")).toBeVisible();
    await expect(announcement).toHaveText(
      /^Verdict: ISOLATED\..* The scenario changed after this run; run again\.$/,
    );

    await page.getByTestId("run-button").click();
    await expectRunStatus(page, "setting-up");
    await expect(announcement).toHaveText(/^Setting up/);
    await page.getByTestId("cancel-button").click();
    await expectRunStatus(page, "cancelled", 3_000);
    await expectVerdict(page, "ISOLATED");
    await expect(announcement).toHaveText(
      /^Run cancelled\. The result is from the run before it\. Verdict: ISOLATED\..* The scenario changed after this run; run again\.$/,
    );
  });

  test("live validation blocks a run and names the problem", async ({ page }) => {
    await openLab(page);
    await page.getByTestId("tab-personas").click();
    const alice = page.locator('[data-testid="persona-card"][data-persona-id="alice"]');
    const claims = alice.getByTestId("persona-claims");
    await claims.fill('{ "sub": ');
    await expect(alice.getByTestId("persona-problems")).toContainText("Not valid JSON");
    await expect(page.getByTestId("run-button")).toBeDisabled();
    await expect(page.getByTestId("scenario-problems")).toBeVisible();

    await claims.fill('{ "sub": "not-a-uuid" }');
    await expect(alice.getByTestId("persona-problems")).toContainText("must be a uuid");
    await expect(page.getByTestId("run-button")).toBeDisabled();

    await alice.getByTestId("persona-new-sub").click();
    await expect(claims).toHaveValue(/"sub": "[0-9a-f]{8}-[0-9a-f]{4}-/);
    await expect(alice.getByTestId("persona-problems")).toHaveCount(0);
    await expect(page.getByTestId("run-button")).toBeEnabled();

    await page.getByTestId("persona-add").click();
    await expect(page.getByTestId("persona-card")).toHaveCount(6);
    await page.getByTestId("persona-remove").last().click();
    await expect(page.getByTestId("persona-card")).toHaveCount(5);
  });

  test("Introspect lists tables with suggested columns, and defaults are marked", async ({
    page,
  }) => {
    await openLab(page, "?template=blank");
    await setEditorText(
      page,
      "schema",
      `create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  org_id uuid,
  body text
);
alter table public.notes enable row level security;`,
    );
    await page.getByTestId("tab-expectations").click();
    await expect(page.getByTestId("tables-empty")).toBeVisible();
    await page.getByTestId("introspect-button").click();

    const table = page.locator('[data-testid="table-config"][data-table="public.notes"]');
    await expect(table).toHaveAttribute("data-source", "suggested");
    await expect(table.getByTestId("table-ownerColumn")).toHaveValue("user_id");
    await expect(table.getByTestId("table-tenantColumn")).toHaveValue("org_id");
    await expectRunStatus(page, "idle");
    // Three personas x four operations, all defaults: anon none, signed-in users own.
    const selects = table.getByTestId("expectation-select");
    await expect(selects).toHaveCount(12);
    await expect(
      table.locator('[data-testid="expectation-select"][data-source="default"]'),
    ).toHaveCount(12);
    const userSelect = table.locator(
      '[data-testid="expectation-select"][data-persona="user-a"][data-operation="select"]',
    );
    await expect(userSelect.locator("option:checked")).toHaveText("own (default)");

    await userSelect.selectOption("custom");
    await expect(userSelect).toHaveAttribute("data-source", "explicit");
    await table.getByTestId("expectation-edit-sql").click();
    await expect(page.getByTestId("expected-rows-sql")).toHaveValue(
      'select "id" from "public"."notes" where false',
    );
    await page
      .getByTestId("expected-rows-sql")
      .fill("select id from public.notes where user_id = :sub::uuid");
    await page.getByTestId("expected-rows-save").click();

    await table.getByTestId("table-tenantColumn").selectOption("");
    await expect(table).toHaveAttribute("data-source", "configured");
    await table.getByTestId("table-reset").click();
    await expect(table).toHaveAttribute("data-source", "suggested");
    // RLS is on and there is no policy: the static check says so without a run.
    await expect(page.locator('[data-testid="finding"][data-finding-id="RLS002"]')).toBeVisible();
  });

  test("local save round trip, the unsaved-changes guard, open and delete", async ({ page }) => {
    await openLab(page);
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "false");
    await page.getByTestId("tab-personas").click();
    await page.getByTestId("persona-label").first().fill("A visitor of mine");
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "true");

    // Leaving with unsaved changes asks first.
    await page.getByTestId("variant-fixed").click();
    await expect(page.getByTestId("discard-dialog")).toBeVisible();
    await page.getByTestId("discard-cancel").click();
    await expect(page.getByTestId("persona-label").first()).toHaveValue("A visitor of mine");

    await page.getByTestId("scenario-save").click();
    await page.getByTestId("save-as-title").fill("My saved scenario");
    await page.getByTestId("save-as-confirm").click();
    await expect(labRoot(page)).toHaveAttribute("data-origin", "saved");
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "false");
    await expect(page.getByTestId("scenario-title")).toHaveValue("My saved scenario");
    await expect(page).toHaveURL(/\/lab\?saved=my-saved-scenario-[a-z2-7]+$/);

    // The address reopens it, from localStorage, after a reload.
    await page.reload();
    await expect(page.getByTestId("scenario-title")).toHaveValue("My saved scenario");
    await expect(labRoot(page)).toHaveAttribute("data-origin", "saved");
    await page.getByTestId("tab-personas").click();
    await expect(page.getByTestId("persona-label").first()).toHaveValue("A visitor of mine");

    // Save again overwrites the same entry.
    await page.getByTestId("persona-label").first().fill("Changed again");
    await page.getByTestId("scenario-save").click();
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "false");

    await page.getByTestId("template-select").selectOption("team-workspace");
    await expect(labRoot(page)).toHaveAttribute("data-origin", "template");
    await page.getByTestId("scenario-menu").click();
    await page.getByTestId("scenario-open").click();
    await expect(page.getByTestId("saved-scenario")).toHaveCount(1);
    await page.getByTestId("saved-scenario-open").click();
    await expect(page.getByTestId("scenario-title")).toHaveValue("My saved scenario");
    await page.getByTestId("tab-personas").click();
    await expect(page.getByTestId("persona-label").first()).toHaveValue("Changed again");

    await page.getByTestId("scenario-menu").click();
    await page.getByTestId("scenario-open").click();
    await page.getByTestId("saved-scenario-delete").click();
    await page.getByTestId("saved-scenario-delete-confirm").click();
    await expect(page.getByTestId("open-dialog-empty")).toBeVisible();
  });

  test("scenario JSON export and import round trip", async ({ page }) => {
    await openLab(page, "?template=team-workspace&variant=fixed");
    await page.getByTestId("scenario-menu").click();
    const downloading = page.waitForEvent("download");
    await page.getByTestId("scenario-export").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\.scenario\.json$/);
    const text = await readFile(await download.path(), "utf8");
    expect(text).toBe(
      serializeScenario(TEMPLATES[1]?.fixed.scenario ?? TODOS_SHARING.fixed.scenario),
    );

    await page.getByTestId("template-select").selectOption("todos-sharing");
    // The variant switch stays where it was: fixed.
    await expect(page.getByTestId("scenario-title")).toHaveValue(
      TODOS_SHARING.fixed.scenario.title,
    );
    await importScenario(page, "exported.scenario.json", text);
    await expect(labRoot(page)).toHaveAttribute("data-origin", "imported");
    await expect(page.getByTestId("scenario-title")).toHaveValue(
      TEMPLATES[1]?.fixed.scenario.title ?? "",
    );

    // A file that is not a scenario is refused with a reason, and nothing changes.
    await importScenario(page, "broken.json", '{"version": 99}');
    await expect(page.getByText(/broken\.json is not a scenario/)).toBeVisible();
    await expect(labRoot(page)).toHaveAttribute("data-origin", "imported");
  });

  test("strings from the scenario and the database are rendered as text", async ({ page }) => {
    const guard = await openLab(page);
    const scenario = structuredClone(TODOS_SHARING.fixed.scenario);
    scenario.title = '<img src=x onerror="window.__xss=1">';
    const first = scenario.personas[0];
    if (first !== undefined) {
      first.label = '<b id="xss-label">bold</b>';
    }
    scenario.seedSql = `do $$ begin raise exception '<img src=x onerror="window.__xss=2">'; end $$;`;
    await importScenario(page, "hostile.scenario.json", serializeScenario(scenario));
    await expect(page.getByTestId("scenario-title")).toHaveValue(scenario.title);
    await page.getByTestId("run-button").click();
    await expectRunStatus(page, "failed");
    await expect(page.getByTestId("setup-error-message")).toContainText("<img src=x onerror=");
    await page.getByTestId("tab-personas").click();
    await expect(page.getByTestId("persona-label").first()).toHaveValue(
      '<b id="xss-label">bold</b>',
    );
    expect(await page.locator("#xss-label").count()).toBe(0);
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
    await expectCleanBrowser(guard);
  });

  test("a 200 KB schema stays editable and runnable", async ({ page }) => {
    await openLab(page);
    const scenario = structuredClone(TODOS_SHARING.fixed.scenario);
    const filler = "-- filler line: nothing to see here, only bytes for the editor to hold\n";
    scenario.schemaSql += `\n${filler.repeat(Math.floor(190_000 / filler.length))}`;
    expect(scenario.schemaSql.length).toBeGreaterThan(190_000);
    await importScenario(page, "large.scenario.json", serializeScenario(scenario));
    await expect(labRoot(page)).toHaveAttribute("data-origin", "imported");

    const content = page.locator('[data-testid="sql-editor-schema"] .cm-content');
    await content.click();
    await page.keyboard.press("ControlOrMeta+Home");
    const typedAt = Date.now();
    await page.keyboard.type("-- typed at the top");
    await expect(content.locator(".cm-line").first()).toContainText("-- typed at the top");
    expect(Date.now() - typedAt).toBeLessThan(3_000);
    // CodeMirror renders the viewport, not 2 700 lines.
    expect(await content.locator(".cm-line").count()).toBeLessThan(400);

    await page.keyboard.press("ControlOrMeta+Enter");
    await expectRunStatus(page, "done");
    await expectVerdict(page, "ISOLATED");
  });

  // The matrix is wider than a phone and scrolls inside its own box. Its cells hold `sr-only`
  // text, which is absolutely positioned: a scroll box that is not positioned lets that text
  // escape and widen the whole document. Every tab and the drawer are measured, after a run.
  test("at phone width the page never scrolls sideways; the matrix scrolls in its own box", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openLab(page);
    const documentWidths = () =>
      page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
    const expectNoSidewaysScroll = async (where: string) => {
      const widths = await documentWidths();
      expect(widths.scroll, `document scrollWidth, ${where}`).toBeLessThanOrEqual(widths.client);
    };

    await expectNoSidewaysScroll("before a run");
    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    await expectNoSidewaysScroll("after a run");
    // Positive control: the matrix really is wider than the screen, inside its scroll box.
    const matrixBox = await page.getByTestId("matrix").evaluate((table) => ({
      table: table.scrollWidth,
      box: table.parentElement?.clientWidth ?? 0,
    }));
    expect(matrixBox.table).toBeGreaterThan(matrixBox.box);

    for (const tab of ["tab-seed", "tab-personas", "tab-expectations"]) {
      await page.getByTestId(tab).click();
      await expect(page.getByTestId(tab)).toHaveAttribute("data-state", "active");
      await expectNoSidewaysScroll(tab);
    }
    await page.locator('[data-cell-id="alice|public.projects|update"]').click();
    await expect(page.getByTestId("cell-drawer")).toBeVisible();
    await expectNoSidewaysScroll("details drawer");
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`no axe violation before and after a run, ${colorScheme} theme`, async ({ page }) => {
      const guard = await openLab(page, "", colorScheme);
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`));
      await expect(page.locator(".cm-content")).toBeVisible();
      expect(await axeViolations(page), "before a run").toEqual([]);

      await runToTheEnd(page);
      await expectVerdict(page, "LEAKING");
      expect(await axeViolations(page), "after a run").toEqual([]);

      await page.locator('[data-testid="status-chip"][data-status="escape"]').click();
      expect(await axeViolations(page), "with a status filter").toEqual([]);
      await page.getByTestId("status-chip-clear").click();

      await page.getByTestId("tab-personas").click();
      await expect(page.getByTestId("persona-card").first()).toBeVisible();
      expect(await axeViolations(page), "personas tab").toEqual([]);
      await page.getByTestId("tab-expectations").click();
      await expect(page.getByTestId("table-config").first()).toBeVisible();
      expect(await axeViolations(page), "expectations tab").toEqual([]);

      await page.locator('[data-cell-id="alice|public.projects|update"]').click();
      await expect(page.getByTestId("cell-drawer")).toBeVisible();
      expect(await axeViolations(page), "details drawer").toEqual([]);
      await page.keyboard.press("Escape");

      await setEditorText(page, "schema", BROKEN_SCHEMA);
      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("setup-error")).toBeVisible();
      expect(await axeViolations(page), "setup error").toEqual([]);
      await expectCleanBrowser(guard);
    });
  }
});
