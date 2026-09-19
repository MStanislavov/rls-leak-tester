import { describe, expect, it } from "vitest";

import { qualifiedName, quoteIdent, quoteLiteral } from "./ident";

describe("quoteIdent", () => {
  it.each([
    ["notes", '"notes"'],
    ["Notes", '"Notes"'],
    ["select", '"select"'],
    ["user", '"user"'],
    ["my table", '"my table"'],
    ['we"ird', '"we""ird"'],
    ['"', '""""'],
    ['""', '""""""'],
    ["it's", '"it\'s"'],
    ["back\\slash", '"back\\slash"'],
    ["semi;colon--", '"semi;colon--"'],
    ["new\nline", '"new\nline"'],
    ["ünï€", '"ünï€"'],
    ["$1", '"$1"'],
  ])("quotes %j as %s", (name, expected) => {
    expect(quoteIdent(name)).toBe(expected);
  });

  it("refuses what Postgres cannot represent", () => {
    expect(() => quoteIdent("")).toThrow(RangeError);
    expect(() => quoteIdent("a\0b")).toThrow(/NUL/);
  });
});

describe("quoteLiteral", () => {
  it.each([
    ["", "''"],
    ["plain", "'plain'"],
    ["it's", "'it''s'"],
    ["''", "''''''"],
    ['say "hi"', "'say \"hi\"'"],
    ["a;b -- c /* d */", "'a;b -- c /* d */'"],
    ["$$body$$", "'$$body$$'"],
    ["line\nbreak", "'line\nbreak'"],
    ["ünï€", "'ünï€'"],
    ["back\\slash", "E'back\\\\slash'"],
    ["\\'", "E'\\\\'''"],
    ["\\", "E'\\\\'"],
  ])("quotes %j as %s", (value, expected) => {
    expect(quoteLiteral(value)).toBe(expected);
  });

  it("refuses a NUL character", () => {
    expect(() => quoteLiteral("a\0")).toThrow(RangeError);
  });
});

describe("qualifiedName", () => {
  it("quotes both parts", () => {
    expect(qualifiedName("public", "notes")).toBe('"public"."notes"');
    expect(qualifiedName("My.Schema", 'ta"ble')).toBe('"My.Schema"."ta""ble"');
  });

  it("refuses an empty part", () => {
    expect(() => qualifiedName("", "notes")).toThrow(RangeError);
    expect(() => qualifiedName("public", "")).toThrow(RangeError);
  });
});
