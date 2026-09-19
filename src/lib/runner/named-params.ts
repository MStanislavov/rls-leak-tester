/**
 * `expectedRowsSql` (scope `custom`, brief 3.4) names its two inputs `:sub` and `:claims`. Postgres
 * knows only `$n`, so this module rewrites them, by scanning the text the way the Postgres lexer
 * does. A colon inside any of these is left alone:
 *
 * - `::` casts (`:claims::jsonb` becomes `$1::jsonb::jsonb`, which is fine),
 * - `'...'` strings, `E'...'` strings with backslash escapes, `"..."` identifiers,
 * - `$tag$ ... $tag$` bodies, `--` comments and nested block comments.
 *
 * `:claims` is rewritten to `$n::jsonb`, because nothing useful can be done with untyped JSON and
 * `$1 ->> 'key'` alone is ambiguous. `:sub` stays untyped (`$n`), so `user_id = :sub` lets
 * Postgres infer uuid, integer or text from the column. Parameters are numbered in order of first
 * appearance; a query that uses only `:claims` gets `$1`, never an unused `$1` that Postgres
 * could not type.
 *
 * Any other `:name` is not touched: Postgres reports the syntax error and the cell shows it. A
 * positional `$1` written by the user is refused here, because it would silently bind to one of
 * the two values.
 */
import { quoteLiteral } from "@/lib/scenario";

export const NAMED_PARAMETERS = ["sub", "claims"] as const;
export type NamedParameter = (typeof NAMED_PARAMETERS)[number];

export interface RewrittenSql {
  /** The statement with `$n` placeholders. */
  readonly sql: string;
  /** Which value each `$n` stands for: `order[0]` is `$1`. */
  readonly order: readonly NamedParameter[];
}

/** The user's SQL cannot be bound: it already uses `$n`. */
export class NamedParameterError extends Error {
  override readonly name = "NamedParameterError";
}

const DOLLAR_TAG = /\$(?:[A-Za-z_\P{ASCII}][A-Za-z0-9_\P{ASCII}]*)?\$/uy;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;

function isIdentPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$\P{ASCII}]/u.test(char);
}

function isNamedParameter(name: string): name is NamedParameter {
  return (NAMED_PARAMETERS as readonly string[]).includes(name);
}

/** End offset (exclusive) of a quoted run that starts at `start`; the rest when unterminated. */
function endOfQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let pos = start + 1;
  while (pos < sql.length) {
    const char = sql[pos];
    if (backslash && char === "\\") {
      pos += 2;
    } else if (char === quote) {
      if (sql[pos + 1] === quote) {
        pos += 2;
      } else {
        return pos + 1;
      }
    } else {
      pos += 1;
    }
  }
  return sql.length;
}

function endOfBlockComment(sql: string, start: number): number {
  let depth = 0;
  let pos = start;
  while (pos < sql.length) {
    if (sql.startsWith("/*", pos)) {
      depth += 1;
      pos += 2;
    } else if (sql.startsWith("*/", pos)) {
      depth -= 1;
      pos += 2;
      if (depth === 0) {
        return pos;
      }
    } else {
      pos += 1;
    }
  }
  return sql.length;
}

function endOfLineComment(sql: string, start: number): number {
  const lineFeed = sql.indexOf("\n", start);
  return lineFeed === -1 ? sql.length : lineFeed;
}

/** End of a `$tag$ ... $tag$` body starting at `start`, or -1 when `start` is not a dollar tag. */
function endOfDollarBody(sql: string, start: number): number {
  DOLLAR_TAG.lastIndex = start;
  const tag = DOLLAR_TAG.exec(sql)?.[0];
  if (tag === undefined) {
    return -1;
  }
  const close = sql.indexOf(tag, start + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

/**
 * The end of the run that starts at `pos` and must be copied unchanged, or -1 when `pos` starts
 * no such run.
 */
function endOfOpaqueRun(sql: string, pos: number): number {
  const char = sql[pos];
  if (char === "'") {
    const escapeString = /[eE]/.test(sql[pos - 1] ?? "") && !isIdentPart(sql[pos - 2]);
    return endOfQuoted(sql, pos, "'", escapeString);
  }
  if (char === '"') {
    return endOfQuoted(sql, pos, '"', false);
  }
  if (sql.startsWith("--", pos)) {
    return endOfLineComment(sql, pos);
  }
  if (sql.startsWith("/*", pos)) {
    return endOfBlockComment(sql, pos);
  }
  if (sql.startsWith("::", pos)) {
    return pos + 2;
  }
  if (char === "$" && !isIdentPart(sql[pos - 1])) {
    if (/[0-9]/.test(sql[pos + 1] ?? "")) {
      throw new NamedParameterError(
        "expectedRowsSql uses a positional parameter ($1). Use :sub and :claims instead.",
      );
    }
    return endOfDollarBody(sql, pos);
  }
  return -1;
}

function rewrite(
  sql: string,
  replacement: (name: NamedParameter, position: number) => string,
): RewrittenSql {
  const order: NamedParameter[] = [];
  let out = "";
  let pos = 0;
  while (pos < sql.length) {
    const opaqueEnd = endOfOpaqueRun(sql, pos);
    if (opaqueEnd !== -1) {
      out += sql.slice(pos, opaqueEnd);
      pos = opaqueEnd;
      continue;
    }
    NAME.lastIndex = pos + 1;
    const name = sql[pos] === ":" ? NAME.exec(sql)?.[0] : undefined;
    if (name !== undefined && isNamedParameter(name)) {
      if (!order.includes(name)) {
        order.push(name);
      }
      out += replacement(name, order.indexOf(name) + 1);
      pos += 1 + name.length;
    } else {
      out += sql[pos];
      pos += 1;
    }
  }
  return { sql: out, order };
}

/** Rewrites `:sub` and `:claims`. Returns the text unchanged, with an empty order, without them. */
export function rewriteNamedParameters(sql: string): RewrittenSql {
  return rewrite(sql, (name, position) =>
    name === "claims" ? `$${position}::jsonb` : `$${position}`,
  );
}

/** The same rewrite with the values as literals, for the export: `:claims` becomes `'{...}'::jsonb`. */
export function inlineNamedParameters(
  sql: string,
  values: Readonly<Record<NamedParameter, string | null>>,
): string {
  return rewrite(sql, (name) => {
    const value = values[name];
    const literal = value === null ? "null" : quoteLiteral(value);
    return name === "claims" ? `${literal}::jsonb` : literal;
  }).sql;
}
