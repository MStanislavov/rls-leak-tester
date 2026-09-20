import { describe, expect, it } from "vitest";
import {
  commentLine,
  dollarQuote,
  jsonbLiteral,
  keysLiteral,
  statementArray,
  textArray,
} from "./sql-text";

describe("commentLine", () => {
  it("keeps a value on one line, whatever line break it carries", () => {
    const separators = [0x2028, 0x2029, 0x85].map((code) => String.fromCharCode(code));
    const hostile = `Title\n; drop table users; --\r\nnext${separators[0]}line${separators[1]}end${separators[2]}x\ttab`;
    const line = commentLine(hostile);
    expect(line).toBe("Title ; drop table users; -- next line end x tab");
    expect([...line].every((character) => character >= " " && character <= "~")).toBe(true);
  });

  it("trims and leaves ordinary text alone", () => {
    expect(commentLine("  Multi-tenant SaaS (leaky)  ")).toBe("Multi-tenant SaaS (leaky)");
  });
});

describe("dollarQuote", () => {
  it("wraps a statement without touching it", () => {
    expect(dollarQuote(`select "id" from "t" where x = 'a'`)).toBe(
      `$sql$select "id" from "t" where x = 'a'$sql$`,
    );
  });

  it("picks another tag when the text holds the delimiter", () => {
    expect(dollarQuote("select '$sql$'")).toBe("$sql1$select '$sql$'$sql1$");
    expect(dollarQuote("select '$sql$ and $sql1$'")).toBe("$sql2$select '$sql$ and $sql1$'$sql2$");
  });

  it("picks another tag when the end of the text would close the quote early", () => {
    // `$sql$...$sql` + `$sql$` would end at the first `$sql$`, four characters too soon.
    expect(dollarQuote("select '$sql")).toBe("$sql1$select '$sql$sql1$");
    // A trailing dollar sign is fine: the scanner puts it back and finds the delimiter after it.
    expect(dollarQuote("select '$")).toBe("$sql$select '$$sql$");
  });

  it("takes the base of the tag", () => {
    expect(dollarQuote("begin end", "rls")).toBe("$rls$begin end$rls$");
    expect(dollarQuote("$rls$", "rls")).toBe("$rls1$$rls$$rls1$");
  });
});

describe("literals", () => {
  it("statementArray: one dollar-quoted statement per line, typed when empty", () => {
    expect(statementArray([], "  ")).toBe("array[]::text[]");
    expect(statementArray(["select 1", "select 2"], "  ")).toBe(
      "array[\n    $sql$select 1$sql$,\n    $sql$select 2$sql$\n  ]::text[]",
    );
  });

  it("textArray quotes every value", () => {
    expect(textArray([])).toBe("array[]::text[]");
    expect(textArray(["anon", "o'brien", "a\\b"])).toBe(
      "array['anon', 'o''brien', E'a\\\\b']::text[]",
    );
  });

  it("jsonbLiteral survives quotes and backslashes", () => {
    expect(jsonbLiteral({ label: "it's" })).toBe(`'{"label":"it''s"}'::jsonb`);
    expect(jsonbLiteral(['a"b'])).toBe(`E'["a\\\\"b"]'::jsonb`);
  });

  it("keysLiteral turns serialised keys into an array of key arrays, in the given order", () => {
    expect(keysLiteral([])).toBe("'[]'::jsonb");
    expect(keysLiteral(['["7"]', '["3","b"]'])).toBe(`'[["7"],["3","b"]]'::jsonb`);
    expect(() => keysLiteral(["7"])).toThrow(TypeError);
  });
});
