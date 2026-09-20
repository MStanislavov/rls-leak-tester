import { describe, expect, it } from "vitest";

import { offsetToPosition, splitSqlStatements } from "./sql-split";

function texts(sql: string): string[] {
  return splitSqlStatements(sql).map((statement) => statement.text);
}

describe("splitSqlStatements: the basics", () => {
  it("splits on semicolons and drops them", () => {
    expect(texts("select 1; select 2;select 3")).toEqual(["select 1", "select 2", "select 3"]);
  });

  it("returns nothing for empty, blank and comment-only scripts", () => {
    expect(texts("")).toEqual([]);
    expect(texts("  \n\t \r\n")).toEqual([]);
    expect(texts(";;; ;\n;")).toEqual([]);
    expect(texts("-- just a comment")).toEqual([]);
    expect(texts("/* a */ -- b\n ; /* c; */ ;")).toEqual([]);
  });

  it("keeps a last statement without a semicolon", () => {
    expect(texts("select 1;\nselect 2  \n")).toEqual(["select 1", "select 2"]);
  });

  it("reports index, offsets, line and column of every statement", () => {
    const sql = "select 1;\n\n  select\n  2;\r\n\tselect 3";
    const statements = splitSqlStatements(sql);
    expect(statements).toEqual([
      { index: 0, text: "select 1", start: 0, end: 8, line: 1, column: 1 },
      { index: 1, text: "select\n  2", start: 13, end: 23, line: 3, column: 3 },
      { index: 2, text: "select 3", start: 27, end: 35, line: 5, column: 2 },
    ]);
    for (const statement of statements) {
      expect(sql.slice(statement.start, statement.end)).toBe(statement.text);
    }
  });

  it("starts a statement after its leading comments and ends it before trailing ones", () => {
    const sql = "-- header\n/* block */ select 1 -- why\n /* later */ ;\n-- next\nselect 2;";
    const statements = splitSqlStatements(sql);
    expect(statements.map((s) => s.text)).toEqual(["select 1", "select 2"]);
    expect(statements.map((s) => s.line)).toEqual([2, 5]);
    expect(statements[0]?.column).toBe(13);
  });

  it("keeps comments in the middle of a statement", () => {
    expect(texts("select 1 -- one;\n  + 2 /* two; */ + 3;")).toEqual([
      "select 1 -- one;\n  + 2 /* two; */ + 3",
    ]);
  });

  it("splits a realistic schema script", () => {
    const sql = `
      create table public.notes (id uuid primary key default gen_random_uuid(), body text);
      alter table public.notes enable row level security;
      create policy "read; own" on public.notes for select using (auth.uid() = user_id);
    `;
    expect(texts(sql)).toEqual([
      "create table public.notes (id uuid primary key default gen_random_uuid(), body text)",
      "alter table public.notes enable row level security",
      'create policy "read; own" on public.notes for select using (auth.uid() = user_id)',
    ]);
  });
});

describe("splitSqlStatements: comments", () => {
  it("ignores semicolons in line comments, for every kind of line ending", () => {
    expect(texts("select 1 -- a; b\n; select 2")).toEqual(["select 1", "select 2"]);
    expect(texts("select 1 -- a; b\r\n; select 2")).toEqual(["select 1", "select 2"]);
    expect(texts("select 1 -- a; b\r; select 2")).toEqual(["select 1", "select 2"]);
    expect(texts("select 1; -- trailing; comment")).toEqual(["select 1"]);
  });

  it("ignores semicolons in block comments", () => {
    expect(texts("select /* ; */ 1; /* ; ; */ select 2")).toEqual(["select /* ; */ 1", "select 2"]);
  });

  it("nests block comments like Postgres", () => {
    expect(texts("select 1 /* outer /* inner; */ still; outer */ + 1; select 2")).toEqual([
      "select 1 /* outer /* inner; */ still; outer */ + 1",
      "select 2",
    ]);
    expect(texts("/* a /* b /* c */ ; */ ; */ select 1;")).toEqual(["select 1"]);
  });

  it("does not see quotes inside comments", () => {
    expect(texts("select 1; -- it's fine\nselect 2;")).toEqual(["select 1", "select 2"]);
    expect(texts('select 1; /* it\'s "fine" $$ */ select 2;')).toEqual(["select 1", "select 2"]);
    // The comment trails the statement, so it is trimmed like any trailing comment.
    expect(texts("select 1 /* don't; */; select 2")).toEqual(["select 1", "select 2"]);
  });

  it("does not see comments inside quotes", () => {
    expect(texts("select '-- not a comment'; select 2")).toEqual([
      "select '-- not a comment'",
      "select 2",
    ]);
    expect(texts("select '/* open', 2; select '*/'")).toEqual([
      "select '/* open', 2",
      "select '*/'",
    ]);
    expect(texts('select "--x" from t; select 2')).toEqual(['select "--x" from t', "select 2"]);
  });

  it("treats a minus and a slash on their own as operators", () => {
    expect(texts("select 3 - 2; select 4 / 2; select 2 * 3")).toEqual([
      "select 3 - 2",
      "select 4 / 2",
      "select 2 * 3",
    ]);
  });

  it("keeps an unterminated block comment so that Postgres reports it", () => {
    expect(texts("select 1; /* never closed; select 2;")).toEqual([
      "select 1",
      "/* never closed; select 2;",
    ]);
    expect(texts("select 1 /* open /* closed */ ; more")).toEqual([
      "select 1 /* open /* closed */ ; more",
    ]);
  });
});

