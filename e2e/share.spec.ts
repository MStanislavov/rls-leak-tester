/**
 * Sharing, end to end (brief 3.3, 3.10, 4.7, 4.8).
 *
 * The test server runs WITHOUT the Supabase variables, which is the default deployment: Share is
 * marked unavailable and says why, there is no sign-in, and `/s/<slug>` explains that sharing is
 * not enabled. That part is tested against the real server.
 *
 * A deployment WITH Supabase is simulated in the browser: `/api/health` and `/api/scenarios*` are
 * intercepted and answered with canned payloads in the wire format of `@/lib/store`. That covers
 * the Share dialog, the read-only lab on `/s/<slug>`, running somebody else's SQL in this tab and
 * "Fork to my lab". It does NOT cover the server-side load of `/s/[slug]` (session, row level
 * security, read-through cache): that path is covered by `tests/api/scenarios*.test.ts`,
 * `tests/store/*` and `src/lib/lab/share-page.test.ts`. Sign-in itself needs a real Supabase
 * project and is not tested here (rules.yaml FA-1).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { TODOS_SHARING } from "../src/lib/scenario/templates";
import {
  expectCleanBrowser,
  expectVerdict,
  failingCells,
  labRoot,
  openLab,
  runToTheEnd,
} from "./support/lab";
import { PageGuard, e2eMode } from "./support/page-guard";

const mode = e2eMode();

const EXPLANATION = "Sharing needs a Supabase project: see docs/DEPLOY.md; local save works.";
const NOTICE =
  "This scenario was shared by someone else. Its SQL runs only inside your browser's sandboxed Postgres; it has no network access.";

const SLUG = "todos-shared-abcdefghijklmnop";
const SHARED_ID = "00000000-0000-4000-8000-0000000000a1";
const OLDER_ID = "00000000-0000-4000-8000-0000000000a2";
const SHARED_SCENARIO = TODOS_SHARING.leaky.scenario;

function storedScenario(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARED_ID,
    slug: SLUG,
    title: SHARED_SCENARIO.title,
    visibility: "public",
    updatedAt: "2026-09-20T10:00:00.000Z",
    scenario: SHARED_SCENARIO,
    ownedByMe: false,
    ...overrides,
  };
}

const OLDER_SUMMARY = {
  id: OLDER_ID,
  slug: "an-older-share-abcdefghijklmnop",
  title: "An older share",
  visibility: "unlisted",
  updatedAt: "2026-09-19T08:00:00.000Z",
};

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.map((pass) => pass.id)).toContain("color-contrast");
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

/** `/api/health` of a deployment that has Supabase. Booleans only, like the real one. */
async function simulateSharingEnabled(page: Page): Promise<void> {
  await page.route("**/api/health", (route) =>
    json(route, 200, {
      status: "ok",
      buildId: "e2e",
      features: { explain: false, redis: false, supabase: true },
    }),
  );
}

async function openShared(page: Page, slug: string): Promise<PageGuard> {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const guard = await PageGuard.attach(page);
  await page.goto(`/s/${slug}`);
  return guard;
}

