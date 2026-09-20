/**
 * Live validation of the working scenario with the same schema every load path uses
 * (`parseScenario`, SEC-002). The lab does not run, save or export a scenario that fails it.
 */
import { parseScenario, type Scenario, type ScenarioIssue } from "@/lib/scenario";

export interface LabValidation {
  readonly ok: boolean;
  /** The parsed scenario: what a run, a save and an export use. `null` when invalid. */
  readonly scenario: Scenario | null;
  readonly issues: readonly ScenarioIssue[];
}

export function validateLabScenario(scenario: Scenario): LabValidation {
  const parsed = parseScenario(scenario);
  return parsed.ok
    ? { ok: true, scenario: parsed.scenario, issues: [] }
    : { ok: false, scenario: null, issues: parsed.issues };
}

/** The issues at `prefix` or below it: `personas[1]` matches `personas[1].claims.sub`. */
export function issuesUnder(
  issues: readonly ScenarioIssue[],
  prefix: string,
): readonly ScenarioIssue[] {
  return issues.filter(
    (issue) =>
      issue.path === prefix ||
      issue.path.startsWith(`${prefix}.`) ||
      issue.path.startsWith(`${prefix}[`),
  );
}

export function personaIssues(
  issues: readonly ScenarioIssue[],
  personaIndex: number,
): readonly ScenarioIssue[] {
  return issuesUnder(issues, `personas[${personaIndex}]`);
}

/** `personas[1].claims.sub: message`, or the bare message for the whole document. */
export function formatIssue(issue: ScenarioIssue): string {
  return issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`;
}
