/**
 * Text helpers for scripts/rules-check.mjs. Pure: strings in, data out.
 *
 * The checks are heuristics over source text, not a parser. What keeps them honest is
 * `scanSource`: it separates code from comments while respecting string, template and regular
 * expression literals, so a rule id in a comment or a glob such as ".next/**" inside a string is
 * never mistaken for something else. Line numbers survive because every removed character is
 * replaced by a space and every newline is kept.
 */

/**
 * @typedef {{ text: string, line: number }} Comment
 * @typedef {{ code: string, comments: Comment[] }} ScannedSource
 * @typedef {{ specifier: string, line: number, typeOnly: boolean, names: string[] }} ImportRef
 */

const REGEX_PRECEDING_CHARS = new Set("(,=:[!&|?{};+-*%~^");
const REGEX_PRECEDING_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * The end index (exclusive) of a regular expression literal starting at `start`, or -1 when the
 * slash is a division sign. A literal never spans lines.
 * @param {string} source
 * @param {number} start
 */
function regexLiteralEnd(source, start) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i += 1;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      let end = i + 1;
      while (end < source.length && /[a-z]/i.test(source.charAt(end))) end += 1;
      return end;
    }
  }
  return -1;
}

/**
 * The cursor of {@link scanSource}. `lastChar` and `lastWord` describe the code before the cursor
 * and decide whether a slash opens a regular expression or divides.
 * @typedef {{
 *   source: string,
 *   i: number,
 *   line: number,
 *   out: string[],
 *   comments: Comment[],
 *   templateDepths: number[],
 *   lastChar: string,
 *   lastWord: string,
 *   wordOpen: boolean,
 * }} ScanState
 * `templateDepths`: the open `${` expressions of the enclosing template literals, as brace depths.
 * `wordOpen`: true while the previous emitted character continued an identifier.
 */

/**
 * @param {ScanState} state
 * @param {string} ch
 */
function emit(state, ch) {
  state.out.push(ch);
  if (ch === "\n") state.line += 1;
}

/**
 * Replaces `text` by spaces and keeps its newlines.
 * @param {ScanState} state
 * @param {string} text
 */
function blank(state, text) {
  for (const ch of text) emit(state, ch === "\n" ? "\n" : " ");
}

/**
 * What follows a string, template or regular expression literal is never a regular expression.
 * @param {ScanState} state
 * @param {string} closedBy
 */
function endLiteral(state, closedBy) {
  state.lastChar = closedBy;
  state.lastWord = "";
}

/**
 * Copies the body of a template literal up to its closing backtick or the next `${`.
 * @param {ScanState} state
 */
function copyTemplateBody(state) {
  const { source } = state;
  while (state.i < source.length) {
    const ch = source.charAt(state.i);
    if (ch === "\\") {
      emit(state, ch);
      emit(state, source.charAt(state.i + 1));
      state.i += 2;
    } else if (ch === "`") {
      emit(state, ch);
      state.i += 1;
      return;
    } else if (ch === "$" && source[state.i + 1] === "{") {
      emit(state, "$");
      emit(state, "{");
      state.i += 2;
      state.templateDepths.push(0);
      return;
    } else {
      emit(state, ch);
      state.i += 1;
    }
  }
}

/**
 * A line or block comment at the cursor: recorded, and blanked in the code.
 * @param {ScanState} state
 * @param {string} ch
 */
function scanComment(state, ch) {
  const { source } = state;
  const next = source[state.i + 1];
  if (ch !== "/" || (next !== "/" && next !== "*")) return false;
  let end;
  if (next === "/") {
    end = source.indexOf("\n", state.i);
    if (end === -1) end = source.length;
  } else {
    end = source.indexOf("*/", state.i + 2);
    end = end === -1 ? source.length : end + 2;
  }
  const text = source.slice(state.i, end);
  state.comments.push({ text, line: state.line });
  blank(state, text);
  state.i = end;
  return true;
}

/**
 * A '…' or "…" literal at the cursor. It ends at its quote or, unterminated, at the line end.
 * @param {ScanState} state
 * @param {string} quote
 */
function scanQuoted(state, quote) {
  if (quote !== '"' && quote !== "'") return false;
  const { source } = state;
  emit(state, quote);
  state.i += 1;
  while (state.i < source.length) {
    const inner = source.charAt(state.i);
    if (inner === "\n") break;
    emit(state, inner);
    state.i += 1;
    if (inner === "\\" && state.i < source.length) {
      emit(state, source.charAt(state.i));
      state.i += 1;
    } else if (inner === quote) {
      break;
    }
  }
  endLiteral(state, quote);
  return true;
}

