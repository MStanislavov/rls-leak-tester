/**
 * Scenario JSON files and "Save as": the text comes from `serializeScenario`, and whatever is
 * read back goes through `parseScenarioJson` (SEC-002), like every other load path.
 */
import {
  MAX_TITLE_LENGTH,
  parseScenarioJson,
  serializeScenario,
  slugify,
  type ParseScenarioResult,
  type Scenario,
} from "@/lib/scenario";

export const SCENARIO_FILE_SUFFIX = ".scenario.json";
export const SCENARIO_FILE_TYPE = "application/json";

/** `slugify` never returns an empty text: a title without letters or digits gives `scenario`. */
export function scenarioFileName(scenario: Pick<Scenario, "title">): string {
  return `${slugify(scenario.title)}${SCENARIO_FILE_SUFFIX}`;
}

export function scenarioFileText(scenario: Scenario): string {
  return serializeScenario(scenario);
}

/** Never throws: a file that is not a scenario yields readable issues. */
export function parseScenarioFile(text: string): ParseScenarioResult {
  return parseScenarioJson(text);
}

/** "Save as": the same scenario under a new id and title. The id comes from the caller. */
export function renamedScenario(scenario: Scenario, id: string, title: string): Scenario {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  return { ...scenario, id, title: trimmed === "" ? scenario.title : trimmed };
}
