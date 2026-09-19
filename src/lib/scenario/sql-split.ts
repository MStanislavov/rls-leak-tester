/**
 * Splits an SQL script into statements, so that an error in the user's SQL can be shown next to
 * the statement that caused it (brief section 3.3). Pure text scanning that follows the rules of
 * the Postgres lexer and of psql's statement splitter:
 *
 * - `--` line comments and nested block comments,
 * - single-quoted strings with doubled quotes, `E'...'` strings with backslash escapes (also when
 *   continued on the next line),
 * - double-quoted identifiers with doubled quotes,
 * - dollar-quoted bodies with or without a tag (`$1` is a parameter, `a$b` an identifier),
 * - parentheses (`CREATE RULE ... DO (a; b)`) and the `BEGIN ATOMIC ... END` body of a
 *   `CREATE FUNCTION` or `CREATE PROCEDURE`, tracked the way psql does.
 *
 * A semicolon inside any of these never splits. Statements without any token (only whitespace
 * and comments) are dropped. Whatever is unterminated at the end of the script (a string, a
 * comment, a dollar quote, an open parenthesis) becomes part of the last statement, so Postgres
 * reports the error instead of the text vanishing. psql meta-commands and `COPY ... FROM stdin`
 * data blocks are not SQL and are not recognised.
 */

export interface SqlStatement {
  /** Zero-based position among the returned statements. */
  index: number;
  /** From its first token to its last, without the terminating semicolon. */
  text: string;
  /** Offset of the first character of `text` in the script (UTF-16 code units, zero-based). */
  start: number;
  /** Offset just past the last character of `text`. */
  end: number;
  /** One-based line of `start`. */
  line: number;
  /** One-based column of `start` (UTF-16 code units). */
  column: number;
}

export interface SqlPosition {
  line: number;
  column: number;
}

const CR = 13;
const LF = 10;

function isLineBreakAt(sql: string, offset: number): boolean {
  const code = sql.charCodeAt(offset);
  // "\r\n" is one break, counted at the "\n".
  return code === LF || (code === CR && sql.charCodeAt(offset + 1) !== LF);
}

/** Line and column counter that only moves forward, so a whole script is read once. */
class PositionTracker {
  private offset = 0;
  private line = 1;
  private lineStart = 0;

  constructor(private readonly sql: string) {}

  advanceTo(target: number): SqlPosition {
    const end = Math.min(Math.max(target, this.offset), this.sql.length);
    while (this.offset < end) {
      if (isLineBreakAt(this.sql, this.offset)) {
        this.line += 1;
        this.lineStart = this.offset + 1;
      }
      this.offset += 1;
    }
    return { line: this.line, column: this.offset - this.lineStart + 1 };
  }
}

/**
 * One-based line and column of an offset in a script. `\n`, `\r\n` and a lone `\r` each count as
 * one line break. Offsets outside the script are clamped. Useful to place a Postgres error
 * `position` (one-based, within a statement): `offsetToPosition(sql, stmt.start + position - 1)`.
 */
export function offsetToPosition(sql: string, offset: number): SqlPosition {
  return new PositionTracker(sql).advanceTo(offset);
}

function isWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 0x80;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code) || code === 36;
}

const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
const ROUTINE_KEYWORDS: readonly string[] = ["function", "procedure"];

class Splitter {
  private pos = 0;
  /** Offset of the first token of the current statement, or -1 while there is none. */
  private start = -1;
  /** Offset just past the last token of the current statement. */
  private end = 0;
  private parenDepth = 0;
  private beginDepth = 0;
  /** The first four words of the current statement, lower case: enough to see CREATE FUNCTION. */
  private leadingWords: string[] = [];
  private readonly statements: SqlStatement[] = [];
  private readonly positions: PositionTracker;

  constructor(private readonly sql: string) {
    this.positions = new PositionTracker(sql);
  }

  run(): SqlStatement[] {
    while (this.pos < this.sql.length) {
      this.step();
    }
    this.finishStatement();
    return this.statements;
  }

  private step(): void {
    const code = this.sql.charCodeAt(this.pos);
    if (isWhitespace(code)) {
      this.pos += 1;
    } else if (this.sql.startsWith("--", this.pos)) {
      this.skipLineComment();
    } else if (this.sql.startsWith("/*", this.pos)) {
      this.skipBlockComment();
    } else {
      this.token(code);
    }
  }

  /** Everything that is not whitespace or a comment belongs to a statement. */
  private token(code: number): void {
    const tokenStart = this.pos;
    if (code === 59 /* ; */ && this.parenDepth === 0 && this.beginDepth === 0) {
      this.pos += 1;
      this.finishStatement();
      return;
    }
    if (code === 39 /* ' */) {
      this.skipQuoted("'", false);
    } else if (code === 34 /* " */) {
      this.skipQuoted('"', false);
    } else if (code === 36 /* $ */) {
      this.skipDollar();
    } else if (isIdentStart(code)) {
      this.word();
    } else if (isDigit(code)) {
      this.skipWhile((c) => isIdentPart(c) || c === 46);
    } else {
      this.punctuation(code);
    }
    this.mark(tokenStart);
  }