/**
 * The opening backtick of a template literal at the cursor.
 * @param {ScanState} state
 * @param {string} ch
 */
function scanTemplateOpen(state, ch) {
  if (ch !== "`") return false;
  emit(state, ch);
  state.i += 1;
  copyTemplateBody(state);
  endLiteral(state, "`");
  return true;
}

/**
 * A regular expression literal at the cursor, copied as it is.
 * @param {ScanState} state
 * @param {string} ch
 */
function scanRegex(state, ch) {
  if (ch !== "/") return false;
  const regexAllowed =
    state.lastChar === "" ||
    REGEX_PRECEDING_CHARS.has(state.lastChar) ||
    REGEX_PRECEDING_WORDS.has(state.lastWord);
  const end = regexAllowed ? regexLiteralEnd(state.source, state.i) : -1;
  if (end === -1) return false;
  for (const literalChar of state.source.slice(state.i, end)) emit(state, literalChar);
  state.i = end;
  endLiteral(state, "/");
  return true;
}

/**
 * A brace inside a `${…}` expression: counted, and the `}` that closes the expression hands the
 * cursor back to the template body. True when it did; any other brace is left to the caller.
 * @param {ScanState} state
 * @param {string} ch
 */
function scanTemplateBrace(state, ch) {
  const top = state.templateDepths.length - 1;
  if (top < 0 || (ch !== "{" && ch !== "}")) return false;
  const depth = state.templateDepths[top] ?? 0;
  if (ch === "}" && depth === 0) {
    state.templateDepths.pop();
    emit(state, ch);
    state.i += 1;
    copyTemplateBody(state);
    endLiteral(state, "`");
    return true;
  }
  state.templateDepths[top] = ch === "{" ? depth + 1 : depth - 1;
  return false;
}

/**
 * Any other character: copied, and remembered as the code before the cursor.
 * @param {ScanState} state
 * @param {string} ch
 */
function scanPlain(state, ch) {
  emit(state, ch);
  state.i += 1;
  if (/[\w$]/.test(ch)) {
    state.lastWord = state.wordOpen ? state.lastWord + ch : ch;
    state.lastChar = ch;
    state.wordOpen = true;
    return;
  }
  state.wordOpen = false;
  if (!/\s/.test(ch)) {
    state.lastChar = ch;
    state.lastWord = "";
  }
}

/**
 * Splits JavaScript or TypeScript (JSX included) into code and comments.
 * @param {string} source
 * @returns {ScannedSource}
 */
export function scanSource(source) {
  /** @type {ScanState} */
  const state = {
    source,
    i: 0,
    line: 1,
    out: [],
    comments: [],
    templateDepths: [],
    lastChar: "",
    lastWord: "",
    wordOpen: false,
  };
  while (state.i < source.length) {
    const ch = source.charAt(state.i);
    const consumed =
      scanComment(state, ch) ||
      scanQuoted(state, ch) ||
      scanTemplateOpen(state, ch) ||
      scanRegex(state, ch) ||
      scanTemplateBrace(state, ch);
    if (!consumed) scanPlain(state, ch);
  }
  return { code: state.out.join(""), comments: state.comments };
}

/**
 * 1-based line of a character index.
 * @param {string} text
 * @param {number} index
 */
export function lineOf(text, index) {
  let line = 1;
  const stop = Math.min(index, text.length);
  for (let i = 0; i < stop; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** @param {string} ch */
const isQuote = (ch) => ch === '"' || ch === "'" || ch === "`";

/**
 * Where the string or template literal that opens at `start` stops: the index of its closing
 * quote, or `text.length` when it never closes. With `lineBound`, a '…' or "…" literal also stops
 * at a newline, which is where an unterminated one ends.
 * @param {string} text
 * @param {number} start
 * @param {boolean} lineBound
 */
function literalStop(text, start, lineBound) {
  const quote = text.charAt(start);
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === "\\") i += 1;
    if (lineBound && quote !== "`" && text[i] === "\n") break;
    i += 1;
  }
  return i;
}

/**
 * Index of the bracket that closes the one at `openIndex`, skipping string and template
 * literals, or -1.
 * @param {string} text
 * @param {number} openIndex
 */
