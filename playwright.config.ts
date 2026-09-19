import { defineConfig, devices } from "@playwright/test";

/**
 * Two modes, chosen with E2E_MODE:
 *
 * - `prod` (default): `next start` against an existing `next build`. `npm run e2e` builds first.
 * - `dev`: `next dev`. `npm run e2e:dev`.
 *
 * Both run on port 3100 so a developer's own server on 3000 is never reused or disturbed.
 */
const mode = process.env.E2E_MODE === "dev" ? "dev" : "prod";
const port = 3100;
const baseURL = `http://localhost:${port}`;

// The specs read the mode to know which Content-Security-Policy to expect.
process.env.E2E_MODE = mode;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // The dev server compiles routes on first request; one worker keeps that deterministic.
  workers: mode === "dev" ? 1 : undefined,
  timeout: mode === "dev" ? 120_000 : 60_000,
  expect: { timeout: mode === "dev" ? 60_000 : 30_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: mode === "dev" ? `npx next dev --port ${port}` : `npx next start --port ${port}`,
    url: baseURL,
    // Never attach to a server somebody else started: the mode would be unknown.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
