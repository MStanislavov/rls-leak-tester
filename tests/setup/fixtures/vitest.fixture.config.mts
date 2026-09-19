/**
 * Configuration of the child Vitest run that tests/setup/network-guard.test.ts starts from the
 * repository root. It collects only `*.fixture.ts` of this directory, which the project's own
 * configuration never does, and it registers the same setup file as the project.
 *
 * The cache goes to the system's temporary directory: the child must neither overwrite the
 * timing cache of the run that started it nor leave a `node_modules/.vite` behind in here.
 */
import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: path.join(tmpdir(), "rls-leak-tester-network-guard-fixture"),
  test: {
    environment: "node",
    include: ["tests/setup/fixtures/*.fixture.ts"],
    setupFiles: ["./tests/setup/network-guard.setup.ts"],
  },
});
