/**
 * Explain and the verified-fix loop, end to end, in Chromium. `/api/health` and `/api/explain` are
 * intercepted: no model is called (rules.yaml TEST-001) and the answers use the endpoint's real
 * wire format (ADR 0018: `200 text/plain` whose body is the JSON text of one explanation, or a
 * JSON error with `Retry-After`). What is NOT faked is the part that decides: the matrix is really
 * re-run in PGlite with the canned SQL, so "Verified fix" is the engine's word, not the fixture's.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { explainRequestSchema, type Explanation } from "../src/lib/ai/schema";
import { FIX_COMMENT } from "../src/lib/lab/verify-fix";
import { expectCleanBrowser, expectVerdict, labRoot, openLab, runToTheEnd } from "./support/lab";
import { e2eMode } from "./support/page-guard";

const mode = e2eMode();

const LEAKY_LAB = "?template=multi-tenant-saas&variant=leaky";
const ESCAPING_CELL = "alice|public.projects|update";
const PASSING_CELL = "alice|public.projects|select";

/** What the fixed variant of the template does: WITH CHECK repeats USING. */
const REAL_FIX_SQL = `drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());`;

/** Re-creates the policy with the bug still in it. */
const WRONG_FIX_SQL = `drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (true);`;

/** Model text is text: markup in it must show up as characters. */
const MARKUP = '<img src=x onerror="document.title=1"><b>bold</b>';

function explanationWith(proposedPolicySql: string): Explanation {
  return {
    explanation: `The UPDATE policy projects_update checks the old row only. ${MARKUP}\n\nWITH CHECK (true) accepts any new row, so a member can set tenant_id to another tenant.`,
    rootCause: "projects_update has WITH CHECK (true).",
    proposedPolicySql,
    confidence: "high",
  };
}

const RATE_LIMIT_HEADERS = {
  "RateLimit-Limit": "5",
  "RateLimit-Remaining": "4",
  "RateLimit-Reset": "60",
  "RateLimit-Policy": '"explain";q=5;w=60',
  RateLimit: '"explain";r=4;t=60',
};

async function mockHealth(page: Page, explain: boolean): Promise<void> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        status: "ok",
        buildId: "e2e",
        features: { explain, redis: false, supabase: false },
      }),
    }),
  );
}

function fulfillExplanation(route: Route, explanation: Explanation): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Explain-Cache": "miss",
      ...RATE_LIMIT_HEADERS,
    },
    body: JSON.stringify(explanation),
  });
}

async function openFailingCell(page: Page): Promise<void> {
  await runToTheEnd(page);
  await expectVerdict(page, "LEAKING");
  await page.locator(`[data-cell-id="${ESCAPING_CELL}"]`).click();
  await expect(page.getByTestId("cell-drawer")).toBeVisible();
}

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

