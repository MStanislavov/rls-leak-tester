/**
 * Spike B: PGlite inside Next.js, in a Web Worker, with the Content Security
 * Policy switched on. The same file runs against `next dev` and `next start`
 * (see playwright.config.ts); the expectations that differ are keyed on the mode.
 */
import { expect, test, type Page, type Response } from "@playwright/test";
import { e2eMode, PageGuard, parseCsp } from "./support/page-guard";

const mode = e2eMode();

const PGLITE_ASSET = /\.(wasm|data)(\?|$)/;

/** The console line Chromium prints for a document that answers 404. */
const DOCUMENT_404_CONSOLE_LINE =
  /^\[error\] Failed to load resource: the server responded with a status of 404 \(Not Found\)$/;

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

async function waitForProof(page: Page): Promise<void> {
  await expect(page.getByTestId("lab-status")).toHaveAttribute("data-status", "done");
}

async function expectCleanBrowser(guard: PageGuard): Promise<void> {
  expect(await guard.cspViolations(), "securitypolicyviolation events").toEqual([]);
  expect(guard.consoleProblems, "console errors and CSP messages").toEqual([]);
  expect(guard.pageErrors, "uncaught page errors").toEqual([]);
}

test.describe(`lab with PGlite in a worker (${mode})`, () => {
  test("runs Postgres with RLS in a worker and renders the result as text", async ({
    page,
  }, testInfo) => {
    const guard = await PageGuard.attach(page);
    await page.goto("/lab");
    await waitForProof(page);

    await expect(page.getByTestId("lab-version")).toContainText("PostgreSQL");
    await expect(page.getByTestId("lab-total-rows")).toHaveText("3");
    await expect(page.getByTestId("lab-acting-role")).toHaveText("spike_app_user");
    await expect(page.getByTestId("lab-visible-count")).toHaveText("2");
    await expect(page.getByTestId("lab-visible-row")).toHaveText([
      "1 alice alice note one",
      "3 alice alice note two",
    ]);
    await expect(page.getByTestId("lab-generation")).toHaveText("1");

    // It really is a dedicated worker, and it really fetched the WASM and the fs bundle.
    expect(guard.workers).toHaveLength(1);
    const assets = guard.requestedUrls().filter((url) => PGLITE_ASSET.test(url));
    expect(assets.some((url) => /pglite[^/]*\.wasm/.test(url))).toBe(true);
    expect(assets.some((url) => /pglite[^/]*\.data/.test(url))).toBe(true);

    await expectCleanBrowser(guard);

    const workerStartupMs = Number(await page.getByTestId("lab-worker-startup-ms").textContent());
    const totalMs = Number(await page.getByTestId("lab-total-ms").textContent());
    expect(workerStartupMs).toBeGreaterThan(0);
    testInfo.annotations.push({
      type: "pglite-cold-start",
      description: `mode=${mode} workerStartupMs=${workerStartupMs} pageTotalMs=${totalMs}`,
    });
    console.log(`[spike-b] mode=${mode} workerStartupMs=${workerStartupMs} pageTotalMs=${totalMs}`);
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
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);

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

    // Other kinds of response carry the headers too: the landing page, a 404, and the
    // worker script, whose own policy is what allows (only) WebAssembly inside the worker.
    for (const path of ["/", "/this-page-does-not-exist"]) {
      const other = await request.get(path);
      expect(other.headers()["content-security-policy"], path).toContain("'nonce-");
      expect(other.headers()["x-content-type-options"], path).toBe("nosniff");
      expect(other.headers()["x-frame-options"], path).toBe("DENY");
    }

    await waitForProof(page);
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

  test("the landing page loads no PGlite asset, worker or code", async ({ page }) => {
    const guard = await PageGuard.attach(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("RLS Leak Tester");
    // Hydrated first: a page whose scripts were blocked would request nothing and pass for the
    // wrong reason.
    await guard.waitForHydration("h1");
    await page.waitForLoadState("networkidle");

    const urls = guard.requestedUrls();
    expect(urls.filter((url) => PGLITE_ASSET.test(url))).toEqual([]);
    expect(urls.filter((url) => /pglite|initdb/i.test(url))).toEqual([]);
    expect(guard.workers).toEqual([]);

    // Chunk names are hashes, so look inside every script the landing page fetched.
    const scripts = guard.responses.filter((response) => /\.js(\?|$)/.test(response.url()));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const body = await script.text();
      expect(body.includes("pglite.wasm"), `${script.url()} contains PGlite`).toBe(false);
    }
  });

  // Needs every page to render dynamically so the nonce reaches the HTML. The root layout
  // awaits connection() for that (src/app/layout.tsx), which covers the 404 page as well.
  test("the landing page hydrates without a CSP violation or a page error", async ({ page }) => {
    const guard = await PageGuard.attach(page);
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("RLS Leak Tester");

    // Rendered for this request, not prerendered: every inline script carries the nonce of
    // its own response.
    expect(response?.headers()["x-nextjs-prerender"]).toBeUndefined();
    await expectEveryInlineScriptToCarryTheNonce(response);

    await guard.waitForHydration("h1");
    await page.waitForLoadState("networkidle");
    await expectCleanBrowser(guard);
  });

  test("the 404 page hydrates without a CSP violation or a page error", async ({ page }) => {
    const guard = await PageGuard.attach(page);
    const response = await page.goto("/this-page-does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");

    expect(response?.headers()["x-nextjs-prerender"]).toBeUndefined();
    await expectEveryInlineScriptToCarryTheNonce(response);

    await guard.waitForHydration("h1");
    await page.waitForLoadState("networkidle");

    expect(await guard.cspViolations(), "securitypolicyviolation events").toEqual([]);
    expect(guard.pageErrors, "uncaught page errors").toEqual([]);
    // Chromium reports the 404 status of the document itself as a console error. That one
    // line is expected; anything else, and any line about the policy, is not.
    expect(guard.consoleProblems.filter((line) => !DOCUMENT_404_CONSOLE_LINE.test(line))).toEqual(
      [],
    );
  });

  test("a query that exceeds its timeout kills the worker, and a new one takes over", async ({
    page,
  }) => {
    const guard = await PageGuard.attach(page);
    await page.goto("/lab");
    await waitForProof(page);
    await expect(page.getByTestId("lab-generation")).toHaveText("1");
    expect(guard.workers).toHaveLength(1);
    expect(guard.closedWorkers).toEqual([]);

    // Leave a table behind that the proof's own setup never drops, and show that it survives
    // a second run on the same worker. Without this control "the table is gone afterwards"
    // would prove nothing, because the proof starts with `drop table if exists`.
    const marker = page.getByTestId("lab-marker");
    await expect(marker).toHaveAttribute("data-marker", "absent");
    await page.getByTestId("marker-create").click();
    await expect(marker).toHaveAttribute("data-marker", "present");
    await expect(page.getByTestId("lab-run-count")).toHaveText("1");
    await page.getByTestId("lab-rerun").click();
    await expect(page.getByTestId("lab-run-count")).toHaveText("2");
    await waitForProof(page);
    await expect(page.getByTestId("lab-generation")).toHaveText("1");
    await expect(marker).toHaveAttribute("data-marker", "present");
    expect(guard.workers).toHaveLength(1);
    expect(guard.closedWorkers).toHaveLength(0);

    const startedAt = Date.now();
    await page.getByTestId("slow-run").click();
    await expect(page.getByTestId("slow-status")).toHaveAttribute("data-status", "running");

    // The page stays responsive while Postgres is stuck inside the worker.
    const ping = page.getByTestId("ping-button");
    await ping.click();
    await ping.click();
    await ping.click();
    await expect(page.getByTestId("ping-count")).toHaveText("3");
    await expect(page.getByTestId("slow-status")).toHaveAttribute("data-status", "running");

    // pg_sleep(10) is cut off by the 1.5 s timeout, far sooner than it would have finished.
    await expect(page.getByTestId("slow-status")).toHaveAttribute("data-status", "timed-out", {
      timeout: 8_000,
    });
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    await expect(page.getByTestId("slow-status")).toContainText("the worker was terminated");

    // The browser itself, not only the page's bookkeeping, reports the first worker as gone.
    // (Worker handles are compared by identity; they are not plain data.)
    const firstWorker = guard.workers[0];
    await expect.poll(() => guard.closedWorkers.length, { timeout: 5_000 }).toBe(1);
    expect(guard.closedWorkers[0] === firstWorker, "the closed worker is the first one").toBe(true);
    expect(page.workers()).toHaveLength(0);
    await expect(marker).toHaveAttribute("data-marker", "unknown");

    // A fresh worker, and with it a fresh Postgres, answers the next run: the marker table
    // that survived the re-run above does not exist in it.
    await page.getByTestId("lab-rerun").click();
    await expect(page.getByTestId("lab-run-count")).toHaveText("3");
    await waitForProof(page);
    await expect(page.getByTestId("lab-generation")).toHaveText("2");
    await expect(page.getByTestId("lab-visible-count")).toHaveText("2");
    await expect(page.getByTestId("lab-total-rows")).toHaveText("3");
    await expect(marker).toHaveAttribute("data-marker", "absent");
    expect(guard.workers).toHaveLength(2);
    const secondWorker = guard.workers[1];
    const onlyTheSecondWorkerIsAlive = (): boolean =>
      page.workers().length === 1 && page.workers()[0] === secondWorker;
    expect(secondWorker === firstWorker, "the second worker is a new one").toBe(false);
    expect(onlyTheSecondWorkerIsAlive()).toBe(true);
    expect(guard.closedWorkers).toHaveLength(1);

    // Past the point where pg_sleep(10) would have returned had the first worker lived on:
    // nothing from it reaches the page, and the replacement is still the only worker.
    await page.waitForTimeout(Math.max(0, 11_000 - (Date.now() - startedAt)));
    await expect(page.getByTestId("slow-status")).toHaveAttribute("data-status", "timed-out");
    await expect(page.getByTestId("lab-generation")).toHaveText("2");
    await expect(page.getByTestId("lab-run-count")).toHaveText("3");
    expect(onlyTheSecondWorkerIsAlive()).toBe(true);
    expect(guard.closedWorkers).toHaveLength(1);

    await expectCleanBrowser(guard);
  });
});
