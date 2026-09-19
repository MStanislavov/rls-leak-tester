import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineError, SqlError, type SqlEngine } from "@/lib/runner/types";
import { createPgliteEngine } from "./pglite-engine";

describe("createPgliteEngine against a real PGlite", () => {
  let engine: SqlEngine;

  beforeAll(async () => {
    engine = await createPgliteEngine();
    await engine.exec(`
      create role app_user nologin;
      create table notes (id int primary key, owner text not null, body text);
      insert into notes values (1, 'alice', 'a'), (2, 'bob', 'b'), (3, 'alice', null);
      alter table notes enable row level security;
      create policy own on notes to app_user using (owner = current_setting('app.user', true));
      grant select, update on notes to app_user;
    `);
  }, 60_000);

  afterAll(async () => {
    await engine.close();
  });

  it("runs one parameterised statement and returns rows as objects", async () => {
    const result = await engine.query("select id, body from notes where owner = $1 order by id", [
      "alice",
    ]);
    expect(result).toEqual({
      rows: [
        { id: 1, body: "a" },
        { id: 3, body: null },
      ],
      affectedRows: 0,
    });
  });

  it("reports affected rows of a write without RETURNING", async () => {
    const result = await engine.query("update notes set body = body where owner = $1", ["alice"]);
    expect(result).toEqual({ rows: [], affectedRows: 2 });
  });

  it("normalises cells to text where JavaScript would lose or localise the value", async () => {
    const { rows } = await engine.query(
      `select 9007199254740993::int8 as big, '2026-01-02T03:04:05Z'::timestamptz as at,
              array['a','b'] as list, '{"k":[1]}'::jsonb as doc, 1.50::numeric as num, true as flag`,
    );
    expect(rows).toEqual([
      {
        big: "9007199254740993",
        at: "2026-01-02T03:04:05.000Z",
        list: '["a","b"]',
        doc: '{"k":[1]}',
        num: "1.50",
        flag: true,
      },
    ]);
  });

  it("accepts every parameter type of the port", async () => {
    const { rows } = await engine.query(
      "select $1::text as t, $2::int as n, $3::boolean as b, $4::text as nothing, $5::jsonb ->> 'sub' as sub",
      ["x", 7, false, null, JSON.stringify({ sub: "u1" })],
    );
    expect(rows).toEqual([{ t: "x", n: 7, b: false, nothing: null, sub: "u1" }]);
  });

  it("maps a Postgres error to SqlError with SQLSTATE, detail, hint and position", async () => {
    const missing = await engine.query("select * from nowhere").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SqlError);
    expect(missing).toMatchObject({ name: "SqlError", code: "42P01", position: 15 });

    const duplicate = await engine
      .query("insert into notes values (1, 'alice', 'again')")
      .catch((error: unknown) => error);
    expect(duplicate).toMatchObject({
      code: "23505",
      detail: "Key (id)=(1) already exists.",
    });

    const hinted = await engine
      .exec("select owner from notes; select ownr from notes;")
      .catch((error: unknown) => error);
    expect(hinted).toBeInstanceOf(SqlError);
    expect(hinted).toMatchObject({ code: "42703" });
    expect((hinted as SqlError).hint).toContain("owner");
  });

  it("refuses two statements in query, as the extended protocol does", async () => {
    await expect(engine.query("select 1; select 2")).rejects.toMatchObject({ code: "42601" });
  });

  it("commits when the callback resolves", async () => {
    const value = await engine.transaction(async (tx) => {
      await tx.exec("create table committed (n int); insert into committed values (1), (2);");
      const { rows } = await tx.query("select count(*)::int as n from committed");
      return rows[0]?.n;
    });
    expect(value).toBe(2);
    const { rows } = await engine.query("select count(*)::int as n from committed");
    expect(rows).toEqual([{ n: 2 }]);
  });

  it("rolls back when the callback throws and rethrows the same error", async () => {
    const boom = new Error("boom");
    await expect(
      engine.transaction(async (tx) => {
        await tx.query("delete from notes");
        throw boom;
      }),
    ).rejects.toBe(boom);
    const { rows } = await engine.query("select count(*)::int as n from notes");
    expect(rows).toEqual([{ n: 3 }]);
  });

  it("rolls back explicitly, closes the handle and leaves the data unchanged", async () => {
    await engine.transaction(async (tx) => {
      expect(tx.closed).toBe(false);
      const deleted = await tx.query("delete from notes returning id");
      expect(deleted.affectedRows).toBe(3);
      await tx.rollback();
      expect(tx.closed).toBe(true);
      await tx.rollback();
      await expect(tx.query("select 1")).rejects.toBeInstanceOf(EngineError);
      await expect(tx.exec("select 1")).rejects.toThrow("Transaction is closed");
    });
    const { rows } = await engine.query("select count(*)::int as n from notes");
    expect(rows).toEqual([{ n: 3 }]);
  });

  it("switches role and claims for one transaction only, and RLS really filters", async () => {
    const seen = await engine.transaction(async (tx) => {
      try {
        await tx.query("select set_config('role', $1, true)", ["app_user"]);
        await tx.query("select set_config('app.user', $1, true)", ["alice"]);
        const who = await tx.query("select current_user::text as role, session_user::text as su");
        const visible = await tx.query("select id from notes order by id");
        return { who: who.rows[0], ids: visible.rows.map((row) => row.id) };
      } finally {
        await tx.rollback();
      }
    });
    expect(seen).toEqual({ who: { role: "app_user", su: "postgres" }, ids: [1, 3] });

    const after = await engine.query(
      "select current_user::text as role, current_setting('app.user', true) as claims",
    );
    // '' and not null after first use: the quirk from ADR 0002.
    expect(after.rows).toEqual([{ role: "postgres", claims: "" }]);
  });

  it("keeps an aborted transaction aborted until rollback, then works again", async () => {
    await engine.transaction(async (tx) => {
      await expect(tx.query("select * from nowhere")).rejects.toMatchObject({ code: "42P01" });
      await expect(tx.query("select 1")).rejects.toMatchObject({ code: "25P02" });
      await tx.rollback();
    });
    await expect(engine.query("select 1 as one")).resolves.toMatchObject({ rows: [{ one: 1 }] });
  });

  it("makes a call on the engine wait until the open transaction has ended", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = engine.transaction(async (tx) => {
      await tx.exec("create table inside_tx (n int)");
      await gate;
      order.push("transaction ends");
      await tx.rollback();
    });
    const outside = engine
      .query("select to_regclass('inside_tx')::text as found")
      .then((result) => {
        order.push("outside query ran");
        return result.rows[0]?.found;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual([]);
    release();
    await transaction;
    // Had it run inside the transaction it would have seen the table.
    expect(await outside).toBeNull();
    expect(order).toEqual(["transaction ends", "outside query ran"]);
  });
});

describe("createPgliteEngine lifecycle", () => {
  it("gives every engine its own empty database and releases it on close", async () => {
    const first = await createPgliteEngine();
    const second = await createPgliteEngine();
    try {
      await first.exec("create table only_in_first (n int)");
      const { rows } = await second.query("select to_regclass('only_in_first')::text as found");
      expect(rows).toEqual([{ found: null }]);
    } finally {
      await first.close();
      await second.close();
    }
  }, 60_000);

  it("rejects with an engine error when Postgres does not start", async () => {
    await expect(
      createPgliteEngine(async () => {
        throw new Error("wasm failed to load");
      }),
    ).rejects.toThrow("wasm failed to load");
  });
});