describe("splitSqlStatements: strings and identifiers", () => {
  it("ignores semicolons in single-quoted strings", () => {
    expect(texts("insert into t values ('a;b'); select ';'")).toEqual([
      "insert into t values ('a;b')",
      "select ';'",
    ]);
  });

  it("handles doubled quotes", () => {
    expect(texts("select 'it''s; here'; select ''''; select '';")).toEqual([
      "select 'it''s; here'",
      "select ''''",
      "select ''",
    ]);
  });

  it("treats a backslash as an ordinary character in a standard string", () => {
    expect(texts("select 'C:\\'; select 2")).toEqual(["select 'C:\\'", "select 2"]);
  });

  it("handles backslash escapes in E strings, either case", () => {
    expect(texts("select E'it\\'s; here'; select 2")).toEqual([
      "select E'it\\'s; here'",
      "select 2",
    ]);
    expect(texts("select e'a\\\\'; select 2")).toEqual(["select e'a\\\\'", "select 2"]);
    expect(texts("select E'a''b;\\';'; select 2")).toEqual(["select E'a''b;\\';'", "select 2"]);
  });

  it("only takes a lone E as the escape prefix", () => {
    expect(texts("select type'a\\'; select 2")).toEqual(["select type'a\\'", "select 2"]);
    expect(texts("select name_e'a\\'; select 2")).toEqual(["select name_e'a\\'", "select 2"]);
    expect(texts("select 1e'a\\'; select 2")).toEqual(["select 1e'a\\'", "select 2"]);
  });

  it("continues an E string on the next line with escapes still active", () => {
    expect(texts("select E'a'\n  'b\\';c'; select 2")).toEqual([
      "select E'a'\n  'b\\';c'",
      "select 2",
    ]);
    expect(texts("select E'a'\r\n'b\\';c'; select 2")).toEqual([
      "select E'a'\r\n'b\\';c'",
      "select 2",
    ]);
  });

  it("does not continue an E string on the same line or before another token", () => {
    expect(texts("select E'a' 'b\\'; select 2")).toEqual(["select E'a' 'b\\'", "select 2"]);
    expect(texts("select E'a'\n; select 'b\\'; select 3")).toEqual([
      "select E'a'",
      "select 'b\\'",
      "select 3",
    ]);
    expect(texts("select E'a'\n")).toEqual(["select E'a'"]);
  });

  it("handles other string prefixes as standard strings", () => {
    expect(texts("select U&'d\\0061t;a', B'101', X'1F', N'x;'; select 2")).toEqual([
      "select U&'d\\0061t;a', B'101', X'1F', N'x;'",
      "select 2",
    ]);
  });

  it("ignores semicolons and single quotes in double-quoted identifiers", () => {
    expect(texts('select "a;b" from "it\'s"; select 2')).toEqual([
      'select "a;b" from "it\'s"',
      "select 2",
    ]);
    expect(texts('select "say ""hi;""" from t; select 2')).toEqual([
      'select "say ""hi;""" from t',
      "select 2",
    ]);
    expect(texts('select "back\\" from t; select 2')).toEqual([
      'select "back\\" from t',
      "select 2",
    ]);
  });

  it("keeps unterminated quotes as the last statement", () => {
    expect(texts("select 1; select 'open; select 2;")).toEqual([
      "select 1",
      "select 'open; select 2;",
    ]);
    expect(texts('select 1; select "open; select 2;')).toEqual([
      "select 1",
      'select "open; select 2;',
    ]);
    expect(texts("select E'open\\")).toEqual(["select E'open\\"]);
  });
});

