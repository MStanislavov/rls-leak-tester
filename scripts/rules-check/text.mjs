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
 * Splits JavaScript or TypeScript (JSX included) into code and comments.
 * @param {string} source
 * @returns {ScannedSource}
 */
export function scanSource(source) {
  /** @type {string[]} */
  const out = [];
  /** @type {Comment[]} */
  const comments = [];
  /** Open `${` expressions of the enclosing template literals, as brace depths. @type {number[]} */
  const templateDepths = [];
  const length = source.length;
  let line = 1;
  let lastChar = "";
  let lastWord = "";
  /** True while the previous emitted character continued an identifier. */
  let wordOpen = false;
  let i = 0;

  /** @param {string} ch */
  const emit = (ch) => {
    out.push(ch);
    if (ch === "\n") line += 1;
  };
  /** @param {string} text */
  const blank = (text) => {
    for (const ch of text) emit(ch === "\n" ? "\n" : " ");
  };
  /** Copies the body of a template literal up to its closing backtick or the next `${`. */
  const copyTemplateBody = () => {
    while (i < length) {
      const ch = source.charAt(i);
      if (ch === "\\") {
        emit(ch);
        emit(source.charAt(i + 1));
        i += 2;
      } else if (ch === "`") {
        emit(ch);
        i += 1;
        return;
      } else if (ch === "$" && source[i + 1] === "{") {
        emit("$");
        emit("{");
        i += 2;
        templateDepths.push(0);
        return;
      } else {
        emit(ch);
        i += 1;
      }
    }
  };

  while (i < length) {
    const ch = source.charAt(i);
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = length;
      comments.push({ text: source.slice(i, end), line });
      blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let end = source.indexOf("*/", i + 2);
      end = end === -1 ? length : end + 2;
      comments.push({ text: source.slice(i, end), line });
      blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      emit(ch);
      i += 1;
      while (i < length) {
        const inner = source.charAt(i);
        if (inner === "\n") break;
        emit(inner);
        i += 1;
        if (inner === "\\" && i < length) {
          emit(source.charAt(i));
          i += 1;
        } else if (inner === ch) {
          break;
        }
      }
      lastChar = ch;
      lastWord = "";
      continue;
    }
    if (ch === "`") {
      emit(ch);
      i += 1;
      copyTemplateBody();
      lastChar = "`";
      lastWord = "";
      continue;
    }
    if (ch === "/") {
      const regexAllowed =
        lastChar === "" ||
        REGEX_PRECEDING_CHARS.has(lastChar) ||
        REGEX_PRECEDING_WORDS.has(lastWord);
      const end = regexAllowed ? regexLiteralEnd(source, i) : -1;
      if (end !== -1) {
        for (const literalChar of source.slice(i, end)) emit(literalChar);
        i = end;
        lastChar = "/";
        lastWord = "";
        continue;
      }
    }
    if (templateDepths.length > 0 && (ch === "{" || ch === "}")) {
      const top = templateDepths.length - 1;
      const depth = templateDepths[top] ?? 0;
      if (ch === "{") {
        templateDepths[top] = depth + 1;
      } else if (depth === 0) {
        templateDepths.pop();
        emit(ch);
        i += 1;
        copyTemplateBody();
        lastChar = "`";
        lastWord = "";
        continue;
      } else {
        templateDepths[top] = depth - 1;
      }
    }

    emit(ch);
    i += 1;
    if (/[\w$]/.test(ch)) {
      lastWord = wordOpen ? lastWord + ch : ch;
      lastChar = ch;
      wordOpen = true;
    } else {
      wordOpen = false;
      if (!/\s/.test(ch)) {
        lastChar = ch;
        lastWord = "";
      }
    }
  }

  return { code: out.join(""), comments };
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
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
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
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        if (ch !== "`" && text[i] === "\n") break;
        i += 1;
      }
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
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
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        if (ch !== "`" && text[i] === "\n") break;
        i += 1;
      }
    } else if (ch === "{") {
      open.push(i);
    } else if (ch === "}") {
      const start = open.pop();
      if (start !== undefined) pairs.push([start, i]);
    }
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
  for (let i = 0; i <= text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") {
      const end = matchingBracket(text, i);
      if (end === -1) break;
      i = end;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
    } else if (ch === "," || i === text.length) {
      const raw = text.slice(start, i);
      if (raw.trim() !== "") {
        parts.push({ text: raw.trim(), index: start + (raw.length - raw.trimStart().length) });
      }
      start = i + 1;
    }
  }
  return parts;
}

/**
 * @param {string} clause the text between `import` and `from`
 * @returns {{ names: string[], allTypes: boolean }}
 */
function parseImportClause(clause) {
  /** @type {string[]} */
  const names = [];
  let allTypes = false;
  const braces = /\{([^}]*)\}/.exec(clause);
  const outside = braces ? clause.replace(braces[0], "") : clause;
  for (const part of outside.split(",")) {
    const namespace = /\*\s+as\s+([\w$]+)/.exec(part);
    const name = namespace ? namespace[1] : part.trim();
    if (name !== undefined && /^[\w$]+$/.test(name)) names.push(name);
  }
  if (braces) {
    const members = (braces[1] ?? "")
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member !== "");
    allTypes = names.length === 0 && members.length > 0;
    for (const member of members) {
      const isType = /^type\s+/.test(member);
      if (!isType) allTypes = false;
      const local = /([\w$]+)\s*$/.exec(member);
      if (local?.[1] !== undefined && !isType) names.push(local[1]);
    }
  }
  return { names, allTypes };
}

/**
 * Every module specifier a file pulls in: static imports, re-exports, dynamic `import()` and
 * `require()`. `code` must already be free of comments (see {@link scanSource}).
 * @param {string} code
 * @returns {ImportRef[]}
 */
export function findImports(code) {
  /** @type {ImportRef[]} */
  const found = [];
  const fromImport = /\bimport\s+(type\s+)?([^'"`;()]*?)\s*\bfrom\s*(['"])([^'"\n]+)\3/g;
  for (const match of code.matchAll(fromImport)) {
    const clause = parseImportClause(match[2] ?? "");
    found.push({
      specifier: match[4] ?? "",
      line: lineOf(code, match.index),
      typeOnly: match[1] !== undefined || clause.allTypes,
      names: match[1] !== undefined ? [] : clause.names,
    });
  }
  const others = [
    { pattern: /\bimport\s*(['"])([^'"\n]+)\1/g, typeKeyword: 0 },
    {
      pattern:
        /\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g,
      typeKeyword: 1,
    },
    { pattern: /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/g, typeKeyword: 0 },
    { pattern: /\brequire\s*\(\s*(['"`])([^'"`\n]+)\1/g, typeKeyword: 0 },
  ];
  for (const { pattern, typeKeyword } of others) {
    for (const match of code.matchAll(pattern)) {
      found.push({
        specifier: match[typeKeyword === 1 ? 3 : 2] ?? "",
        line: lineOf(code, match.index),
        typeOnly: typeKeyword === 1 && match[1] !== undefined,
        names: [],
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
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