export function matchingBracket(text, openIndex) {
  const open = text.charAt(openIndex);
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  if (close === undefined) return -1;
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (isQuote(ch)) {
      i = literalStop(text, i, true);
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Every `{…}` pair of `text` as `[open, close]` indexes, string and template literals skipped.
 * `text` must already be free of comments (see {@link scanSource}).
 * @param {string} text
 * @returns {[number, number][]}
 */
export function bracePairs(text) {
  /** @type {[number, number][]} */
  const pairs = [];
  /** @type {number[]} */
  const open = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (isQuote(ch)) {
      i = literalStop(text, i, true);
    } else if (ch === "{") {
      open.push(i);
    } else if (ch === "}") {
      const start = open.pop();
      if (start !== undefined) pairs.push([start, i]);
    }
    i += 1;
  }
  return pairs;
}

/**
 * Splits the inside of an array or argument list at its top-level commas.
 * @param {string} text
 * @returns {{ text: string, index: number }[]}
 */
export function splitTopLevel(text) {
  /** @type {{ text: string, index: number }[]} */
  const parts = [];
  let start = 0;
  let i = 0;
  while (i <= text.length) {
    const ch = text.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") {
      const end = matchingBracket(text, i);
      if (end === -1) break;
      i = end;
    } else if (isQuote(ch)) {
      i = literalStop(text, i, false);
    } else if (ch === "," || i === text.length) {
      const raw = text.slice(start, i);
      if (raw.trim() !== "") {
        parts.push({ text: raw.trim(), index: start + (raw.length - raw.trimStart().length) });
      }
      start = i + 1;
    }
    i += 1;
  }
  return parts;
}

/**
 * Index of the first character at or after `from` that is not white space.
 * @param {string} text
 * @param {number} from
 */
export function skipSpace(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
  return i;
}

/**
 * Index after the identifier characters (`\w` and `$`) that start at `from`.
 * @param {string} text
 * @param {number} from
 */
export function skipWord(text, from) {
  let i = from;
  while (i < text.length && /[\w$]/.test(text.charAt(i))) i += 1;
  return i;
}

/**
 * The identifier characters `text` ends with, "" when it ends with anything else.
 * @param {string} text
 */
function trailingWord(text) {
  let start = text.length;
  while (start > 0 && /[\w$]/.test(text.charAt(start - 1))) start -= 1;
  return text.slice(start);
}

/**
 * The default and namespace names of an import clause, its `{…}` part already removed.
 * @param {string} outside
 */
