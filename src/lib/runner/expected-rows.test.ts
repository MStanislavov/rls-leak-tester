import { describe, expect, it } from "vitest";
import { ExpectedRowsSqlError, expectedRowsProbe } from "./expected-rows";
import { NamedParameterError } from "./named-params";

const docs = { schema: "public", name: "docs", primaryKey: ["id"] };
const items = { schema: "public", name: "items", primaryKey: ["Order ID", "line"] };
const values = { sub: "alice", claims: '{"team":"t1"}' };

describe("expectedRowsProbe", () => {
  it("wraps the query and renames its columns to the key by position", () => {
    const probe = expectedRowsProbe(
      docs,
      "select doc_id from shares where user_id = :sub; -- trailing",
      values,
    );
    expect(probe.sql).toBe(
      'select "id"::text as k0 from (\nselect doc_id from shares where user_id = $1\n) as expected_rows("id")',
    );
    expect(probe.params).toEqual(["alice"]);
    expect(probe.inlined).toBe(
      `select "id"::text as k0 from (\nselect doc_id from shares where user_id = 'alice'\n) as expected_rows("id")`,
    );
  });

  it("binds claims as jsonb and handles composite keys", () => {
    const probe = expectedRowsProbe(
      items,
      "select o, l from items where team = :claims ->> 'team' and owner = :sub",
      { sub: null, claims: values.claims },
    );
    expect(probe.sql).toContain(`team = $1::jsonb ->> 'team' and owner = $2`);
    expect(probe.sql).toContain('as expected_rows("Order ID", "line")');
    expect(probe.sql).toContain('select "Order ID"::text as k0, "line"::text as k1 from (');
    expect(probe.params).toEqual([values.claims, null]);
    expect(probe.inlined).toContain("owner = null");
  });

  it("refuses anything but exactly one statement", () => {
    expect(() => expectedRowsProbe(docs, "  -- nothing\n", values)).toThrow(ExpectedRowsSqlError);
    expect(() => expectedRowsProbe(docs, "select 1; select 2", values)).toThrow(
      /exactly one query; it has 2 statements/,
    );
  });

  it("refuses positional parameters", () => {
    expect(() => expectedRowsProbe(docs, "select id from docs where o = $1", values)).toThrow(
      NamedParameterError,
    );
  });
});