  private mark(tokenStart: number): void {
    if (this.start === -1) {
      this.start = tokenStart;
    }
    this.end = this.pos;
  }

  private punctuation(code: number): void {
    if (code === 40 /* ( */) {
      this.parenDepth += 1;
    } else if (code === 41 /* ) */ && this.parenDepth > 0) {
      this.parenDepth -= 1;
    }
    this.pos += 1;
  }

  private skipWhile(test: (code: number) => boolean): void {
    while (this.pos < this.sql.length && test(this.sql.charCodeAt(this.pos))) {
      this.pos += 1;
    }
  }

  private skipLineComment(): void {
    this.skipWhile((code) => code !== LF && code !== CR);
  }

  private skipBlockComment(): void {
    const commentStart = this.pos;
    let depth = 0;
    while (this.pos < this.sql.length) {
      if (this.sql.startsWith("/*", this.pos)) {
        depth += 1;
        this.pos += 2;
      } else if (this.sql.startsWith("*/", this.pos)) {
        depth -= 1;
        this.pos += 2;
        if (depth === 0) {
          return;
        }
      } else {
        this.pos += 1;
      }
    }
    // Unterminated: keep it as statement text so that Postgres reports the error.
    this.mark(commentStart);
  }

  /**
   * Skips a quoted run that starts at the opening quote. A doubled quote is a literal quote; with
   * `escapes` a backslash takes the next character with it. An `E'...'` string may continue
   * after whitespace that contains a line break, still with escapes.
   */
  private skipQuoted(quote: string, escapes: boolean): void {
    this.pos += 1;
    while (this.pos < this.sql.length) {
      const char = this.sql[this.pos];
      if (escapes && char === "\\") {
        this.pos += 2;
      } else if (char !== quote) {
        this.pos += 1;
      } else if (this.sql[this.pos + 1] === quote) {
        this.pos += 2;
      } else {
        this.pos += 1;
        if (!escapes || !this.continuesOnNextLine()) {
          return;
        }
      }
    }
    this.pos = this.sql.length;
  }

  /** After a closing quote: whitespace with a line break, then another quote. Moves onto it. */
  private continuesOnNextLine(): boolean {
    let look = this.pos;
    let sawLineBreak = false;
    while (look < this.sql.length && isWhitespace(this.sql.charCodeAt(look))) {
      const code = this.sql.charCodeAt(look);
      sawLineBreak ||= code === LF || code === CR;
      look += 1;
    }
    if (!sawLineBreak || this.sql[look] !== "'") {
      return false;
    }
    this.pos = look + 1;
    return true;
  }

  private skipDollar(): void {
    DOLLAR_TAG.lastIndex = this.pos;
    const tag = DOLLAR_TAG.exec(this.sql)?.[0];
    if (tag === undefined) {
      // A parameter such as $1, or a stray dollar sign.
      this.pos += 1;
      return;
    }
    const close = this.sql.indexOf(tag, this.pos + tag.length);
    this.pos = close === -1 ? this.sql.length : close + tag.length;
  }

  private word(): void {
    const wordStart = this.pos;
    this.skipWhile(isIdentPart);
    const word = this.sql.slice(wordStart, this.pos).toLowerCase();
    if (word === "e" && this.sql[this.pos] === "'") {
      this.skipQuoted("'", true);
      return;
    }
    if (this.leadingWords.length < 4) {
      this.leadingWords.push(word);
    }
    if (this.parenDepth === 0 && this.isCreateRoutine()) {
      this.trackBody(word);
    }
  }

  /** CREATE [OR REPLACE] FUNCTION | PROCEDURE, the only statements with a BEGIN ATOMIC body. */
  private isCreateRoutine(): boolean {
    const [first, second, third, fourth] = this.leadingWords;
    if (first !== "create" || second === undefined) {
      return false;
    }
    if (ROUTINE_KEYWORDS.includes(second)) {
      return true;
    }
    return (
      second === "or" &&
      third === "replace" &&
      fourth !== undefined &&
      ROUTINE_KEYWORDS.includes(fourth)
    );
  }

  /** psql's heuristic: BEGIN opens a body, CASE inside a body opens another END, END closes. */
  private trackBody(word: string): void {
    if (word === "begin" || (word === "case" && this.beginDepth > 0)) {
      this.beginDepth += 1;
    } else if (word === "end" && this.beginDepth > 0) {
      this.beginDepth -= 1;
    }
  }

  private finishStatement(): void {
    if (this.start !== -1) {
      const position = this.positions.advanceTo(this.start);
      this.statements.push({
        index: this.statements.length,
        text: this.sql.slice(this.start, this.end),
        start: this.start,
        end: this.end,
        line: position.line,
        column: position.column,
      });
    }
    this.start = -1;
    this.parenDepth = 0;
    this.beginDepth = 0;
    this.leadingWords = [];
  }
}

/** Splits a script into its statements, in order. See the file comment for the rules. */
export function splitSqlStatements(sql: string): SqlStatement[] {
  return new Splitter(sql).run();
}
