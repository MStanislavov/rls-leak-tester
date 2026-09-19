import { describe, expect, it } from "vitest";
import { NamedParameterError, inlineNamedParameters, rewriteNamedParameters } from "./named-params";

describe("rewriteNamedParameters", () => {
  it("numbers the parameters in order of first appearance", () => {
    expect(rewriteNamedParameters("select id from t where a = :sub and b = :sub")).toEqual({
      sql: "select id from t where a = $1 and b = $1",
      order: ["sub"],
    });
    expect(rewriteNamedParameters("select :claims ->> 'x', :sub, :claims")).toEqual({
      sql: "select $1::jsonb ->> 'x', $2, $1::jsonb",
      order: ["claims", "sub"],
    });
  });

  it("leaves a query without them unchanged", () => {
    expect(rewriteNamedParameters("select 1")).toEqual({ sql: "select 1", order: [] });
  });

  it("does not touch casts", () => {
    expect(rewriteNamedParameters("select x::sub, :sub::uuid, y::claims from t").sql).toBe(
      "select x::sub, $1::uuid, y::claims from t",
    );
  });

  it("does not touch strings, escape strings and quoted identifiers", () => {
    const sql = `select ':sub', 'it''s :sub', E'a\\':sub', ":claims", U&':sub' from t where a = :sub`;
    expect(rewriteNamedParameters(sql).sql).toBe(
      `select ':sub', 'it''s :sub', E'a\\':sub', ":claims", U&':sub' from t where a = $1`,
    );
  });

  it("treats a backslash as an escape only in an E string", () => {
    // In a standard string the backslash ends nothing: the string is `a\` and :sub follows.
    expect(rewriteNamedParameters(`select 'a\\', :sub`).sql).toBe(`select 'a\\', $1`);
    // `name'...'` is not an escape string: the e belongs to an identifier.
    expect(rewriteNamedParameters(`select type'a\\', :sub`).sql).toBe(`select type'a\\', $1`);
  });

  it("does not touch comments and dollar-quoted bodies", () => {
    const sql =
      "select 1 -- :sub\n, /* :sub /* nested :claims */ still */ $fn$ :sub $fn$, $$:claims$$, :sub";
    expect(rewriteNamedParameters(sql)).toEqual({
      sql: "select 1 -- :sub\n, /* :sub /* nested :claims */ still */ $fn$ :sub $fn$, $$:claims$$, $1",
      order: ["sub"],
    });
  });

  it("copies unterminated runs to the end", () => {
    expect(rewriteNamedParameters("select 'open :sub").sql).toBe("select 'open :sub");
    expect(rewriteNamedParameters("select /* open :sub").sql).toBe("select /* open :sub");
    expect(rewriteNamedParameters("select $a$ open :sub").sql).toBe("select $a$ open :sub");
    expect(rewriteNamedParameters("select 1 -- :sub").sql).toBe("select 1 -- :sub");
  });

  it("leaves other names and lone colons to Postgres", () => {
    expect(rewriteNamedParameters("select :subject, :other, a[1:2], :").sql).toBe(
      "select :subject, :other, a[1:2], :",
    );
  });

  it("an identifier with a dollar sign is not a dollar quote", () => {
    expect(rewriteNamedParameters("select a$b$ from t where x = :sub").sql).toBe(
      "select a$b$ from t where x = $1",
    );
  });

  it("refuses a positional parameter", () => {
    expect(() => rewriteNamedParameters("select id from t where a = $1")).toThrow(
      NamedParameterError,
    );
  });
});

describe("inlineNamedParameters", () => {
  it("puts the values in as literals, claims as jsonb", () => {
    expect(
      inlineNamedParameters("select id from t where o = :sub and t = :claims ->> 't'", {
        sub: "o'hara",
        claims: '{"t":"1"}',
      }),
    ).toBe(`select id from t where o = 'o''hara' and t = '{"t":"1"}'::jsonb ->> 't'`);
  });

  it("inlines a missing sub as null", () => {
    expect(inlineNamedParameters("select :sub", { sub: null, claims: "{}" })).toBe("select null");
  });
});
