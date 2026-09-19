/**
 * Stable serialisation for save, share and export: the same scenario always gives the same text,
 * whatever order its keys were written in.
 */
import { compareText } from "./heuristics";
import { OPERATIONS, type Expectation, type Scenario, type TableConfig } from "./types";

function sortKeysDeep(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    throw new TypeError("stableStringify cannot serialise a circular structure");
  }
  ancestors.add(value);
  const sorted = Array.isArray(value)
    ? value.map((item) => sortKeysDeep(item, ancestors))
    : Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => compareText(a, b))
          .map(([key, item]) => [key, sortKeysDeep(item, ancestors)]),
      );
  ancestors.delete(value);
  return sorted;
}

/**
 * `JSON.stringify` with the keys of every object sorted in code-unit order. Arrays keep their
 * order. `undefined` properties are dropped as usual. Throws a TypeError for a circular
 * structure, for a `bigint`, and for a value that has no JSON form at all (`undefined`, a
 * function).
 */
export function stableStringify(value: unknown, space?: number): string {
  const text: string | undefined = JSON.stringify(sortKeysDeep(value, new Set()), null, space);
  if (text === undefined) {
    throw new TypeError("stableStringify needs a value that has a JSON form");
  }
  return text;
}

function compareTables(a: TableConfig, b: TableConfig): number {
  return compareText(a.schema, b.schema) || compareText(a.name, b.name);
}

function expectationOrder(personaOrder: ReadonlyMap<string, number>) {
  const rank = (expectation: Expectation): number =>
    personaOrder.get(expectation.personaId) ?? personaOrder.size;
  return (a: Expectation, b: Expectation): number =>
    compareText(a.schema, b.schema) ||
    compareText(a.table, b.table) ||
    rank(a) - rank(b) ||
    compareText(a.personaId, b.personaId) ||
    OPERATIONS.indexOf(a.operation) - OPERATIONS.indexOf(b.operation);
}

/**
 * The scenario with everything whose order carries no meaning put in a fixed order: tables by
 * schema and name; expectations by schema, table, persona (in the order of `personas`) and
 * operation. Personas and exposed schemas keep their order, because the user chose it. The input
 * is not mutated.
 */
export function canonicalScenario(scenario: Scenario): Scenario {
  const personaOrder = new Map(scenario.personas.map((persona, index) => [persona.id, index]));
  return {
    ...scenario,
    tables: [...scenario.tables].sort(compareTables),
    expectations: [...scenario.expectations].sort(expectationOrder(personaOrder)),
  };
}

/** The canonical JSON text of a scenario: `canonicalScenario`, sorted keys, two-space indent. */
export function serializeScenario(scenario: Scenario): string {
  return stableStringify(canonicalScenario(scenario), 2);
}
