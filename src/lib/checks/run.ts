/**
 * The static checks RLS001 to RLS009 (brief 3.6): deterministic, no AI, no database access. They
 * read the catalog snapshot the runner already took and report facts next to the matrix. A
 * finding never changes a verdict; verdicts come from executed probes (rules.yaml P1).
 */
import type { Catalog } from "@/lib/runner/introspect";
import { compareFindings } from "./finding";
import { checkSecurityDefinerSearchPath, checkViewsBypassingRls } from "./object-checks";
import { checkLooseWithCheck, checkPolicyAlwaysTrue, checkUserMetadata } from "./policy-checks";
import {
  checkNoPolicies,
  checkOwnerIsApplicationRole,
  checkPublicWriteGrants,
  checkRlsDisabled,
} from "./table-checks";
import { SEVERITIES, type Finding, type Severity, type StaticCheckContext } from "./types";

/**
 * Runs every rule over `catalog`. Pure and deterministic: the same catalog and context give the
 * same list, ordered by severity (critical first), rule id, then object (schema, table, name).
 */
export function runStaticChecks(catalog: Catalog, context: StaticCheckContext): Finding[] {
  return [
    ...checkRlsDisabled(catalog, context),
    ...checkNoPolicies(catalog),
    ...checkPolicyAlwaysTrue(catalog),
    ...checkLooseWithCheck(catalog),
    ...checkUserMetadata(catalog, context),
    ...checkPublicWriteGrants(catalog, context),
    ...checkSecurityDefinerSearchPath(catalog, context),
    ...checkViewsBypassingRls(catalog, context),
    ...checkOwnerIsApplicationRole(catalog, context),
  ].sort(compareFindings);
}

/** Findings per severity, every severity present, for the summary line beside the verdict. */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const severity of SEVERITIES) {
    counts[severity] = findings.filter((entry) => entry.severity === severity).length;
  }
  return counts;
}