describe("splitSqlStatements: dollar quoting", () => {
  it("never splits inside a $$ body", () => {
    const fn = `create function public.touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();  -- it's a comment; with a quote
  if new.title = ';' then raise notice 'semi;colon'; end if;
  return new;
end;
$$`;
    expect(texts(`${fn};\nselect 1;`)).toEqual([fn, "select 1"]);
  });

  it("handles tags, and other tags or $$ inside the body", () => {
    const fn = `create function f() returns text language sql as $fn$
  select $inner$ a; $$ b; $inner$ || $$ c; $fn $$;
$fn$`;
    expect(texts(`${fn}; select 2`)).toEqual([fn, "select 2"]);
  });

  it("is case-sensitive about tags", () => {
    expect(texts("select $a$ ; $A$ ; $a$; select 2")).toEqual([
      "select $a$ ; $A$ ; $a$",
      "select 2",
    ]);
  });

  it("handles DO blocks", () => {
    const block = `do $do$
declare r record;
begin
  for r in select 1 loop
    perform 1;
  end loop;
end
$do$`;
    expect(texts(`${block};\ndo $$ begin null; end $$; select 3`)).toEqual([
      block,
      "do $$ begin null; end $$",
      "select 3",
    ]);
  });

  it("supports tags with underscores, digits and non-ASCII letters", () => {
    expect(texts("select $_t1$ ; $_t1$; select $é$ ; $é$; select 3")).toEqual([
      "select $_t1$ ; $_t1$",
      "select $é$ ; $é$",
      "select 3",
    ]);
  });

  it("does not take a positional parameter for a dollar quote", () => {
    expect(texts("select $1; select $2 || $1;")).toEqual(["select $1", "select $2 || $1"]);
    expect(texts("select $1$; select 2")).toEqual(["select $1$", "select 2"]);
  });

  it("does not start a dollar quote inside an identifier", () => {
    expect(texts("select a$$b; select c$x$d from t;")).toEqual([
      "select a$$b",
      "select c$x$d from t",
    ]);
  });

  it("treats a stray dollar sign as a character", () => {
    expect(texts("select $ ; select 2")).toEqual(["select $", "select 2"]);
    expect(texts("select 1 $")).toEqual(["select 1 $"]);
  });

  it("keeps an unterminated dollar quote as the last statement", () => {
    expect(texts("select 1; do $$ begin null; end; select 2;")).toEqual([
      "select 1",
      "do $$ begin null; end; select 2;",
    ]);
    expect(texts("select $a$ body $b$; select 2")).toEqual(["select $a$ body $b$; select 2"]);
  });

  it("does not see quotes inside a body, nor a body inside quotes", () => {
    expect(texts("select $$ it's \"; $$; select 2")).toEqual(["select $$ it's \"; $$", "select 2"]);
    expect(texts("select '$$;', 1; select '$$'")).toEqual(["select '$$;', 1", "select '$$'"]);
    expect(texts('select "$$;" from t; select "$$" from t')).toEqual([
      'select "$$;" from t',
      'select "$$" from t',
    ]);
    expect(texts("select 1 -- $$\n; select 2 /* $$ */; select 3")).toEqual([
      "select 1",
      "select 2",
      "select 3",
    ]);
  });
});

