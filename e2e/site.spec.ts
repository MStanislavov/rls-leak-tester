/**
 * The app shell, the landing page, /docs and the 404 page. Every route is rendered per request
 * because of the nonce CSP (ADR 0003): a page that does not hydrate still shows its text, so each
 * route is checked for hydration, not for text alone.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Response } from "@playwright/test";
import { STATIC_CHECK_RULES } from "../src/lib/checks/rules";
import { TEMPLATES } from "../src/lib/scenario/templates";
import { DOCS_SECTIONS } from "../src/lib/site/docs";
import { STATUS_META } from "../src/lib/site/status";
import { e2eMode, PageGuard } from "./support/page-guard";

const mode = e2eMode();

/** The console line Chromium prints for a document that answers 404. */
const DOCUMENT_404_CONSOLE_LINE =
  /^\[error\] Failed to load resource: the server responded with a status of 404 \(Not Found\)$/;

const PGLITE_ASSET = /\.(wasm|data)(\?|$)/;

/**
 * Strings that survive minification and exist only in code the landing page must not ship:
 * PGlite's loader, CodeMirror's view, the matrix runner, the SQL of the templates, and zod (the
 * name of its error class; about 96 KB gzip that one schema import in the header would put on
 * every route). The bodies are compared in lower case.
 */
const HEAVY_CODE_MARKERS = [
  "pglite.wasm",
  "cm-editor",
  "rls_leak_tester_source",
  "enable row level security",
  "zoderror",
];

/** Chunk names are hashes, so the check looks inside the document and every script it loaded. */
async function downloadedCode(
  guard: PageGuard,
  document: Response | null,
): Promise<{ url: string; body: string }[]> {
  const scripts = guard.responses.filter((candidate) => /\.js(\?|$)/.test(candidate.url()));
  expect(scripts.length).toBeGreaterThan(0);
  return [
    { url: document?.url() ?? "", body: ((await document?.text()) ?? "").toLowerCase() },
    ...(await Promise.all(
      scripts.map(async (script) => ({
        url: script.url(),
        body: (await script.text()).toLowerCase(),
      })),
    )),
  ];
}

async function expectCleanBrowser(guard: PageGuard): Promise<void> {
  expect(await guard.cspViolations(), "securitypolicyviolation events").toEqual([]);
  expect(guard.consoleProblems, "console errors and CSP messages").toEqual([]);
  expect(guard.pageErrors, "uncaught page errors").toEqual([]);
}

async function open(page: Page, path: string, colorScheme: "light" | "dark" = "light") {
  await page.emulateMedia({ colorScheme });
  const guard = await PageGuard.attach(page);
  const response = await page.goto(path);
  await guard.waitForHydration("h1");
  // A Client Component too: the theme buttons are only usable once React has attached to them.
  await guard.waitForHydration('[data-testid="theme-toggle"] button');
  return { guard, response };
}

