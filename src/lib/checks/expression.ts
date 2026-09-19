/**
 * What can be decided about a policy expression from its text alone, and nothing more. The input
 * is what `pg_get_expr` prints (PostgreSQL 18.3 in PGlite 0.5.8, measured):
 *
 * - `(true)`, `((TRUE))`, `'t'::boolean`, `true::bool`, `cast('yes' as boolean)` all print `true`:
 *   the parser folds a boolean literal into one constant. `(1 = 1)`, `(NOT false)` and
 *   `(true IS TRUE)` keep their shape; they are not "literally true" and are not guessed at.
 * - A boolean AND / OR is always wrapped in parentheses, its operands are parenthesised unless
 *   they are a bare column, constant or function call, and BETWEEN is printed as two comparisons:
 *   `(((t >= 1) AND (t <= 5)) AND (s = 'a and b'::text) AND is_public)`.
 * - Strings are `'...'` with `''` for a quote; identifiers that need it are `"..."` with `""`.
 *
 * Nothing here evaluates or rewrites an expression. The only semantic claims are the two that hold
 * for any row in three-valued logic: if `A AND B` is true then `A` is true, and if `A` is true
 * then `A OR C` is true.
 */

const WORD_CHAR = /[A-Za-z0-9_$]/;

interface Scan {
  /** Same length as the input; the content of literals and quoted identifiers is blanked to `_`. */
  readonly masked: string;
  /** Depth of `()`, `[]` and `CASE ... END` nesting before each character. */
  readonly depth: readonly number[];
  readonly literals: readonly string[];
  readonly quotedIdentifiers: readonly string[];
  /** `false` for an unterminated quote or unbalanced nesting: then nothing is decided. */
  readonly balanced: boolean;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

/** Reads a quoted run that starts at `start`; returns the index after the closing quote, or -1. */
function readQuoted(
  text: string,
  start: number,
  quote: string,
  backslashEscapes: boolean,
): { end: number; content: string } {
  let content = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (backslashEscapes && char === "\\" && index + 1 < text.length) {
      content += char + text.charAt(index + 1);
      index += 2;
    } else if (char !== quote) {
      content += char;
      index += 1;
    } else if (text.charAt(index + 1) === quote) {
      content += quote;
      index += 2;
    } else {
      return { end: index + 1, content };
    }
  }
  return { end: -1, content };
}

function scan(text: string): Scan {
  const depth: number[] = [];
  const literals: string[] = [];
  const quotedIdentifiers: string[] = [];
  let masked = "";
  let level = 0;
  let balanced = true;
  let index = 0;

  const push = (chars: string): void => {
    for (const char of chars) {
      depth.push(level);
      masked += char;
    }
  };

  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "'" || char === '"') {
      const previous = text.charAt(index - 1);
      const escapeString =
        char === "'" && (previous === "E" || previous === "e") && !isWordChar(text[index - 2]);
      const quoted = readQuoted(text, index, char, escapeString);
      const end = quoted.end === -1 ? text.length : quoted.end;
      balanced &&= quoted.end !== -1;
      (char === "'" ? literals : quotedIdentifiers).push(quoted.content);
      push(char + "_".repeat(Math.max(0, end - index - 2)) + (quoted.end === -1 ? "" : char));
      index = end;
    } else if (char === "(" || char === "[") {
      push(char);
      level += 1;
      index += 1;
    } else if (char === ")" || char === "]") {
      level -= 1;
      balanced &&= level >= 0;
      push(char);
      index += 1;
    } else if (isWordChar(char) && !isWordChar(text[index - 1])) {
      let end = index;
      while (isWordChar(text[end])) {
        end += 1;
      }
      const word = text.slice(index, end).toUpperCase();
      if (word === "END") {
        level -= 1;
        balanced &&= level >= 0;
      }
      push(text.slice(index, end));
      if (word === "CASE") {
        level += 1;
      }
      index = end;
    } else {
      push(char);
      index += 1;
    }
  }
  return { masked, depth, literals, quotedIdentifiers, balanced: balanced && level === 0 };
}

