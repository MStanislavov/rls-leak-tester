/**
 * PGlite inside Next.js, in a Web Worker, with the Content Security Policy switched on (ADR 0003),
 * proven on the real lab. The same file runs against `next dev` and `next start` (see
 * playwright.config.ts); the expectations that differ are keyed on the mode.
 *
 * The landing page and the 404 page (hydration under the nonce policy, no PGlite on `/`) are
 * covered by e2e/site.spec.ts.
 */
import { expect, test, type Response } from "@playwright/test";
import {
  expectCleanBrowser,
  expectRunStatus,
  expectVerdict,
  openLab,
  runToTheEnd,
  setEditorText,
} from "./support/lab";
import { e2eMode, PageGuard, parseCsp } from "./support/page-guard";

const mode = e2eMode();

const PGLITE_ASSET = /\.(wasm|data)(\?|$)/;

/**
 * Reads the raw HTML of a document response and checks that every inline `<script>` in it
 * carries the nonce from that response's own policy. A prerendered page fails this: its scripts
 * were written at build time, when no nonce existed.
 */
async function expectEveryInlineScriptToCarryTheNonce(response: Response | null): Promise<void> {
  expect(response, "document response").not.toBeNull();
  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce, "nonce in the Content-Security-Policy header").toBeTruthy();

  const html = (await response?.text()) ?? "";
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/g)]
    .map((match) => match[1] ?? "")
    .filter((attributes) => !/\bsrc=/.test(attributes));
  expect(inlineScripts.length, "inline scripts in the document").toBeGreaterThan(0);
  for (const attributes of inlineScripts) {
    expect(attributes, "inline script attributes").toContain(`nonce="${nonce}"`);
  }
}