test.describe(`app shell, landing page and docs (${mode})`, () => {
  for (const path of ["/", "/docs"]) {
    test(`${path} hydrates without a CSP violation or a page error`, async ({ page }) => {
      const { guard, response } = await open(page, path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["x-nextjs-prerender"]).toBeUndefined();
      expect(response?.headers()["content-security-policy"]).toContain("'nonce-");
      await page.waitForLoadState("networkidle");
      await expectCleanBrowser(guard);
    });
  }

  test("an unknown path shows the 404 page, and it hydrates", async ({ page }) => {
    const guard = await PageGuard.attach(page);
    const response = await page.goto("/no-such-page");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
    await guard.waitForHydration("h1");
    await guard.waitForHydration('[data-testid="theme-toggle"] button');
    await page.waitForLoadState("networkidle");

    // The shell is there as well, and the way back works without a full page load.
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    expect(await guard.cspViolations(), "securitypolicyviolation events").toEqual([]);
    expect(guard.pageErrors, "uncaught page errors").toEqual([]);
    expect(guard.consoleProblems.filter((line) => !DOCUMENT_404_CONSOLE_LINE.test(line))).toEqual(
      [],
    );
    await page.getByRole("link", { name: "Back to the start page" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("RLS Leak Tester");
  });

  test("the landing page stays light: no PGlite, no CodeMirror, no runner, no template SQL, no zod", async ({
    page,
  }) => {
    const { guard, response } = await open(page, "/");
    // Links to the lab are in view and get hovered; none of that may prefetch the lab.
    await page.getByTestId("template-link").first().hover();
    await page.getByRole("link", { name: "Open the lab" }).hover();
    await page.waitForLoadState("networkidle");

    const urls = guard.requestedUrls();
    expect(urls.filter((url) => PGLITE_ASSET.test(url))).toEqual([]);
    expect(urls.filter((url) => /pglite|initdb|codemirror/i.test(url))).toEqual([]);
    expect(urls.filter((url) => new URL(url).pathname.startsWith("/lab"))).toEqual([]);
    expect(guard.workers).toEqual([]);
    // No third-party origin: fonts and scripts are served by the app itself.
    const origin = new URL(page.url()).origin;
    expect(urls.filter((url) => !url.startsWith(origin) && !url.startsWith("data:"))).toEqual([]);

    for (const { url, body } of await downloadedCode(guard, response)) {
      for (const marker of HEAVY_CODE_MARKERS) {
        expect(body.includes(marker), `${url} contains "${marker}"`).toBe(false);
      }
    }
    await expectCleanBrowser(guard);
  });

  test("positive control: the same markers are found in what /lab downloads for a run", async ({
    page,
  }) => {
    const guard = await PageGuard.attach(page);
    const response = await page.goto("/lab");
    await guard.waitForHydration('[data-testid="run-button"]');
    await expect(page.locator(".cm-content").first()).toBeVisible();
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "LEAKING");
    await page.waitForLoadState("networkidle");

    const bodies = await downloadedCode(guard, response);
    for (const marker of HEAVY_CODE_MARKERS) {
      expect(
        bodies.some(({ body }) => body.includes(marker)),
        `"${marker}" is detectable in the lab's code, so its absence on / means something`,
      ).toBe(true);
    }
  });

  test("the landing page explains the product and links every template into the lab", async ({
    page,
  }) => {
    await open(page, "/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("RLS Leak Tester");
    await expect(
      page.getByRole("heading", { name: "Deterministic verdicts, the AI only explains" }),
    ).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Export the CI proof" }),
    ).toBeVisible();

    // The illustration names every status with a word, not only a colour.
    const figure = page.getByRole("figure");
    for (const { label } of STATUS_META) {
      await expect(figure.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(figure.locator("[data-status] svg").first()).toBeVisible();

    const links = page.getByTestId("template-link");
    await expect(links).toHaveCount(TEMPLATES.length);
    const hrefs = await links.evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href")),
    );
    expect(hrefs).toEqual(
      TEMPLATES.map((template) => `/lab?template=${template.id}&variant=leaky`),
    );
    for (const template of TEMPLATES) {
      await expect(
        page.getByRole("link", { name: `Try this template: ${template.title}` }),
      ).toBeVisible();
    }
  });

  test("the theme toggle switches between light, dark and system, and the choice persists", async ({
    page,
  }) => {
    const { guard } = await open(page, "/", "light");
    const html = page.locator("html");
    const button = (name: string) => page.getByRole("button", { name, exact: true });

    await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
    await expect(html).toHaveClass(/\blight\b/);
    await expect(button("System theme")).toHaveAttribute("aria-pressed", "true");

    await button("Dark theme").click();
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(button("Dark theme")).toHaveAttribute("aria-pressed", "true");
    await expect(button("System theme")).toHaveAttribute("aria-pressed", "false");
    const darkBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    // Persisted: a reload and another page still come up dark, although the system says light.
    await page.reload();
    await guard.waitForHydration('[data-testid="theme-toggle"] button');
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(button("Dark theme")).toHaveAttribute("aria-pressed", "true");
    await page.goto("/docs");
    await guard.waitForHydration('[data-testid="theme-toggle"] button');
    await expect(html).toHaveClass(/\bdark\b/);

    await button("Light theme").click();
    await expect(html).toHaveClass(/\blight\b/);
    await expect(html).not.toHaveClass(/\bdark\b/);
    const lightBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(lightBackground).not.toBe(darkBackground);

    // System follows the operating system again.
    await button("System theme").click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveClass(/\bdark\b/);
    await expectCleanBrowser(guard);
  });

  // A phone is not the target, but the page must degrade sanely: nothing may force the document
  // wider than the viewport. The hero grid did exactly that before it got an explicit column.
  for (const path of ["/", "/docs", "/no-such-page"]) {
    test(`${path} does not scroll horizontally at phone width`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(widths.scroll, "document scrollWidth").toBeLessThanOrEqual(widths.client);
    });
  }

  test("the skip link is the first stop and moves focus to the content", async ({ page }) => {
    await open(page, "/docs");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("#content")).toBeFocused();
  });

  test("the docs list every section, status and static check from the library", async ({
    page,
  }) => {
    await open(page, "/docs");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Docs");
    await expect(page).toHaveTitle("Docs | RLS Leak Tester");

    // The table of contents and the headings agree, and every entry has a target.
    const toc = page.getByRole("navigation", { name: "On this page" });
    await expect(toc.getByRole("link")).toHaveText(DOCS_SECTIONS.map((section) => section.title));
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(
      DOCS_SECTIONS.map((section) => section.title),
    );
    for (const section of DOCS_SECTIONS) {
      await expect(page.locator(`section#${section.id}`)).toHaveCount(1);
    }
    await toc.getByRole("link", { name: "Limits" }).click();
    await expect(page).toHaveURL(/#limits$/);
    await expect(page.getByRole("heading", { level: 2, name: "Limits" })).toBeInViewport();

    const statusRows = page.getByTestId("status-row");
    await expect(statusRows).toHaveCount(STATUS_META.length);
    for (const [index, meta] of STATUS_META.entries()) {
      await expect(statusRows.nth(index).locator("[data-status]")).toHaveText(meta.label);
      await expect(statusRows.nth(index).locator("[data-status] svg")).toHaveCount(1);
    }
    await expect(page.getByTestId("verdict-row")).toHaveText([
      /^ISOLATED/,
      /^LEAKING/,
      /^NOT PROVEN/,
    ]);

    const checks = page.getByTestId("static-check");
    await expect(checks).toHaveCount(STATIC_CHECK_RULES.length);
    for (const [index, rule] of STATIC_CHECK_RULES.entries()) {
      const item = checks.nth(index);
      await expect(item).toHaveAttribute("id", rule.id.toLowerCase());
      await expect(item).toContainText(rule.id);
      await expect(item.getByRole("heading", { level: 3 })).toHaveText(rule.title);
      await expect(item.locator("[data-severity]")).toHaveAttribute("data-severity", rule.severity);
      await expect(item.getByRole("link")).toHaveAttribute("href", rule.docsUrl);
    }

    // The statements the brief wants said in so many words.
    const threatModel = page.locator("section#threat-model");
    await expect(threatModel).toContainText("The server never executes user SQL");
    await expect(threatModel).toContainText("only when you ask for it");
    await expect(page.locator("section#outcomes")).toContainText("42501");
    await expect(page.locator("section#supabase-mode")).toContainText("2026-10-30");
  });

  for (const path of ["/", "/docs"]) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`${path} has no axe violation in the ${colorScheme} theme`, async ({ page }) => {
        await open(page, path, colorScheme);
        await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`));
        const results = await new AxeBuilder({ page }).analyze();
        expect(
          results.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            nodes: violation.nodes.map((node) => node.target.join(" ")),
          })),
        ).toEqual([]);
        // Guards against an empty scan: colour contrast was really evaluated.
        expect(results.passes.map((pass) => pass.id)).toContain("color-contrast");
      });
    }
  }
});
