/**
 * Text helpers of the CI export. Everything the export writes into a file that is not produced by
 * a probe builder goes through one of these, because scenario text (titles, labels, identifiers,
 * claims) is attacker-controlled the moment a scenario is shared:
 *
 * - `commentLine` keeps a value on ONE comment line, so a title cannot end the comment and start
 *   a statement;
 * - `dollarQuote` wraps a statement in a dollar quote whose tag does not occur in it;
 * - values become literals through `quoteLiteral` of the scenario model, never by hand.
 */
import { quoteLiteral } from "@/lib/scenario";
import { parseKey } from "@/lib/runner";

/** Control characters, the Unicode line and paragraph separators included. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** `value` as text that stays on one line of an SQL or YAML comment. */
export function commentLine(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").trim();
}

/**
 * `text` inside a dollar quote. The tag is `base`, or `base1`, `base2`, ... when the text holds
 * `$base$` itself or ends in a way that would close the quote early. Deterministic.
 */
export function dollarQuote(text: string, base = "sql"): string {
  for (let counter = 0; ; counter += 1) {
    const delimiter = `$${base}${counter === 0 ? "" : String(counter)}$`;
    // The closing delimiter must be the FIRST place the delimiter shows up after the opening one.
    if (`${text}${delimiter}`.indexOf(delimiter) === text.length) {
      return `${delimiter}${text}${delimiter}`;
    }
  }
}

/** `array[$sql$...$sql$, ...]::text[]`, one statement per line. */
export function statementArray(statements: readonly string[], indent: string): string {
  if (statements.length === 0) {
    return "array[]::text[]";
  }
  const lines = statements.map((statement) => `${indent}  ${dollarQuote(statement)}`);
  return `array[\n${lines.join(",\n")}\n${indent}]::text[]`;
}

/** `array['a', 'b']::text[]` of plain values. */
export function textArray(values: readonly string[]): string {
  return `array[${values.map((value) => quoteLiteral(value)).join(", ")}]::text[]`;
}

/** Any JSON value as a `jsonb` literal. */
export function jsonbLiteral(value: unknown): string {
  return `${quoteLiteral(JSON.stringify(value))}::jsonb`;
}

/**
 * Serialised primary keys (`["7","b"]`) as one `jsonb` literal: an array of key arrays, in the
 * given order. The SQL side compares keys as jsonb values, so spacing never matters.
 */
export function keysLiteral(keys: readonly string[]): string {
  return jsonbLiteral(keys.map((key) => parseKey(key)));
}
