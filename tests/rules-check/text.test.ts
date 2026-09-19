import { describe, expect, it } from "vitest";

import {
  findImports,
  isPackage,
  isUnder,
  lineOf,
  matchingBracket,
  normalizePath,
  resolveImport,
  scanSource,
  splitTopLevel,
} from "../../scripts/rules-check/text.mjs";

import { lines } from "./helpers";

describe("scanSource", () => {
  it("blanks comments, keeps the code and keeps every line number", () => {
    const input = lines("const a = 1; // trailing", "/* block", "   comment */ const b = 2;");
    const { code, comments } = scanSource(input);
    expect(code.split("\n")).toHaveLength(input.split("\n").length);
    expect(code).toContain("const a = 1;");
    expect(code).toContain("const b = 2;");
    expect(code).not.toContain("trailing");
    expect(code).not.toContain("comment");
    expect(comments).toEqual([
      { text: "// trailing", line: 1 },
      { text: "/* block\n   comment */", line: 2 },
    ]);
  });

  it("does not mistake a glob or a URL inside a string for a comment", () => {
    const input = 'const ignores = [".next/**", "out/**"]; const url = "http://localhost:3100";';
    const { code, comments } = scanSource(input);
    expect(code).toBe(input);
    expect(comments).toEqual([]);
  });

  it("keeps a regular expression literal that contains two slashes", () => {
    const input = "const isUrl = /^https?:\\/\\//.test(value); // checked";
    const { code, comments } = scanSource(input);
    expect(code).toContain("/^https?:\\/\\//.test(value);");
    expect(comments.map((comment) => comment.text)).toEqual(["// checked"]);
  });

  it("recognises a regular expression after a keyword and a division after a value", () => {
    expect(scanSource("return /a\\/\\/b/.test(x);").comments).toEqual([]);
    const division = scanSource("const half = total / 2; // half of it");
    expect(division.comments.map((comment) => comment.text)).toEqual(["// half of it"]);
  });

  it("follows template literals through nested expressions", () => {
    const input = "const s = `a ${fn({ b: `inner // not a comment` })} c`; // real";
    const { code, comments } = scanSource(input);
    expect(code).toContain("inner // not a comment");
    expect(comments.map((comment) => comment.text)).toEqual(["// real"]);
  });

  it("ends an unterminated quote at the end of the line", () => {
    const { comments } = scanSource(lines("<p>Don't panic</p>", "// still a comment"));
    expect(comments.map((comment) => comment.text)).toEqual(["// still a comment"]);
  });

  it("survives an unterminated block comment and template literal", () => {
    expect(scanSource("const a = 1; /* never closed").comments).toHaveLength(1);
    expect(scanSource("const a = `never closed ${").code).toContain("never closed");
  });
});

describe("findImports", () => {
  it("finds every way a module can be pulled in", () => {
    const code = lines(
      'import first, { second as renamed, type Third } from "pkg";',
      'import * as everything from "./local";',
      'import type { OnlyType } from "@/lib/types";',
      'import { type A, type B } from "@/lib/more-types";',
      'import "side-effect";',
      'export * from "../re-export";',
      'export type { T } from "./type-re-export";',
      'const lazy = await import("dynamic");',
      'const old = require("required");',
    );
    expect(findImports(code)).toEqual([
      { specifier: "pkg", line: 1, typeOnly: false, names: ["first", "renamed"] },
      { specifier: "./local", line: 2, typeOnly: false, names: ["everything"] },
      { specifier: "@/lib/types", line: 3, typeOnly: true, names: [] },
      { specifier: "@/lib/more-types", line: 4, typeOnly: true, names: [] },
      { specifier: "side-effect", line: 5, typeOnly: false, names: [] },
      { specifier: "../re-export", line: 6, typeOnly: false, names: [] },
      { specifier: "./type-re-export", line: 7, typeOnly: true, names: [] },
      { specifier: "dynamic", line: 8, typeOnly: false, names: [] },
      { specifier: "required", line: 9, typeOnly: false, names: [] },
    ]);
  });

  it("reads an import that spans lines", () => {
    const code = lines("import {", "  parseBody,", "  validateSlug,", '} from "@/lib/api";');
    expect(findImports(code)).toEqual([
      {
        specifier: "@/lib/api",
        line: 1,
        typeOnly: false,
        names: ["parseBody", "validateSlug"],
      },
    ]);
  });
});

describe("path helpers", () => {
  it("resolves the @ alias and relative specifiers, and leaves packages alone", () => {
    expect(resolveImport("src/app/api/explain/route.ts", "@/lib/redis")).toBe("src/lib/redis");
    expect(resolveImport("src/app/api/explain/route.ts", "../../../lib/ai/explain")).toBe(
      "src/lib/ai/explain",
    );
    expect(resolveImport("src/lib/ai/index.ts", "./model")).toBe("src/lib/ai/model");
    expect(resolveImport("route.ts", "./sibling")).toBe("sibling");
    expect(resolveImport("src/a.ts", "zod")).toBeNull();
    expect(resolveImport("src/a.ts", "../../outside")).toBeNull();
  });

  it("normalises paths and refuses to climb out", () => {
    expect(normalizePath("src/./lib//x/../y")).toBe("src/lib/y");
    expect(normalizePath("../x")).toBeNull();
  });

  it("knows what lies under a directory", () => {
    expect(isUnder("src/lib/redis", "src/lib/redis")).toBe(true);
    expect(isUnder("src/lib/redis/keys", "src/lib/redis")).toBe(true);
    expect(isUnder("src/lib/store.ts", "src/lib/store")).toBe(true);
    expect(isUnder("src/lib/redis-tools/x", "src/lib/redis")).toBe(false);
    expect(isUnder(null, "src/lib/redis")).toBe(false);
  });

  it("matches a package and its subpaths only", () => {
    expect(isPackage("pg", "pg")).toBe(true);
    expect(isPackage("pg/lib/client", "pg")).toBe(true);
    expect(isPackage("pglite", "pg")).toBe(false);
  });
});

describe("small parsers", () => {
  it("counts lines from one", () => {
    expect(lineOf("a\nb\nc", 0)).toBe(1);
    expect(lineOf("a\nb\nc", 4)).toBe(3);
    expect(lineOf("a", 99)).toBe(1);
  });

  it("finds the matching bracket and skips strings", () => {
    const text = 'call(a, ")", [1, 2])';
    expect(matchingBracket(text, 4)).toBe(text.length - 1);
    expect(matchingBracket("(never closed", 0)).toBe(-1);
    expect(matchingBracket("x", 0)).toBe(-1);
  });

  it("splits at top-level commas only", () => {
    expect(splitTopLevel('"a,b", fn(1, 2), [3, 4], last').map((part) => part.text)).toEqual([
      '"a,b"',
      "fn(1, 2)",
      "[3, 4]",
      "last",
    ]);
    expect(splitTopLevel("  ")).toEqual([]);
  });
});
