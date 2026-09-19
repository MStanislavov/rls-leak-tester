/**
 * The quoting helpers and the statement splitter checked against a real Postgres (PGlite): what
 * they produce must mean to Postgres exactly what was put in.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { qualifiedName, quoteIdent, quoteLiteral } from "./ident";
import { splitSqlStatements } from "./sql-split";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
}, 60_000);

afterAll(async () => {
  await db.close();
});

const NASTY = [
  "plain",
  "Upper Case",
  "select",
  "user",
  'dou"ble',
  '"',
  "sin'gle",
  "back\\slash",
  "\\'; drop table x; --",
  "semi;colon",
  "-- comment",
  "/* block */",
  "$$dollar$$",
  "line\nbreak\ttab",
  "ünï€ 🌍",
  "E'x'",
  " leading and trailing ",
];

describe("quoteLiteral against Postgres", () => {
  it.each([["on"], ["off"]])(
    "round-trips every value with standard_conforming_strings = %s",
    async (setting) => {
      await db.exec(`set standard_conforming_strings = ${setting}`);
      try {
        for (const value of [...NASTY, ""]) {
          const result = await db.query<{ v: string }>(`select ${quoteLiteral(value)} as v`);
          expect(result.rows[0]?.v).toBe(value);
        }
      } finally {
        await db.exec("reset standard_conforming_strings");
      }
    },
  );

  it("agrees with quote_literal", async () => {
    for (const value of NASTY) {
      const result = await db.query<{ v: string }>("select quote_literal($1::text) as v", [value]);
      expect(quoteLiteral(value)).toBe(result.rows[0]?.v);
    }
  });
});

describe("quoteIdent and qualifiedName against Postgres", () => {
  it("creates and finds objects whose names need quoting", async () => {
    for (const [index, name] of NASTY.entries()) {
      const schema = `${name} s${index}`;
      await db.exec(`create schema ${quoteIdent(schema)}`);
      await db.exec(`create table ${qualifiedName(schema, name)} (${quoteIdent(name)} int)`);
      await db.exec(`insert into ${qualifiedName(schema, name)} (${quoteIdent(name)}) values (7)`);
      const columns = await db.query<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = $1",
        [schema],
      );
      expect(columns.rows).toEqual([{ table_name: name, column_name: name }]);
      const regclass = await db.query<{ oid: number }>("select $1::regclass::oid as oid", [
        qualifiedName(schema, name),
      ]);
      expect(regclass.rows[0]?.oid).toBeGreaterThan(0);
    }
  });

  it("matches quote_ident wherever quote_ident decides to quote", async () => {
    for (const name of NASTY) {
      const result = await db.query<{ v: string }>("select quote_ident($1::text) as v", [name]);
      const theirs = result.rows[0]?.v ?? "";
      expect(theirs.startsWith('"') ? theirs : `"${theirs}"`).toBe(quoteIdent(name));
    }
  });
});

const SCRIPT = `
-- A schema; with 'quotes' in the comment
create schema split_test;
set search_path = split_test;

/* block; comment /* nested; */ still; */
create table notes (
  id int primary key,
  body text default 'semi;colon',   -- trailing; comment
  "odd;name" text default E'it\\'s; escaped'
);

create function touch() returns trigger language plpgsql as $fn$
begin
  -- it's a comment; with a quote
  new.body := coalesce(new.body, '') || ';';
  return new;
end;
$fn$;

create trigger notes_touch before insert on notes for each row execute function touch();

create function add_two(note text) returns void language sql
begin atomic
  insert into notes (id, body) values (1, note);
  insert into notes (id, body) values (2, case when note = ';' then 'a' else 'b;' end);
end;

do $$
begin
  perform add_two('x;y');
  if (select count(*) from notes) <> 2 then
    raise exception 'expected 2 rows; got something else';
  end if;
end
$$;

create rule notes_log as on delete to notes do also (select 1; select 2);

insert into notes (id, body, "odd;name") values (3, $body$ dollar; $$ body $body$, U&'d\\0061ta;')
`;

describe("splitSqlStatements against Postgres", () => {
  it("yields statements that Postgres runs one by one, with the same effect as the script", async () => {
    const statements = splitSqlStatements(SCRIPT);
    expect(
      statements.map((statement) => statement.text.split(/\s+/).slice(0, 2).join(" ")),
    ).toEqual([
      "create schema",
      "set search_path",
      "create table",
      "create function",
      "create trigger",
      "create function",
      "do $$",
      "create rule",
      "insert into",
    ]);
    for (const statement of statements) {
      await db.exec(statement.text);
    }
    const rows = await db.query<{ id: number; body: string; odd: string }>(
      'select id, body, "odd;name" as odd from split_test.notes order by id',
    );
    expect(rows.rows).toEqual([
      { id: 1, body: "x;y;", odd: "it's; escaped" },
      { id: 2, body: "b;;", odd: "it's; escaped" },
      { id: 3, body: " dollar; $$ body ;", odd: "data;" },
    ]);
    await db.exec("reset search_path");
  });

  it("reports the line of the statement that fails", async () => {
    const script =
      "create table split_ok (id int);\n\n-- next one is wrong\nselect * from nowhere;";
    const failures: { line: number; code: unknown }[] = [];
    for (const statement of splitSqlStatements(script)) {
      try {
        await db.exec(statement.text);
      } catch (error) {
        failures.push({
          line: statement.line,
          code: error instanceof Error && "code" in error ? error.code : undefined,
        });
      }
    }
    expect(failures).toEqual([{ line: 4, code: "42P01" }]);
  });
});
