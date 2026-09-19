/**
 * Quoting of SQL identifiers and literals. Every module that builds SQL from a name or a value
 * uses these; nothing else hand-quotes. The output is correct for any input Postgres can
 * represent: embedded quotes, upper case, reserved words, backslashes, non-ASCII text.
 */

const NUL = "\0";

function assertNoNul(value: string, what: string): void {
  if (value.includes(NUL)) {
    throw new RangeError(`${what} must not contain a NUL character`);
  }
}

/**
 * Quotes an identifier the way `quote_ident` would if it always quoted: wrapped in double quotes
 * with embedded double quotes doubled. Always quoting keeps upper case and reserved words intact.
 * Throws a RangeError for an empty name or a NUL character, which Postgres cannot represent.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new RangeError("An SQL identifier must not be empty");
  }
  assertNoNul(name, "An SQL identifier");
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quotes a string literal like `quote_literal`: single quotes doubled. A value with a backslash
 * becomes an `E'...'` string with the backslashes doubled, which reads the same whether
 * `standard_conforming_strings` is on or off. Throws a RangeError for a NUL character.
 */
export function quoteLiteral(value: string): string {
  assertNoNul(value, "An SQL literal");
  const doubled = value.replaceAll("'", "''");
  if (!doubled.includes("\\")) {
    return `'${doubled}'`;
  }
  return `E'${doubled.replaceAll("\\", "\\\\")}'`;
}

/** `"schema"."name"`, both parts quoted with `quoteIdent`. */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}
