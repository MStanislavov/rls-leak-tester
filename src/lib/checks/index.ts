/** The static checks RLS001 to RLS009. Everything other modules need comes from `@/lib/checks`. */
export { countBySeverity, runStaticChecks } from "./run";
export { DOCS, STATIC_CHECK_RULES, ruleById } from "./rules";
export { compareFindings } from "./finding";
export { CHECK_IDS, SEVERITIES } from "./types";
export type {
  CheckId,
  Finding,
  FindingEvidence,
  FindingObject,
  FindingObjectKind,
  Severity,
  StaticCheckContext,
  StaticCheckRule,
} from "./types";