test.describe(`sharing without Supabase, the default (${mode})`, () => {
  test("Share is visible, marked unavailable and explains why; nothing else changes", async ({
    page,
  }) => {
    const guard = await openLab(page);
    const share = page.getByTestId("share-button");
    await expect(share).toBeVisible();
    await expect(share).toHaveAttribute("data-availability", "disabled");
    await expect(share).toHaveAttribute("aria-disabled", "true");
    await expect(share).toBeDisabled();
    await expect(share).toHaveAccessibleDescription(EXPLANATION);

    // No sign-in without Supabase.
    await expect(page.getByTestId("sign-in-button")).toHaveCount(0);
    await expect(page.getByTestId("auth-controls")).toHaveCount(0);

    // The keyboard reaches the explanation: focus shows the tooltip.
    await share.focus();
    await expect(page.getByTestId("share-disabled-tooltip")).toContainText(EXPLANATION);
    await page.keyboard.press("Escape");

    // It is aria-disabled, not disabled: Enter still opens the explanation. (Playwright's own
    // click refuses an aria-disabled element, so the mouse path is dispatched directly.)
    await share.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("share-disabled-dialog")).toBeVisible();
    await expect(page.getByTestId("share-disabled-text")).toHaveText(EXPLANATION);
    expect(await axeViolations(page), "the explanation dialog").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-disabled-dialog")).toBeHidden();
    await share.dispatchEvent("click");
    await expect(page.getByTestId("share-disabled-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-disabled-dialog")).toBeHidden();

    // The lab is unaffected: no scenarios API call was made, and a run works.
    expect(guard.requestedUrls().filter((url) => url.includes("/api/scenarios"))).toEqual([]);
    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    expect(await axeViolations(page), "the lab with the Share button").toEqual([]);
    await expectCleanBrowser(guard);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`/s/<slug> is a 200 that says sharing is not enabled, hydrates under the CSP, ${colorScheme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const guard = await PageGuard.attach(page);
      const response = await page.goto(`/s/${SLUG}`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toContain("script-src");

      // The failure view only exists in the browser half: seeing it proves hydration.
      const failure = page.getByTestId("shared-failure");
      await expect(failure).toHaveAttribute("data-reason", "not_configured");
      await expect(failure.getByRole("heading", { level: 1 })).toHaveText(
        "Sharing is not enabled on this deployment",
      );
      await guard.waitForHydration('[data-testid="shared-failure"]');
      await expect(page).toHaveTitle(/^Shared scenario \| /);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

      // The scenarios API is not asked on a deployment that does not share.
      expect(guard.requestedUrls().filter((url) => url.includes("/api/scenarios"))).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
      await expectCleanBrowser(guard);

      await failure.getByRole("link", { name: "Open the lab" }).click();
      await expect(page.getByTestId("run-button")).toBeVisible();
    });
  }

  test("a malformed slug is a 404 before anything is looked up", async ({ page }) => {
    for (const path of ["/s/Not_A_Slug", "/s/ab", `/s/${"a".repeat(65)}`, "/s/a--b"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
    }
  });
});

test.describe(`sharing with Supabase, simulated in the browser (${mode})`, () => {
  test("a shared scenario opens read-only, runs in this tab, and forks into the local store", async ({
    page,
  }) => {
    await simulateSharingEnabled(page);
    await page.route(`**/api/scenarios/by-slug/${SLUG}`, (route) =>
      json(route, 200, { scenario: storedScenario() }),
    );
    const guard = await openShared(page, SLUG);

    await expect(labRoot(page)).toHaveAttribute("data-read-only", "true");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Shared scenario, read-only");
    await expect(page.getByTestId("shared-notice")).toContainText(NOTICE);
    await expect(page.getByTestId("shared-notice")).toHaveAttribute("data-owned", "false");

    // Nothing that edits, saves or replaces the scenario is offered.
    const title = page.getByTestId("scenario-title");
    await expect(title).toHaveValue(SHARED_SCENARIO.title);
    await expect(title).not.toBeEditable();
    for (const absent of ["scenario-menu", "scenario-save", "template-select", "share-button"]) {
      await expect(page.getByTestId(absent), absent).toHaveCount(0);
    }
    await expect(page.getByTestId("mode-select")).toBeDisabled();
    await expect(page.getByTestId("grants-select")).toBeDisabled();

    // The editor shows the SQL, takes the focus, and ignores typing.
    const schema = page.locator('[data-testid="sql-editor-schema"] .cm-content');
    await expect(schema).toHaveAttribute("aria-readonly", "true");
    const before = await schema.innerText();
    expect(before).toContain("create table");
    await schema.click();
    await page.keyboard.type("drop table everything;");
    await page.keyboard.press("Backspace");
    expect(await schema.innerText()).toBe(before);

    await page.getByTestId("tab-personas").click();
    await expect(page.getByTestId("persona-label").first()).toBeDisabled();
    await expect(page.getByTestId("persona-add")).toBeDisabled();
    expect(await axeViolations(page), "read-only personas").toEqual([]);
    await page.getByTestId("tab-expectations").click();
    await expect(page.getByTestId("introspect-button")).toBeDisabled();
    expect(await axeViolations(page), "read-only lab before a run").toEqual([]);

    // Somebody else's SQL runs here, in this tab's sandboxed Postgres, and leaks as declared.
    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    expect(await failingCells(page)).toEqual(TODOS_SHARING.leaky.expectedFailures);
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "false");
    expect(await axeViolations(page), "read-only lab after a run").toEqual([]);
    // No SQL left the browser: the only API calls were health and the by-slug read.
    const apiCalls = guard
      .requestedUrls()
      .map((url) => new URL(url).pathname)
      .filter((path) => path.startsWith("/api/"));
    expect([...new Set(apiCalls)].sort()).toEqual([
      "/api/health",
      `/api/scenarios/by-slug/${SLUG}`,
    ]);

    // Fork: a copy with a new id in THIS browser's store, opened by the lab.
    await page.getByTestId("fork-button").click();
    await expect(page).toHaveURL(/\/lab\?saved=[a-z0-9-]+$/);
    await expect(labRoot(page)).toHaveAttribute("data-origin", "saved");
    await expect(labRoot(page)).toHaveAttribute("data-read-only", "false");
    await expect(page.getByTestId("scenario-title")).toHaveValue(SHARED_SCENARIO.title);
    await expect(page.getByTestId("scenario-title")).toBeEditable();

    const forkedId = new URL(page.url()).searchParams.get("saved") ?? "";
    expect(forkedId).not.toBe(SHARED_SCENARIO.id);
    const entry = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      `rls-leak-tester:v1:scenario:${forkedId}`,
    );
    const parsed = JSON.parse(entry ?? "null") as { id: string; scenario: { id: string } } | null;
    expect(parsed).toMatchObject({
      id: forkedId,
      scenario: { title: SHARED_SCENARIO.title, schemaSql: SHARED_SCENARIO.schemaSql },
    });
    // A copy of its own: neither the store entry nor the scenario keeps the shared id.
    expect(parsed?.scenario.id).not.toBe(SHARED_SCENARIO.id);

    // The fork is a scenario of the visitor's own: it runs, and it can be edited.
    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    await page.getByTestId("scenario-title").fill("My fork");
    await expect(labRoot(page)).toHaveAttribute("data-dirty", "true");
    await expectCleanBrowser(guard);
  });

  test("the owner of a shared scenario is told it is theirs", async ({ page }) => {
    await simulateSharingEnabled(page);
    await page.route(`**/api/scenarios/by-slug/${SLUG}`, (route) =>
      json(route, 200, { scenario: storedScenario({ ownedByMe: true, visibility: "private" }) }),
    );
    await openShared(page, SLUG);
    const notice = page.getByTestId("shared-notice");
    await expect(notice).toHaveAttribute("data-owned", "true");
    await expect(notice).toContainText("You shared this scenario.");
    await expect(notice).toContainText("it has no network access");
  });

  test("a slug the API does not know, and a payload that is no scenario, show a reason", async ({
    page,
  }) => {
    await simulateSharingEnabled(page);
    await page.route("**/api/scenarios/by-slug/*", (route) =>
      route.request().url().endsWith("/gone-abcdefghijklmnop")
        ? json(route, 404, { error: { code: "not_found", message: "There is no such scenario." } })
        : json(route, 200, { scenario: storedScenario({ scenario: { version: 99 } }) }),
    );
    const guard = await openShared(page, "gone-abcdefghijklmnop");
    await expect(page.getByTestId("shared-failure")).toHaveAttribute("data-reason", "not_found");
    expect(await guard.cspViolations()).toEqual([]);

    // A scenario that does not pass `parseScenario` is never handed to the lab.
    await page.goto(`/s/${SLUG}`);
    await expect(page.getByTestId("shared-failure")).toHaveAttribute("data-reason", "unavailable");
    await expect(page.getByTestId("lab-root")).toHaveCount(0);
    await expect(page.getByTestId("shared-retry")).toBeVisible();
  });

  test("Share dialog, signed in: create a link, copy it, change visibility, delete", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await simulateSharingEnabled(page);

    const calls: { method: string; path: string; body: unknown }[] = [];
    const mine = [OLDER_SUMMARY];
    await page.route("**/api/scenarios", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as { scenario: { title: string }; visibility: string };
        calls.push({ method: "POST", path: "/api/scenarios", body });
        const created = storedScenario({
          ownedByMe: true,
          visibility: body.visibility,
          title: body.scenario.title,
          scenario: body.scenario,
        });
        return json(route, 201, { scenario: created });
      }
      return json(route, 200, { scenarios: mine });
    });
    await page.route("**/api/scenarios/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "DELETE") {
        calls.push({ method: "DELETE", path, body: null });
        return route.fulfill({ status: 204, body: "" });
      }
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as { visibility: string };
        calls.push({ method: "PATCH", path, body });
        return json(route, 200, {
          scenario: storedScenario({
            ...OLDER_SUMMARY,
            ownedByMe: true,
            visibility: body.visibility,
          }),
        });
      }
      return json(route, 200, {
        scenario: storedScenario({ ...OLDER_SUMMARY, ownedByMe: true }),
      });
    });

    const guard = await openLab(page, "?template=todos-sharing&variant=leaky");
    const share = page.getByTestId("share-button");
    await expect(share).toHaveAttribute("data-availability", "enabled");
    await expect(share).toBeEnabled();
    await share.click();

    const dialog = page.getByTestId("share-dialog");
    await expect(dialog).toHaveAttribute("data-session", "signed-in");
    await expect(page.getByTestId("shared-scenario")).toHaveCount(1);
    await expect(page.getByTestId("share-visibility-unlisted")).toBeChecked();
    expect(await axeViolations(page), "share dialog").toEqual([]);

    // Create a public link for the working scenario.
    await page.getByTestId("share-visibility-public").check();
    await page.getByTestId("share-submit").click();
    const link = page.getByTestId("share-link");
    await expect(link).toHaveValue(new RegExp(`^http://localhost:\\d+/s/${SLUG}$`));
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({
      visibility: "public",
      scenario: { title: SHARED_SCENARIO.title, schemaSql: SHARED_SCENARIO.schemaSql },
    });
    // The body carries nothing the server must decide: no slug, id or owner.
    expect(Object.keys(post?.body as object).sort()).toEqual(["scenario", "visibility"]);
    await expect(page.getByTestId("shared-scenario")).toHaveCount(2);
    await expect(page.getByTestId("share-submit")).toHaveText(/Update the shared copy/);

    await page.getByTestId("share-link-copy").click();
    await expect(page.getByTestId("share-link-copy")).toHaveAttribute("data-copied", "true");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.inputValue());
    expect(await axeViolations(page), "share dialog with a link").toEqual([]);

    // Visibility of an older share: read, then written back with the new visibility.
    const older = page.locator(
      `[data-testid="shared-scenario"][data-slug="${OLDER_SUMMARY.slug}"]`,
    );
    await older.getByTestId("shared-scenario-visibility").selectOption("private");
    await expect(older).toHaveAttribute("data-visibility", "private");
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.path).toBe(`/api/scenarios/${OLDER_ID}`);
    expect(patch?.body).toMatchObject({ visibility: "private" });

    // Delete asks first.
    await older.getByTestId("shared-scenario-delete").click();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await older.getByTestId("shared-scenario-delete-confirm").click();
    await expect(older).toHaveCount(0);
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe(`/api/scenarios/${OLDER_ID}`);
    await expectCleanBrowser(guard);
  });

  test("Share dialog, signed out: asks for GitHub sign-in and sends nothing", async ({ page }) => {
    await simulateSharingEnabled(page);
    const writes: string[] = [];
    await page.route("**/api/scenarios", (route) => {
      if (route.request().method() !== "GET") {
        writes.push(route.request().method());
      }
      return json(route, 401, {
        error: { code: "unauthenticated", message: "Sign in to do this." },
      });
    });
    const guard = await openLab(page);
    await expect(page.getByTestId("share-button")).toHaveAttribute("data-availability", "enabled");
    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("share-dialog")).toHaveAttribute("data-session", "signed-out");
    await expect(page.getByTestId("share-signed-out")).toContainText("Sign in with GitHub");
    // This build has no public Supabase variables, so the button says so instead of failing.
    await expect(page.getByTestId("share-sign-in")).toBeDisabled();
    await expect(page.getByTestId("share-submit")).toHaveCount(0);
    expect(await axeViolations(page), "signed-out share dialog").toEqual([]);
    expect(writes).toEqual([]);
    // The intercepted 401 is logged by the browser as a failed resource; nothing else may be.
    expect(await guard.cspViolations()).toEqual([]);
    expect(guard.pageErrors).toEqual([]);
  });
});