describe("splitSqlStatements: parentheses and BEGIN ATOMIC bodies", () => {
  it("does not split inside parentheses, like psql", () => {
    const rule = "create rule r as on insert to t do also (insert into log values (1); notify t)";
    expect(texts(`${rule}; select 2`)).toEqual([rule, "select 2"]);
  });

  it("forgets an unbalanced closing parenthesis", () => {
    expect(texts("select 1); select (2); select 3")).toEqual([
      "select 1)",
      "select (2)",
      "select 3",
    ]);
  });

  it("resets the parenthesis depth with every statement", () => {
    expect(texts("select (1; select 2); select 3")).toEqual(["select (1; select 2)", "select 3"]);
  });

  it("keeps a BEGIN ATOMIC function body together", () => {
    const fn = `create function add_note(t text) returns void language sql
begin atomic
  insert into notes (body) values (t);
  insert into audit (msg) values ('note; added');
end`;
    expect(texts(`${fn};\nselect 1;`)).toEqual([fn, "select 1"]);
  });

  it("handles OR REPLACE, PROCEDURE, upper case and CASE ... END inside the body", () => {
    const proc = `CREATE OR REPLACE PROCEDURE p(x int) LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN x > 0 THEN 1 ELSE 2 END;
  SELECT CASE x WHEN 1 THEN CASE WHEN true THEN 'a;' END END;
END`;
    expect(texts(`${proc}; SELECT 2;`)).toEqual([proc, "SELECT 2"]);
  });

  it("does not count CASE outside a body", () => {
    const fn =
      "create function f(x int) returns int language sql return case when x > 0 then 1 else 0 end";
    expect(texts(`${fn}; select 2`)).toEqual([fn, "select 2"]);
  });

  it("treats BEGIN and END as plain statements outside CREATE FUNCTION", () => {
    expect(texts("begin; update t set a = 1; end; commit;")).toEqual([
      "begin",
      "update t set a = 1",
      "end",
      "commit",
    ]);
    expect(texts("create table begin_log (id int); select 1")).toEqual([
      "create table begin_log (id int)",
      "select 1",
    ]);
    expect(texts("create or replace view v as select 1; begin; select 2; end")).toEqual([
      "create or replace view v as select 1",
      "begin",
      "select 2",
      "end",
    ]);
  });

  it("does not track words inside the parameter list or in strings", () => {
    const fn =
      "create function f(begin int default 1) returns int language sql as 'select 1; -- begin'";
    expect(texts(`${fn}; select 2`)).toEqual([fn, "select 2"]);
  });

  it("forgets the body depth with the next statement", () => {
    const fn = "create function f() returns int language sql begin atomic select 1; end";
    expect(texts(`${fn}; begin; select 2;`)).toEqual([fn, "begin", "select 2"]);
  });

  it("keeps an unterminated body as one statement", () => {
    const fn = "create function f() returns int language sql begin atomic select 1; select 2;";
    expect(texts(fn)).toEqual([fn]);
  });
});

describe("splitSqlStatements: robustness", () => {
  it("handles non-ASCII text and astral characters with correct offsets", () => {
    const sql = "select 'héllo; 🌍'; select \"tâble;\" from t;";
    const statements = splitSqlStatements(sql);
    expect(statements.map((s) => s.text)).toEqual(["select 'héllo; 🌍'", 'select "tâble;" from t']);
    expect(statements[1]?.start).toBe(sql.indexOf('select "'));
  });

  it("is linear enough for the largest script a scenario may carry", () => {
    const row = "insert into t (id, body) values (1, 'it''s; fine'); -- note; here\n";
    const sql = row.repeat(Math.floor(200_000 / row.length));
    const started = performance.now();
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(Math.floor(200_000 / row.length));
    expect(statements.at(-1)?.line).toBe(statements.length);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("gives the same result every time", () => {
    const sql = "select $a$;$a$; select E'x\\';'; /* c */ select 3";
    expect(splitSqlStatements(sql)).toEqual(splitSqlStatements(sql));
  });
});

describe("offsetToPosition", () => {
  const sql = "ab\ncd\r\nef\rgh";

  it.each([
    [0, 1, 1],
    [2, 1, 3],
    [3, 2, 1],
    [5, 2, 3],
    [6, 2, 4],
    [7, 3, 1],
    [9, 3, 3],
    [10, 4, 1],
    [12, 4, 3],
  ])("maps offset %i to line %i, column %i", (offset, line, column) => {
    expect(offsetToPosition(sql, offset)).toEqual({ line, column });
  });

  it("clamps offsets outside the script", () => {
    expect(offsetToPosition(sql, -5)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition(sql, 999)).toEqual({ line: 4, column: 3 });
    expect(offsetToPosition("", 0)).toEqual({ line: 1, column: 1 });
  });

  it("counts a lone carriage return at the very end of the script as a line break", () => {
    expect(offsetToPosition("ab\r", 3)).toEqual({ line: 2, column: 1 });
  });

  it("places a Postgres error position inside a statement", () => {
    const script = "select 1;\nselect *\n  from missing_table;";
    const statement = splitSqlStatements(script)[1];
    expect(statement).toBeDefined();
    if (statement !== undefined) {
      const errorPosition = statement.text.indexOf("missing_table") + 1;
      expect(offsetToPosition(script, statement.start + errorPosition - 1)).toEqual({
        line: 3,
        column: 8,
      });
    }
  });
});
