/**
 * Bypass guard, ENGINE LEVEL ONLY.
 *
 * RUN-001 asks for proof that a probe never runs as a superuser, a table owner or a BYPASSRLS
 * role. There are no probes yet: the matrix runner is a later slice. What this suite proves is the
 * half the engine owns, through the real `SqlEngine` port against a real PGlite:
 *
 *   1. the transaction-local role switch really puts a statement under RLS,
 *   2. the control: the same statement WITHOUT the switch is not filtered (the engine's default
 *      user is a superuser), so forgetting the switch passes every leaky scenario,
 *   3. the other two bypasses are real on this engine: a table owner without FORCE, and a
 *      BYPASSRLS role, both see every row,
 *   4. the switch ends with the transaction.
 *
 * NOT covered here, and still owed by the runner slice: that every probe the runner builds goes
 * through the switch, and that a persona whose role is a superuser, an owner without FORCE or a
 * BYPASSRLS role is detected and reported instead of silently passing. The file name satisfies the
 * RUN-001 file check; it does not discharge the rule for the runner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import type { SqlEngine } from "@/lib/runner/types";

const CLAIMS = "request.jwt.claims";

async function idsAs(engine: SqlEngine, role: string | null, user: string): Promise<unknown[]> {
  return engine.transaction(async (tx) => {
    try {
      if (role !== null) {
        await tx.query("select set_config('role', $1, true)", [role]);
      }
      await tx.query("select set_config($1, $2, true)", [CLAIMS, JSON.stringify({ sub: user })]);
      const { rows } = await tx.query("select id from docs order by id");
      return rows.map((row) => row.id);
    } finally {
      await tx.rollback();
    }
  });
}

describe("bypass guard: the engine's role switch", () => {
  let engine: SqlEngine;

  beforeAll(async () => {
    engine = await createPgliteEngine();
    await engine.exec(`
      create role app_user nologin;
      create role app_owner nologin;
      create role app_admin nologin bypassrls;
      create table docs (id int primary key, owner text not null);
      insert into docs values (1, 'alice'), (2, 'alice'), (3, 'bob');
      alter table docs owner to app_owner;
      alter table docs enable row level security;
      create policy own on docs using (
        owner = nullif(current_setting('${CLAIMS}', true), '')::jsonb ->> 'sub'
      );
      grant select on docs to app_user, app_admin;
    `);
  }, 60_000);

  afterAll(async () => {
    await engine.close();
  });

  it("filters a plain role through the policy", async () => {
    expect(await idsAs(engine, "app_user", "alice")).toEqual([1, 2]);
    expect(await idsAs(engine, "app_user", "bob")).toEqual([3]);
    expect(await idsAs(engine, "app_user", "nobody")).toEqual([]);
  });

  it("control: without the role switch the same claims see everything (superuser)", async () => {
    expect(await idsAs(engine, null, "bob")).toEqual([1, 2, 3]);
  });

  it("a table owner without FORCE and a BYPASSRLS role are not filtered either", async () => {
    expect(await idsAs(engine, "app_owner", "bob")).toEqual([1, 2, 3]);
    expect(await idsAs(engine, "app_admin", "bob")).toEqual([1, 2, 3]);
  });

  it("FORCE ROW LEVEL SECURITY puts the owner under the policy, not the BYPASSRLS role", async () => {
    await engine.transaction(async (tx) => {
      try {
        await tx.exec("alter table docs force row level security");
        await tx.query("select set_config('role', $1, true)", ["app_owner"]);
        await tx.query("select set_config($1, $2, true)", [CLAIMS, JSON.stringify({ sub: "bob" })]);
        const owner = await tx.query("select id from docs order by id");
        expect(owner.rows.map((row) => row.id)).toEqual([3]);
        await tx.query("select set_config('role', $1, true)", ["app_admin"]);
        const admin = await tx.query("select id from docs order by id");
        expect(admin.rows.map((row) => row.id)).toEqual([1, 2, 3]);
      } finally {
        await tx.rollback();
      }
    });
    // Rolled back: the table is not forced afterwards.
    const { rows } = await engine.query(
      "select relforcerowsecurity as forced from pg_class where oid = 'docs'::regclass",
    );
    expect(rows).toEqual([{ forced: false }]);
  });

  it("the switch ends with the transaction: the session is the superuser again", async () => {
    await idsAs(engine, "app_user", "alice");
    const { rows } = await engine.query("select current_user::text as role");
    expect(rows).toEqual([{ role: "postgres" }]);
  });

  it("a role that does not exist is an error, never a silent run as the superuser", async () => {
    await expect(idsAs(engine, "no_such_role", "alice")).rejects.toMatchObject({ code: "22023" });
  });
});
