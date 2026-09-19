import { describe, expect, it } from "vitest";
import {
  CLAIMS_SETTING,
  RESET_ROLE_PROBE,
  WHOAMI_PROBE,
  deleteBlindProbe,
  deleteReachProbe,
  deleteRowProbe,
  escapeBulkProbe,
  escapeTargetedProbe,
  identityProbes,
  insertCloneProbe,
  parseKey,
  pullBlindProbe,
  pullRowProbe,
  renderProbeScript,
  rowVersionsProbe,
  rowsEqualToProbe,
  rowsWithValueProbe,
  selectCountProbe,
  selectReachProbe,
  sourceCopyProbe,
  sourceGrantProbe,
  staticProbe,
  updateBlindProbe,
  updateReachProbe,
  updateRowProbe,
  type ProbeTable,
} from "./probes";

const docs: ProbeTable = { schema: "public", name: "docs", primaryKey: ["id"] };
const items: ProbeTable = {
  schema: "Shop",
  name: 'Order "Items"',
  primaryKey: ["Order ID", "line"],
};

const PINS =
  "select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true), set_config('request.jwt.claim.email', '', true), set_config('request.jwt.claim', '', true), set_config('row_security', 'on', true), set_config('TimeZone', 'UTC', true)";

describe("identity probes", () => {
  it("pin what a probe must not inherit from the session, transaction-locally", () => {
    const [, , pins] = identityProbes({ role: "authenticated", claimsJson: "{}" });
    expect(pins).toEqual(staticProbe(PINS));
    // Every setting is local to the transaction: nothing of it survives the rollback.
    expect(pins.sql.match(/set_config\(/g)).toHaveLength(6);
    expect(pins.sql.match(/, true\)/g)).toHaveLength(6);
  });

  it("switch role and claims transaction-locally, with the values as text parameters", () => {
    const [role, claims] = identityProbes({ role: "authenticated", claimsJson: '{"sub":"a"}' });
    expect(role).toEqual({
      sql: "select set_config('role', $1::text, true)",
      params: ["authenticated"],
      inlined: "select set_config('role', 'authenticated', true)",
    });
    expect(claims.sql).toBe(`select set_config('${CLAIMS_SETTING}', $1::text, true)`);
    expect(claims.params).toEqual(['{"sub":"a"}']);
    expect(claims.inlined).toBe(`select set_config('request.jwt.claims', '{"sub":"a"}', true)`);
  });

  it("keeps a hostile role name and hostile claims inside their literals", () => {
    const [role, claims] = identityProbes({
      role: "x', true); drop table docs; --",
      claimsJson: `{"sub":"o'hara\\\\"}`,
    });
    expect(role.inlined).toBe("select set_config('role', 'x'', true); drop table docs; --', true)");
    expect(role.sql).not.toContain("drop table");
    expect(claims.inlined).toContain(`E'{"sub":"o''hara\\\\\\\\"}'`);
  });

  it("has fixed whoami and reset statements", () => {
    expect(WHOAMI_PROBE.sql).toBe(
      "select current_user::text as role, session_user::text as session_role, current_setting('row_security') as row_security",
    );
    expect(RESET_ROLE_PROBE).toEqual(staticProbe("reset role"));
  });
});

describe("reach probes", () => {
  it("select, update and delete read the key with the ground truth's spelling", () => {
    expect(selectReachProbe(docs).sql).toBe('select "id"::text as k0 from "public"."docs"');
    expect(updateReachProbe(docs, "title").sql).toBe(
      'update "public"."docs" set "title" = "title" returning "id"::text as k0',
    );
    expect(deleteReachProbe(docs).sql).toBe(
      'delete from "public"."docs" returning "id"::text as k0',
    );
    expect(deleteBlindProbe(docs)).toEqual(staticProbe('delete from "public"."docs"'));
  });

  it("quotes every identifier, composite keys included", () => {
    expect(selectReachProbe(items).sql).toBe(
      'select "Order ID"::text as k0, "line"::text as k1 from "Shop"."Order ""Items"""',
    );
    expect(updateReachProbe(items, 'a"b').sql).toContain('set "a""b" = "a""b" returning');
  });

  it("addresses one row by its serialised key, every key column as text", () => {
    const probe = updateRowProbe(items, "qty", '["7","2"]');
    expect(probe.sql).toBe(
      'update "Shop"."Order ""Items""" set "qty" = "qty" where "Order ID"::text = $1::text and "line"::text = $2::text returning "Order ID"::text as k0, "line"::text as k1',
    );
    expect(probe.params).toEqual(["7", "2"]);
    expect(probe.inlined).toContain(`where "Order ID"::text = '7' and "line"::text = '2'`);
    expect(deleteRowProbe(docs, JSON.stringify(["it's"])).inlined).toBe(
      `delete from "public"."docs" where "id"::text = 'it''s' returning "id"::text as k0`,
    );
  });

  it("refuses a key that does not fit the table", () => {
    expect(() => updateRowProbe(docs, "title", '["1","2"]')).toThrow(RangeError);
    expect(() => deleteRowProbe(docs, "not json")).toThrow(TypeError);
  });
});

describe("parseKey", () => {
  it("reads the serialised key back", () => {
    expect(parseKey('["7","b"]')).toEqual(["7", "b"]);
  });

  it.each(["[]", "[1]", '{"a":1}', '"x"', "null", "{"])("throws for %s", (text) => {
    expect(() => parseKey(text)).toThrow(TypeError);
  });
});

