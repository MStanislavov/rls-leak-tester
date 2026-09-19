/**
 * Vitest setup file (vitest.config.mts, `test.setupFiles`): the run-time layer of rules.yaml
 * TEST-001. It runs before every test file, blocks every connection that is not loopback, and
 * fails the test that tried one, also when the code under test swallowed the error.
 *
 * The rules check refuses a vitest.config without this file and a version of this file that stops
 * calling the two functions below, or that hands the guard anything but `process.env`.
 * RUN_LIVE_AI_TESTS=1 in the environment of the run is the only switch that lifts the guard; the
 * guard reads it once, here, so a test cannot set it from inside.
 */
import { afterEach } from "vitest";

import { failOnBlockedAttempts, installNetworkGuard } from "./network-guard";

installNetworkGuard(process.env);

afterEach(() => {
  failOnBlockedAttempts();
});