/** Removes white space and every pair of parentheses that wraps the whole expression. */
export function stripOuterParens(expression: string): string {
  let current = expression.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    const { depth, balanced } = scan(current);
    // The opening parenthesis wraps everything only if the depth never returns to 0 before the end.
    const last = depth.length - 1;
    const wraps = balanced && depth.every((level, at) => at === 0 || at === last || level >= 1);
    if (!wraps) {
      break;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
}

/** Collapses white space outside literals, so the same condition compares equal as text. */
function normalise(expression: string): string {
  const stripped = stripOuterParens(expression);
  const { masked } = scan(stripped);
  let result = "";
  for (let at = 0; at < stripped.length; at += 1) {
    const isSpace = /\s/.test(masked.charAt(at));
    if (!isSpace) {
      result += stripped.charAt(at);
    } else if (!result.endsWith(" ")) {
      result += " ";
    }
  }
  return result.trim();
}

/**
 * `true` only for the constant `true`, as Postgres prints `USING (true)`: any case, any number of
 * wrapping parentheses, an optional `::boolean` / `::bool` cast. Everything else is `false`, also
 * a tautology such as `(1 = 1)`: deciding that needs an evaluator, and a guess is not evidence.
 */
export function isLiterallyTrue(expression: string | null): boolean {
  if (expression === null) {
    return false;
  }
  let current = stripOuterParens(expression);
  const cast = /::\s*(boolean|bool)$/i.exec(current);
  if (cast) {
    current = stripOuterParens(current.slice(0, cast.index));
  }
  return /^(true|'(t|true|y|yes|on|1)')$/i.test(current);
}

export type BooleanOperator = "AND" | "OR";

export interface BooleanSplit {
  /** `null`: not a top-level AND or OR, or not safely splittable; then `parts` is the whole. */
  readonly operator: BooleanOperator | null;
  readonly parts: readonly string[];
}

/** Splits at the top-level AND or OR of an expression. Operands come back normalised. */
export function splitBoolean(expression: string): BooleanSplit {
  const inner = stripOuterParens(expression);
  const whole: BooleanSplit = { operator: null, parts: [normalise(inner)] };
  const { masked, depth, balanced } = scan(inner);
  if (!balanced) {
    return whole;
  }
  const cuts: { at: number; length: number; operator: BooleanOperator }[] = [];
  let unsafe = false;
  for (const match of masked.matchAll(/\b(AND|OR|BETWEEN)\b/gi)) {
    if (depth[match.index] !== 0) {
      continue;
    }
    const word = match[0].toUpperCase();
    if (word === "AND" || word === "OR") {
      cuts.push({ at: match.index, length: word.length, operator: word });
    } else {
      // `x BETWEEN a AND b`: that AND is not a boolean operator. Postgres prints BETWEEN as two
      // comparisons, so this only happens with hand-written input.
      unsafe = true;
    }
  }
  const operator = cuts[0]?.operator;
  if (operator === undefined || unsafe || cuts.some((cut) => cut.operator !== operator)) {
    return whole;
  }
  const parts: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    parts.push(inner.slice(from, cut.at));
    from = cut.at + cut.length;
  }
  parts.push(inner.slice(from));
  return { operator, parts: parts.map(normalise) };
}

/** The operands of a (nested) AND or OR, flattened; a single element when it is neither. */
export function flattenBoolean(expression: string, operator: BooleanOperator): string[] {
  const split = splitBoolean(expression);
  if (split.operator !== operator) {
    return [normalise(expression)];
  }
  return split.parts.flatMap((part) => flattenBoolean(part, operator));
}

