/**
 * The words the details drawer uses for a sub-probe. The words for a cell status and a verdict
 * live in `@/lib/site/status`, shared with the landing page and the docs.
 */
import type { SubProbeKind, SubProbeOutcome } from "@/lib/runner";

export const SUB_PROBE_LABELS: Readonly<Record<SubProbeKind, string>> = {
  "escape-targeted": "Scope escape, targeted UPDATE ... WHERE key",
  "escape-bulk": "Scope escape, UPDATE without WHERE and RETURNING",
  "insert-own": "Insert a copy of an own row",
  "insert-same-tenant": "Insert a copy of a same-tenant row of another owner",
  "insert-other": "Insert a copy of a row of another owner or tenant",
  "insert-in-scope": "Insert a copy of a row inside the expected rows",
  "insert-out-of-scope": "Insert a copy of a row outside the expected rows",
};

export const SUB_PROBE_OUTCOME_LABELS: Readonly<Record<SubProbeOutcome, string>> = {
  allowed: "allowed",
  blocked: "blocked",
  inconclusive: "inconclusive",
  skipped: "skipped",
};
