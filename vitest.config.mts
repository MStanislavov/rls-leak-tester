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
    // An empty suite is not an error; the coverage thresholds below still
    // apply to every run that collects coverage.
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/lib/**"],
      exclude: ["src/lib/**/*.test.{ts,tsx}", "src/lib/**/*.d.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