describe("scope-escape probes", () => {
  const move = { column: "tenant_id", type: "integer", value: "2" };

  it("shape 1 moves one row with WHERE and RETURNING", () => {
    const probe = escapeTargetedProbe(docs, move, '["1"]');
    expect(probe.sql).toBe(
      'update "public"."docs" set "tenant_id" = $1::text::integer where "id"::text = $2::text returning "id"::text as k0',
    );
    expect(probe.params).toEqual(["2", "1"]);
    expect(probe.inlined).toBe(
      `update "public"."docs" set "tenant_id" = '2'::integer where "id"::text = '1' returning "id"::text as k0`,
    );
  });

  it("shape 2 has neither WHERE nor RETURNING", () => {
    const probe = escapeBulkProbe(docs, move);
    expect(probe.sql).toBe('update "public"."docs" set "tenant_id" = $1::text::integer');
    expect(probe.sql).not.toMatch(/where|returning/i);
    expect(probe.inlined).toBe(`update "public"."docs" set "tenant_id" = '2'::integer`);
  });

  it("the read-back compares the column as text", () => {
    const probe = rowsWithValueProbe(docs, "tenant_id", "2");
    expect(probe.sql).toBe(
      'select "id"::text as k0 from "public"."docs" where "tenant_id"::text = $1::text',
    );
    expect(probe.params).toEqual(["2"]);
  });
});

describe("takeover probes", () => {
  const moves = [
    { column: "Owner", type: "uuid", value: "11111111-1111-4111-8111-111111111111" },
    { column: "tenant_id", type: "integer", value: "1" },
  ];

  it("sets the owner and tenant columns of one row to the persona's values", () => {
    const probe = pullRowProbe(docs, moves, '["3"]');
    expect(probe.sql).toBe(
      'update "public"."docs" set "Owner" = $1::text::uuid, "tenant_id" = $2::text::integer where "id"::text = $3::text returning "id"::text as k0',
    );
    expect(probe.params).toEqual(["11111111-1111-4111-8111-111111111111", "1", "3"]);
  });

  it("the blind variant has neither WHERE nor RETURNING", () => {
    const probe = pullBlindProbe(docs, moves.slice(0, 1));
    expect(probe.inlined).toBe(
      `update "public"."docs" set "Owner" = '11111111-1111-4111-8111-111111111111'::uuid`,
    );
  });
});

describe("the source row and what reads from it", () => {
  it("the superuser copies one seeded row and lets the role read it", () => {
    const copy = sourceCopyProbe(items, '["7","2"]');
    expect(copy.sql).toBe(
      'create temporary table "rls_leak_tester_source" on commit drop as select * from "Shop"."Order ""Items""" where "Order ID"::text = $1::text and "line"::text = $2::text',
    );
    expect(copy.params).toEqual(["7", "2"]);
    expect(sourceGrantProbe('app "user"').sql).toBe(
      'grant select on pg_temp."rls_leak_tester_source" to "app ""user"""',
    );
  });

  it("the insert clone takes every value from the source row, and names no type but the key's", () => {
    const probe = insertCloneProbe(docs, ["id", "Owner", "title"], {
      column: "id",
      type: "integer",
      value: "1003",
    });
    expect(probe.sql).toBe(
      'insert into "public"."docs" ("id", "Owner", "title") select $1::text::integer, "Owner", "title" from pg_temp."rls_leak_tester_source"',
    );
    expect(probe.params).toEqual(["1003"]);
    expect(probe.inlined).toContain(`select '1003'::integer, "Owner", "title" from`);
    expect(probe.sql).not.toMatch(/returning/i);
  });

  it("a key that takes its default is not named; without columns it is DEFAULT VALUES", () => {
    expect(insertCloneProbe(docs, ["title"], null).sql).toBe(
      'insert into "public"."docs" ("title") select "title" from pg_temp."rls_leak_tester_source"',
    );
    expect(insertCloneProbe(docs, [], null).sql).toBe('insert into "public"."docs" default values');
  });

  it("the blind update reads no column of the table: no WHERE, no RETURNING, no col = col", () => {
    expect(updateBlindProbe(docs, "title").sql).toBe(
      'update "public"."docs" set "title" = (select "title" from pg_temp."rls_leak_tester_source")',
    );
  });

  it("row versions are read with the key, for the superuser's before and after", () => {
    expect(rowVersionsProbe(docs).sql).toBe(
      `select "id"::text as k0, tableoid::text || ':' || ctid::text as row_version from "public"."docs"`,
    );
  });
});

describe("select count and scope membership", () => {
  it("counts the visible rows without naming a column", () => {
    expect(selectCountProbe(docs).sql).toBe(
      'select count(*)::text as visible_rows from "public"."docs"',
    );
  });

  it("lets Postgres compare a claim with a column, in the column's type", () => {
    const probe = rowsEqualToProbe(docs, { column: "Owner", type: "uuid", value: "AAAA" });
    expect(probe.sql).toBe(
      'select "id"::text as k0 from "public"."docs" where "Owner" = $1::text::uuid',
    );
    expect(probe.params).toEqual(["AAAA"]);
  });
});

describe("renderProbeScript", () => {
  it("is a complete, rolled-back transaction with literals inlined", () => {
    const script = renderProbeScript({ role: "app", claimsJson: '{"sub":"a"}' }, [
      selectReachProbe(docs),
      deleteRowProbe(docs, '["1"]'),
    ]);
    expect(script.split("\n")).toEqual([
      "begin;",
      "select set_config('role', 'app', true);",
      `select set_config('request.jwt.claims', '{"sub":"a"}', true);`,
      `${PINS};`,
      'select "id"::text as k0 from "public"."docs";',
      `delete from "public"."docs" where "id"::text = '1' returning "id"::text as k0;`,
      "rollback;",
    ]);
  });
});
