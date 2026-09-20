/**
 * Regions that may scroll (`src/components/site/scroll-region.tsx`): the tab stop follows the
 * layout. A region whose content overflows takes focus, so the keyboard can scroll it (WCAG 2.1.1,
 * axe `scrollable-region-focusable`); a region that shows everything is static text and stays out
 * of the tab order (Sonar S6845, jsx-a11y `no-noninteractive-tabindex`).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FAILING_CELLS, openLab, runToTheEnd } from "./support/lab";
import { e2eMode, PageGuard } from "./support/page-guard";

const mode = e2eMode();
const REGION = '[data-slot="scroll-region"]';
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 320, height: 640 };

interface RegionState {
  readonly name: string | null;
  readonly overflows: boolean;
  readonly tabindex: string | null;
}

function regionStates(page: Page): Promise<RegionState[]> {
  return page.locator(REGION).evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.getAttribute("aria-label"),
      overflows: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight,
      tabindex: node.getAttribute("tabindex"),
    })),
  );
}

/** The regions whose tab stop disagrees with their layout. Empty is the only good answer. */
function disagreeing(states: readonly RegionState[]): RegionState[] {
  return states.filter((state) => state.overflows !== (state.tabindex === "0"));
}

async function scrollableRegionViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withRules(["scrollable-region-focusable"])
    .analyze();
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => node.target.join(" ")),
  );
}

async function openDocs(page: Page): Promise<void> {
  const guard = await PageGuard.attach(page);
  await page.goto("/docs");
  await guard.waitForHydration(REGION);
}

test.describe(`scroll regions (${mode})`, () => {
  test("the server's HTML keeps every tab stop: nothing is measured before the script runs", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: WIDE });
    const page = await context.newPage();
    await page.goto("/docs");
    const states = await regionStates(page);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((state) => state.tabindex !== "0")).toEqual([]);
    await context.close();
  });

  test("/docs: a region takes a tab stop exactly while it overflows, across a resize", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await openDocs(page);
    await expect.poll(async () => disagreeing(await regionStates(page))).toEqual([]);
    const wide = await regionStates(page);
    expect(wide.filter((state) => state.tabindex === null).length).toBeGreaterThan(0);
    expect(await scrollableRegionViolations(page)).toEqual([]);

    await page.setViewportSize(NARROW);
    await expect.poll(async () => disagreeing(await regionStates(page))).toEqual([]);
    const narrow = await regionStates(page);
    expect(narrow.filter((state) => state.tabindex === "0").length).toBeGreaterThan(
      wide.filter((state) => state.tabindex === "0").length,
    );
    expect(await scrollableRegionViolations(page)).toEqual([]);
  });

  test("/docs: a focused region keeps its tab stop until the focus leaves it", async ({ page }) => {
    await page.setViewportSize(NARROW);
    await openDocs(page);
    await expect.poll(async () => disagreeing(await regionStates(page))).toEqual([]);
    const region = page.locator(`${REGION}[tabindex="0"]`).first();
    const name = await region.getAttribute("aria-label");
    await region.focus();

    await page.setViewportSize({ width: 2400, height: 800 });
    const focused = page.locator(`${REGION}:focus`);
    await expect(focused).toHaveAttribute("aria-label", name ?? "");
    await expect(focused).toHaveAttribute("tabindex", "0");

    await page.keyboard.press("Tab");
    await expect.poll(async () => disagreeing(await regionStates(page))).toEqual([]);
  });

  test("/lab: in the details drawer the long transcript takes a tab stop, a short key list does not", async ({
    page,
  }) => {
    await openLab(page, "?template=multi-tenant-saas&variant=leaky");
    await runToTheEnd(page);
    await page.locator(FAILING_CELLS).first().click();
    const drawer = page.getByTestId("cell-drawer");
    await expect(drawer).toBeVisible();

    await expect.poll(async () => disagreeing(await regionStates(page))).toEqual([]);
    const transcript = page.getByTestId("cell-drawer-sql");
    await expect(transcript).toHaveAttribute("tabindex", "0");
    // A listing is a named figure: the name is what a screen reader says when the focus lands.
    await expect(drawer.getByRole("figure", { name: "Probe SQL transcript" })).toHaveAttribute(
      "data-testid",
      "cell-drawer-sql",
    );
    const lists = drawer.locator(`ul${REGION}`);
    expect(await lists.count()).toBeGreaterThan(0);
    await expect(drawer.locator(`ul${REGION}:not([tabindex])`).first()).toBeVisible();
    expect(await scrollableRegionViolations(page)).toEqual([]);
  });
});