export type Looseness =
  | { readonly looser: false }
  | {
      readonly looser: true;
      /**
       * - `check-true`: WITH CHECK is literally true, USING is a real condition.
       * - `check-true-without-using`: WITH CHECK is literally true and there is no USING. The
       *   policy reaches no row by itself, but permissive policies are OR-ed, so it switches the
       *   new-row check off for every other UPDATE policy of the same roles.
       * - `drops-conditions`: WITH CHECK is USING with conditions removed.
       * - `adds-alternatives`: WITH CHECK is USING (or a part of it) OR something else.
       */
      readonly reason:
        "check-true" | "check-true-without-using" | "drops-conditions" | "adds-alternatives";
      /** Conditions of USING that WITH CHECK does not repeat. */
      readonly dropped: readonly string[];
      /** Alternatives WITH CHECK accepts in addition. */
      readonly added: readonly string[];
    };

const NOT_LOOSER: Looseness = { looser: false };

/**
 * Is an explicit WITH CHECK provably looser than USING? Decided only in three cases: WITH CHECK
 * is literally true; WITH CHECK keeps a subset of USING's AND-ed conditions; WITH CHECK is such a
 * subset (or every alternative of an OR-ed USING) OR further alternatives. Conditions are compared as text, which works because Postgres
 * printed both. A missing WITH CHECK is never looser: Postgres then applies USING to the new row.
 * Two different conditions (`a = 1` against `a > 0`) are not compared at all.
 */
export function compareCheckToUsing(using: string | null, withCheck: string | null): Looseness {
  if (withCheck === null) {
    return NOT_LOOSER;
  }
  if (isLiterallyTrue(withCheck)) {
    if (using === null) {
      return { looser: true, reason: "check-true-without-using", dropped: [], added: [] };
    }
    return isLiterallyTrue(using)
      ? NOT_LOOSER
      : { looser: true, reason: "check-true", dropped: flattenBoolean(using, "AND"), added: [] };
  }
  if (using === null) {
    return NOT_LOOSER;
  }
  const required = flattenBoolean(using, "AND");
  const requiredSet = new Set(required);
  const alternatives = flattenBoolean(withCheck, "OR");
  for (const alternative of alternatives) {
    const kept = new Set(flattenBoolean(alternative, "AND"));
    if (![...kept].every((condition) => requiredSet.has(condition))) {
      continue;
    }
    const dropped = required.filter((condition) => !kept.has(condition));
    const added = alternatives.filter((other) => other !== alternative);
    if (dropped.length === 0 && added.length === 0) {
      return NOT_LOOSER;
    }
    return {
      looser: true,
      reason: added.length > 0 ? "adds-alternatives" : "drops-conditions",
      dropped,
      added,
    };
  }
  // USING is itself `A OR B` and WITH CHECK repeats every alternative and adds more.
  const usingAlternatives = flattenBoolean(using, "OR");
  const accepted = new Set(alternatives);
  if (usingAlternatives.length > 1 && usingAlternatives.every((one) => accepted.has(one))) {
    const added = alternatives.filter((one) => !usingAlternatives.includes(one));
    if (added.length > 0) {
      return { looser: true, reason: "adds-alternatives", dropped: [], added };
    }
  }
  return NOT_LOOSER;
}

const USER_METADATA_KEY = /(^|[^A-Za-z0-9_])(user_metadata|raw_user_meta_data)([^A-Za-z0-9_]|$)/;
const USER_METADATA_COLUMN = /(^|[^A-Za-z0-9_$])raw_user_meta_data([^A-Za-z0-9_$]|$)/i;

/**
 * Does the expression read the user-editable metadata? True for a string literal that names the
 * key (`-> 'user_metadata'`, `#>> '{user_metadata,role}'`, a jsonpath `$."user_metadata"`), and
 * for the column `raw_user_meta_data` of `auth.users`. A column of the user's own table that is
 * called `user_metadata` is not a JWT read and is not matched; `app_metadata` never is.
 */
export function readsUserMetadata(expression: string | null): boolean {
  if (expression === null) {
    return false;
  }
  const { masked, literals, quotedIdentifiers } = scan(expression);
  return (
    literals.some((literal) => USER_METADATA_KEY.test(literal)) ||
    quotedIdentifiers.includes("raw_user_meta_data") ||
    USER_METADATA_COLUMN.test(masked)
  );
}
