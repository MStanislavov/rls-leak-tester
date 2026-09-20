/**
 * The lab's two numbers. Their home is `rules.yaml` (`thresholds.runner`); a browser module
 * cannot read a YAML file, so they are constants here and `thresholds.test.ts` fails when they
 * drift from the file.
 */

/** One statement may take this long; then the worker is terminated and the probe is inconclusive. */
export const PROBE_TIMEOUT_MS = 5_000;

/** A whole run may take this long; then it is stopped and reported as failed. */
export const RUN_CEILING_MS = 60_000;
