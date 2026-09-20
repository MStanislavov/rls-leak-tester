import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Node is the default. A component test opts in to a DOM per file with
    // the `// @vitest-environment jsdom` docblock.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    // TEST-001 at run time: blocks every connection that is not loopback unless
    // RUN_LIVE_AI_TESTS=1. The rules check refuses a config without it.
    setupFiles: ["./tests/setup/network-guard.setup.ts"],
    // An empty suite is not an error; the coverage thresholds below still
    // apply to every run that collects coverage.
    passWithNoTests: true,
    // Many suites boot a real PGlite (WASM Postgres). Alone that takes well under a second, but
    // with every worker booting WASM at once, or on a slow CI runner, Vitest's defaults (5 s per
    // test, 10 s per hook) were exceeded now and then. These are watchdogs, not product
    // thresholds: the probe timeout and the run ceiling are tested with injected timers.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // Everything SonarQube counts as coverable (sonar-project.properties: the whole repository
      // minus src/app and src/components, which Playwright covers), so that coverage/lcov.info
      // tells Sonar the truth about the scripts and the root configuration too, instead of
      // leaving them at an assumed zero. Scripts that only ever run as a child process stay at
      // zero here: v8 coverage does not follow a spawn.
      include: ["src/lib/**", "src/*.ts", "scripts/**", "*.config.{ts,mts,mjs}"],
      exclude: ["src/lib/**/*.test.{ts,tsx}", "src/lib/**/*.d.ts"],
      thresholds: {
        // Over everything included above ...
        lines: 80,
        branches: 80,
        // ... and TEST-002 for the library by itself, which the wider scope must not dilute.
        "src/lib/**": {
          lines: 80,
          branches: 80,
        },
      },
    },
  },
});