test.describe(`lab explain (${mode})`, () => {
  test("not configured: a calm notice instead of the button, and nothing is sent", async ({
    page,
  }) => {
    await mockHealth(page, false);
    const posts: string[] = [];
    await page.route("**/api/explain", (route) => {
      posts.push(route.request().method());
      return route.abort();
    });
    const guard = await openLab(page, LEAKY_LAB);
    await openFailingCell(page);

    const notice = page.getByTestId("explain-off-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("AI explanations are off");
    await expect(notice).toContainText("ANTHROPIC_API_KEY");
    await expect(notice).toContainText("Everything else works without it");
    await expect(notice).toHaveAttribute("role", "note");
    await expect(page.getByTestId("explain-button")).toHaveCount(0);
    expect(await axeViolations(page), "drawer with the notice").toEqual([]);

    // A cell that passed has nothing to explain: no panel at all.
    await page.keyboard.press("Escape");
    await page.locator(`[data-cell-id="${PASSING_CELL}"]`).click();
    await expect(page.getByTestId("cell-drawer")).toBeVisible();
    await expect(page.getByTestId("explain-panel")).toHaveCount(0);

    expect(posts).toEqual([]);
    await expectCleanBrowser(guard);
  });

  test("a fix that works: proposed, re-run, Verified fix, applied on a click", async ({ page }) => {
    // Three full matrix runs (the user's, the re-run, the user's again) beside the other workers.
    test.slow();
    await mockHealth(page, true);
    const bodies: string[] = [];
    await page.route("**/api/explain", async (route) => {
      bodies.push(route.request().postData() ?? "");
      await fulfillExplanation(route, explanationWith(REAL_FIX_SQL));
    });
    const guard = await openLab(page, LEAKY_LAB);
    await openFailingCell(page);

    // Before the click nothing was sent, and what will be sent can be read.
    await expect(page.getByTestId("explain-button")).toBeVisible();
    await expect(page.getByTestId("explain-off-notice")).toHaveCount(0);
    await page.getByTestId("explain-payload").locator("summary").click();
    const shown = await page.getByTestId("explain-payload-json").innerText();
    expect(await axeViolations(page), "drawer with the button and the payload").toEqual([]);
    expect(bodies).toEqual([]);

    await page.getByTestId("explain-button").click();

    // The answer is there at once; the SQL is a proposal until the re-run has spoken.
    const label = page.getByTestId("fix-label");
    await expect(page.locator('[data-testid="fix-label"][data-fix-status="verifying"]')).toHaveText(
      "Proposed (not yet verified)",
    );
    await expect(page.getByTestId("explain-root-cause")).toHaveText(
      "projects_update has WITH CHECK (true).",
    );
    await expect(page.getByTestId("explain-sql")).toHaveText(REAL_FIX_SQL);
    await expect(page.getByTestId("explain-confidence")).toHaveAttribute("data-confidence", "high");
    // Model text is rendered as text (SEC-001).
    await expect(page.getByTestId("explain-explanation")).toContainText(MARKUP);
    await expect(page.getByTestId("explain-panel").locator("img, b")).toHaveCount(0);

    // Exactly one request, exactly what was shown, valid, and without a byte of seed data.
    expect(bodies).toHaveLength(1);
    const sent: unknown = JSON.parse(bodies[0] ?? "");
    expect(sent).toEqual(JSON.parse(shown));
    const parsed = explainRequestSchema.safeParse(sent);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.cell.status : "").toBe("escape");
    expect(parsed.success ? parsed.data.table.name : "").toBe("projects");
    for (const seedValue of [
      "Website relaunch",
      "Acme Corp",
      "bob@example.com",
      "insert into",
      "seedSql",
    ]) {
      expect(bodies[0]).not.toContain(seedValue);
    }

    // The engine re-ran the matrix with the SQL: now, and only now, it is a verified fix.
    await expect(label).toHaveAttribute("data-fix-status", "verified");
    await expect(label).toHaveText("Verified fix");
    await expect(page.getByTestId("fix-verdict-after")).toHaveText("ISOLATED");
    await expect(
      page.locator('[data-testid="fix-fixed"] [data-testid="fix-cell"]'),
    ).toHaveAttribute("data-cell-id", ESCAPING_CELL);
    await expect(page.getByTestId("fix-also-fixed")).toHaveAttribute("data-count", "2");
    await expect(page.getByTestId("explain-announcement")).toContainText("Verified fix");
    expect(await axeViolations(page), "drawer with a verified fix").toEqual([]);

    // Verifying touched nothing: the scenario is as it was, the verdict on screen too.
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "false");
    await expectVerdict(page, "LEAKING");

    await page.getByTestId("fix-apply").click();
    await expect(page.getByTestId("fix-applied")).toBeVisible();
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "true");
    await expect(page.getByTestId("explain-stale-notice")).toBeVisible();
    await expect(page.getByTestId("fix-apply")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("cell-drawer")).toHaveCount(0);
    await expect(page.getByTestId("tab-schema")).toHaveAttribute("data-state", "active");
    const editor = page.locator('[data-testid="sql-editor-schema"] .cm-content');
    await expect(editor).toContainText(FIX_COMMENT);
    await expect(page.getByTestId("result-stale")).toBeVisible();

    // The user's own run confirms it.
    await runToTheEnd(page);
    await expectVerdict(page, "ISOLATED");
    expect(bodies).toHaveLength(1);
    await expectCleanBrowser(guard);
  });

  test("a fix that does not work: Proposed fix did not pass, with the cells", async ({ page }) => {
    await mockHealth(page, true);
    await page.route("**/api/explain", (route) =>
      fulfillExplanation(route, explanationWith(WRONG_FIX_SQL)),
    );
    // Dark theme here, light in the other tests: the axe scans cover both.
    const guard = await openLab(page, LEAKY_LAB, "dark");
    await openFailingCell(page);
    await page.getByTestId("explain-button").click();

    const label = page.getByTestId("fix-label");
    await expect(label).toHaveAttribute("data-fix-status", "did-not-pass");
    await expect(label).toHaveText("Proposed fix did not pass");
    const still = page.locator('[data-testid="fix-still-failing"] [data-testid="fix-cell"]');
    await expect(still).toHaveCount(1);
    await expect(still).toHaveAttribute("data-cell-id", ESCAPING_CELL);
    await expect(still).toHaveAttribute("data-after", "escape");
    await expect(still).toContainText("UPDATE public.projects as alice");
    await expect(still).toContainText("was escape, still escape");
    await expect(page.getByTestId("fix-regressed")).toHaveCount(0);

    // Never presented as a fix, and there is nothing to apply.
    await expect(page.getByTestId("explain-panel")).not.toContainText("Verified fix");
    await expect(page.getByTestId("fix-apply")).toHaveCount(0);
    await expect(page.getByTestId("fix-verify")).toHaveCount(0);
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "false");
    expect(await axeViolations(page), "drawer with a refused fix").toEqual([]);

    // Closing and reopening the cell costs no second request: the outcome is still there.
    await page.keyboard.press("Escape");
    await page.locator(`[data-cell-id="${ESCAPING_CELL}"]`).click();
    await expect(label).toHaveAttribute("data-fix-status", "did-not-pass");
    await expectCleanBrowser(guard);
  });

  test("SQL that does not apply: the setup error, and no fix", async ({ page }) => {
    await mockHealth(page, true);
    await page.route("**/api/explain", (route) =>
      fulfillExplanation(
        route,
        explanationWith("drop policy projects_update on public.no_such_table;"),
      ),
    );
    const guard = await openLab(page, LEAKY_LAB);
    await openFailingCell(page);
    await page.getByTestId("explain-button").click();

    await expect(page.getByTestId("fix-label")).toHaveText("Proposed fix did not pass");
    await expect(page.getByTestId("fix-setup-error")).toHaveAttribute("data-sqlstate", "42P01");
    await expect(page.getByTestId("fix-setup-error")).toContainText("no_such_table");
    await expect(page.getByTestId("fix-apply")).toHaveCount(0);
    // The lab's own state has no setup error: the re-run was isolated.
    await expect(page.getByTestId("setup-error")).toHaveCount(0);
    await expectVerdict(page, "LEAKING");
    await expectCleanBrowser(guard);
  });

  test("429: says when to try again, and the next try works", async ({ page }) => {
    await mockHealth(page, true);
    let calls = 0;
    await page.route("**/api/explain", async (route) => {
      calls += 1;
      if (calls > 1) {
        await fulfillExplanation(route, explanationWith(REAL_FIX_SQL));
        return;
      }
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "42",
          ...RATE_LIMIT_HEADERS,
          "RateLimit-Remaining": "0",
          RateLimit: '"explain";r=0;t=42',
        },
        body: JSON.stringify({
          error: {
            code: "rate_limited",
            message: "Too many explanations requested. Wait a moment and try again.",
          },
        }),
      });
    });
    const guard = await openLab(page, LEAKY_LAB);
    await openFailingCell(page);
    await page.getByTestId("explain-button").click();

    const error = page.getByTestId("explain-error");
    await expect(error).toHaveAttribute("data-code", "rate_limited");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toContainText("Too many explanations requested");
    await expect(error).toContainText("Try again in 42 seconds.");
    await expect(page.getByTestId("explain-answer")).toHaveCount(0);
    await expect(page.getByTestId("explain-button")).toHaveText("Try again");
    expect(await axeViolations(page), "drawer with the rate limit message").toEqual([]);

    await page.getByTestId("explain-button").click();
    await expect(page.getByTestId("explain-root-cause")).toBeVisible();
    await expect(page.getByTestId("explain-error")).toHaveCount(0);
    expect(calls).toBe(2);

    // The browser logs the 429 itself; nothing else may be wrong.
    expect(guard.consoleProblems.filter((line) => !line.includes("429"))).toEqual([]);
    expect(guard.pageErrors).toEqual([]);
    expect(await guard.cspViolations()).toEqual([]);
  });
});