test.describe(`lab with PGlite in a worker (${mode})`, () => {
  test("the lab hydrates under the nonce policy and loads PGlite only when a run starts", async ({
    page,
  }) => {
    const guard = await PageGuard.attach(page);
    const response = await page.goto("/lab");
    expect(response?.status()).toBe(200);
    // Rendered for this request, not prerendered: every inline script carries its nonce.
    expect(response?.headers()["x-nextjs-prerender"]).toBeUndefined();
    await expectEveryInlineScriptToCarryTheNonce(response);

    await expect(page.getByTestId("run-button")).toBeVisible();
    await guard.waitForHydration('[data-testid="run-button"]');
    await expect(page.locator(".cm-content")).toBeVisible();
    await page.waitForLoadState("networkidle");
    // Lazy: no worker and no WASM before the first run.
    expect(guard.workers).toEqual([]);
    expect(guard.requestedUrls().filter((url) => PGLITE_ASSET.test(url))).toEqual([]);

    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    // It really is a dedicated worker, and it really fetched the WASM and the fs bundle.
    expect(guard.workers).toHaveLength(1);
    const assets = guard.requestedUrls().filter((url) => PGLITE_ASSET.test(url));
    expect(assets.some((url) => /pglite[^/]*\.wasm/.test(url))).toBe(true);
    expect(assets.some((url) => /pglite[^/]*\.data/.test(url))).toBe(true);
    await expectCleanBrowser(guard);
  });

  test("sends a strict Content-Security-Policy and the other security headers", async ({
    page,
    request,
  }) => {
    const guard = await PageGuard.attach(page);
    const response = await page.goto("/lab");
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};

    const policy = headers["content-security-policy"];
    expect(policy, "Content-Security-Policy header").toBeTruthy();
    const csp = parseCsp(policy ?? "");

    const scriptSrc = csp.get("script-src") ?? [];
    const nonces = scriptSrc.filter((source) => source.startsWith("'nonce-"));
    expect(nonces).toHaveLength(1);
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("*");
    if (mode === "prod") {
      expect(scriptSrc).toEqual(["'self'", nonces[0], "'wasm-unsafe-eval'"]);
      expect(csp.has("upgrade-insecure-requests")).toBe(true);
    } else {
      // The one documented development relaxation.
      expect(scriptSrc).toEqual(["'self'", nonces[0], "'wasm-unsafe-eval'", "'unsafe-eval'"]);
    }
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    // With no environment variables the lab talks to nobody but its own origin.
    expect(csp.get("connect-src")).toEqual(["'self'"]);

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["x-powered-by"]).toBeUndefined();

    // The nonce is per request, and the HTML carries the one from its own header.
    const nonce = nonces[0]?.slice("'nonce-".length, -1) ?? "";
    expect(await response?.text()).toContain(`nonce="${nonce}"`);
    const second = await request.get("/lab");
    const secondPolicy = second.headers()["content-security-policy"] ?? "";
    expect(secondPolicy).toContain("'nonce-");
    expect(secondPolicy).not.toBe(policy);

    // The worker script carries its own policy, which is what allows (only) WebAssembly in it.
    await expect(page.getByTestId("run-button")).toBeVisible();
    await guard.waitForHydration('[data-testid="run-button"]');
    await runToTheEnd(page);
    const workerUrl = guard.workers[0]?.url() ?? "";
    expect(workerUrl).toContain("/_next/static/");
    const workerResponse = await request.get(workerUrl);
    expect(workerResponse.status()).toBe(200);
    const workerCsp = parseCsp(workerResponse.headers()["content-security-policy"] ?? "");
    expect(workerCsp.get("script-src")).toEqual(
      mode === "prod"
        ? ["'self'", "'wasm-unsafe-eval'"]
        : ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'"],
    );
    expect(workerCsp.get("connect-src")).toEqual(["'self'"]);
    expect(workerResponse.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("every run is a fresh database on a worker of its own", async ({ page }) => {
    const guard = await openLab(page);
    // The template's schema has plain CREATE TABLE statements: on a database that survived the
    // first run, the second setup would fail with 42P07 "already exists" instead of finishing.
    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    expect(guard.workers).toHaveLength(1);
    await expect.poll(() => guard.closedWorkers.length).toBe(1);
    expect(guard.closedWorkers[0] === guard.workers[0]).toBe(true);

    await runToTheEnd(page);
    await expectVerdict(page, "LEAKING");
    await expect(page.getByTestId("setup-error")).toHaveCount(0);
    expect(guard.workers).toHaveLength(2);
    expect(guard.workers[1] === guard.workers[0], "the second worker is a new one").toBe(false);
    await expect.poll(() => guard.closedWorkers.length).toBe(2);
    expect(page.workers()).toHaveLength(0);
    await expectCleanBrowser(guard);
  });

  test("a statement that exceeds its timeout kills the worker, and a new one takes over", async ({
    page,
  }) => {
    const guard = await openLab(page, "?template=todos-sharing&variant=fixed");
    // Sleeps three times as long as the 5 s statement timeout (rules.yaml). Without the timeout
    // the statement would simply finish and the run would end in a verdict, not in this error.
    await setEditorText(page, "seed", "select pg_sleep(15);");
    await page.getByTestId("run-button").click();
    await expectRunStatus(page, "setting-up");

    const error = page.getByTestId("setup-error");
    await expect(error).toHaveAttribute("data-timed-out", "true", { timeout: 14_000 });
    const timedOutAt = Date.now();
    await expectRunStatus(page, "failed");

    // The browser itself, not only the page's bookkeeping, reports the worker as gone.
    // (Worker handles are compared by identity; they are not plain data.)
    const firstWorker = guard.workers[0];
    expect(guard.workers).toHaveLength(1);
    await expect.poll(() => guard.closedWorkers.length, { timeout: 5_000 }).toBe(1);
    expect(guard.closedWorkers[0] === firstWorker, "the closed worker is the first one").toBe(true);
    expect(page.workers()).toHaveLength(0);

    // Past the point where pg_sleep(15) would have returned had the worker lived on (it was cut
    // off after 5 s, so 10 s later at the latest): nothing from it reaches the page.
    await page.waitForTimeout(Math.max(0, 11_000 - (Date.now() - timedOutAt)));
    await expectRunStatus(page, "failed");
    await expect(error).toHaveAttribute("data-timed-out", "true");
    expect(guard.workers).toHaveLength(1);
    expect(page.workers()).toHaveLength(0);

    // A fresh worker, and with it a fresh Postgres, answers the next run.
    await setEditorText(page, "seed", "select 1;");
    await runToTheEnd(page);
    expect(guard.workers).toHaveLength(2);
    expect(guard.workers[1] === firstWorker, "the second worker is a new one").toBe(false);
    await expect.poll(() => guard.closedWorkers.length).toBe(2);
    await expectCleanBrowser(guard);
  });
});