function defaultAndNamespaceNames(outside) {
  /** @type {string[]} */
  const names = [];
  for (const part of outside.split(",")) {
    const namespace = /\*\s+as\s+([\w$]+)/.exec(part);
    const name = namespace ? namespace[1] : part.trim();
    if (name !== undefined && /^[\w$]+$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * @param {string} clause the text between `import` and `from`
 * @returns {{ names: string[], allTypes: boolean }}
 */
function parseImportClause(clause) {
  const open = clause.indexOf("{");
  const close = open === -1 ? -1 : clause.indexOf("}", open + 1);
  if (close === -1) return { names: defaultAndNamespaceNames(clause), allTypes: false };
  const names = defaultAndNamespaceNames(clause.slice(0, open) + clause.slice(close + 1));
  const members = clause
    .slice(open + 1, close)
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member !== "");
  const values = members.filter((member) => !/^type\s+/.test(member));
  const allTypes = names.length === 0 && members.length > 0 && values.length === 0;
  // `a as b` binds b: the local name is the last word of the member.
  names.push(...values.map(trailingWord).filter((local) => local !== ""));
  return { names, allTypes };
}

/** What an import clause never holds: the first of these after `import` ends it. */
const IMPORT_CLAUSE_STOP = new Set(["'", '"', "`", ";", "(", ")"]);

/**
 * `import [type] <clause> from "<specifier>"` with the `import` keyword at `start`, or null. Read
 * by hand: one regular expression for it backtracks badly on a long clause.
 * @param {string} code
 * @param {number} start
 * @returns {{ end: number, typeKeyword: boolean, clause: string, specifier: string } | null}
 */
function parseFromImport(code, start) {
  const clauseStart = skipSpace(code, start + "import".length);
  let quoteAt = clauseStart;
  while (quoteAt < code.length && !IMPORT_CLAUSE_STOP.has(code.charAt(quoteAt))) quoteAt += 1;
  const quote = code.charAt(quoteAt);
  if (quote !== '"' && quote !== "'") return null;
  const head = code.slice(clauseStart, quoteAt).trimEnd();
  const fromAt = head.length - "from".length;
  if (!head.endsWith("from") || /\w/.test(head.charAt(fromAt - 1))) return null;
  let end = quoteAt + 1;
  while (end < code.length && !/['"\n]/.test(code.charAt(end))) end += 1;
  if (end === quoteAt + 1 || code.charAt(end) !== quote) return null;
  const typePrefix = /^type\s+/.exec(head)?.[0] ?? "";
  return {
    end: end + 1,
    typeKeyword: typePrefix !== "",
    clause: head.slice(typePrefix.length, fromAt).trimEnd(),
    specifier: code.slice(quoteAt + 1, end),
  };
}

/**
 * The other ways to name a module. Patterns of one group are reported in source order; group 1
 * of a re-export is its `type` keyword, and the specifier is the last group of every pattern.
 */
const OTHER_IMPORTS = [
  { reExport: false, patterns: [/\bimport\s*(['"])([^'"\n]+)\1/g] },
  {
    reExport: true,
    patterns: [
      /\bexport\s+(type\s+)?\*(?:\s+as\s+[\w$]+)?\s*from\s*(['"])([^'"\n]+)\2/g,
      /\bexport\s+(type\s+)?\{[^}]*\}\s*from\s*(['"])([^'"\n]+)\2/g,
    ],
  },
  { reExport: false, patterns: [/\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/g] },
  { reExport: false, patterns: [/\brequire\s*\(\s*(['"`])([^'"`\n]+)\1/g] },
];

/**
 * Every module specifier a file pulls in: static imports, re-exports, dynamic `import()` and
 * `require()`. `code` must already be free of comments (see {@link scanSource}).
 * @param {string} code
 * @returns {ImportRef[]}
 */
export function findImports(code) {
  /** @type {ImportRef[]} */
  const found = [];
  let resume = 0;
  for (const keyword of code.matchAll(/\bimport\s/g)) {
    const parsed = keyword.index < resume ? null : parseFromImport(code, keyword.index);
    if (parsed === null) continue;
    resume = parsed.end;
    const clause = parseImportClause(parsed.clause);
    found.push({
      specifier: parsed.specifier,
      line: lineOf(code, keyword.index),
      typeOnly: parsed.typeKeyword || clause.allTypes,
      names: parsed.typeKeyword ? [] : clause.names,
    });
  }
  for (const { patterns, reExport } of OTHER_IMPORTS) {
    const matches = patterns
      .flatMap((pattern) => [...code.matchAll(pattern)])
      .sort((a, b) => a.index - b.index);
    for (const match of matches) {
      found.push({
        specifier: match.at(-1) ?? "",
        line: lineOf(code, match.index),
        typeOnly: reExport && match[1] !== undefined,
        names: [],
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * A comparator for `Array#sort` on strings: UTF-16 code unit order, which is what `sort` does
 * without a comparator, said out loud. Unlike `localeCompare`, it gives the same order on every
 * machine, whatever its locale.
 * @param {string} a
 * @param {string} b
 */
export function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Normalises a POSIX path: resolves "." and ".." segments. Returns null when it climbs out.
 * @param {string} path
 */
export function normalizePath(path) {
  /** @type {string[]} */
  const parts = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/**
 * Repo-relative target of an import, without extension resolution, or null for a package.
 * `@/x` is the `src/x` alias from tsconfig.json.
 * @param {string} fromPath repo-relative path of the importing file
 * @param {string} specifier
 */
export function resolveImport(fromPath, specifier) {
  if (specifier === "@" || specifier.startsWith("@/")) {
    return normalizePath(`src/${specifier.slice(2)}`);
  }
  if (specifier.startsWith(".")) {
    const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
    return normalizePath(`${dir}/${specifier}`);
  }
  return null;
}

/**
 * True when `path` is `dir` itself, a file named after it (`dir.ts`), or anything below it.
 * @param {string | null} path
 * @param {string} dir
 */
export function isUnder(path, dir) {
  if (path === null) return false;
  return path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}.`);
}

/**
 * True for a bare package specifier equal to `name` or a subpath of it.
 * @param {string} specifier
 * @param {string} name
 */
export function isPackage(specifier, name) {
  return specifier === name || specifier.startsWith(`${name}/`);
}
