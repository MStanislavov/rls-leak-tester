/**
 * Spike A: "RLS inside PGlite". Every assumption the matrix runner makes about the database is
 * written here once, as an executable claim. Two runners consume this list:
 *
 * - `tests/spikes/pglite-rls.test.ts` registers each claim as a Vitest test (the permanent
 *   regression suite);
 * - `scripts/spikes/pglite-rls.mjs` prints one PASS/FAIL line per claim.
 *
 * The file is `.mts` with erasable type syntax only, so plain Node can import it through its
 * built-in type stripping. It must not import project TypeScript (`.ts` import paths do not type
 * check under this tsconfig, and extension-less paths do not resolve in Node); the Supabase shim
 * therefore arrives through `SpikeContext`.
 *
 * A claim throws when it does not hold and returns a short line of evidence when it does.
 * Findings and quirks are written up in docs/adr/0002-spike-a-pglite-rls.md.
 */
import assert from "node:assert/strict";

import { PGlite, messages } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";

export interface SpikeContext {
  /** `SUPABASE_SHIM_SQL` from src/lib/engine/supabase-shim.ts. */
  readonly shimSql: string;
  /** `supabaseDefaultGrantsSql` from src/lib/engine/supabase-shim.ts. */
  readonly defaultGrantsSql: (
    schema: string,
    options?: { readonly autoExposeNewTables?: boolean },
  ) => string;
}

export interface Claim {
  readonly id: string;
  readonly title: string;
  readonly run: (ctx: SpikeContext) => Promise<string>;
}

/**
 * Pinned answer to "does PGlite enforce statement_timeout?". Claim 7 fails when reality stops
 * matching, because the worker timeout design (brief 4.4, ADR 0002) depends on it.
 */
export const STATEMENT_TIMEOUT_IS_ENFORCED = false;

type JwtClaims = Readonly<Record<string, unknown>>;
type Queryable = Pick<Transaction, "query">;

interface SqlFailure {
  readonly code: string | undefined;
  readonly message: string;
  readonly isDatabaseError: boolean;
}

const RLS_VIOLATION = "42501";
const SUPERUSER = "postgres";
const CLAIMS_SETTING = "request.jwt.claims";
const SUB = `(current_setting('${CLAIMS_SETTING}', true)::jsonb ->> 'sub')`;

const ALICE: JwtClaims = { sub: "alice" };
const BOB: JwtClaims = { sub: "bob" };

const OWNER_POLICY = `
create policy docs_owner on docs for all to app_user
  using (owner = ${SUB}) with check (owner = ${SUB});`;

/** Two roles, one table with four rows owned by three people, RLS enabled and forced. */
function docsFixture(policies: string): string {
  return `
create role app_user nologin;
create role app_admin nologin bypassrls;
create table folders (id int primary key);
insert into folders values (10);
create table docs (
  id int primary key,
  owner text not null,
  title text not null check (title <> ''),
  folder_id int references folders (id)
);
insert into docs (id, owner, title, folder_id) values
  (1, 'alice', 'a1', 10), (2, 'alice', 'a2', null), (3, 'bob', 'b1', null), (4, 'carol', 'c1', null);
grant select, insert, update, delete on docs to app_user, app_admin;
alter table docs enable row level security;
alter table docs force row level security;
${policies}
`;
}

async function withDb<T>(setupSql: string, body: (db: PGlite) => Promise<T>): Promise<T> {
  const db = new PGlite();
  try {
    await db.waitReady;
    await db.exec(setupSql);
    return await body(db);
  } finally {
    await db.close();
  }
}

/**
 * The probe shape of brief 3.5: BEGIN, SET LOCAL ROLE, set_config(claims, local), run, ROLLBACK.
 * Role names in this file are plain lowercase identifiers, so double quotes are enough here.
 */
async function asPersona<T>(
  db: PGlite,
  role: string,
  claims: JwtClaims,
  body: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    try {
      await tx.exec(`set local role "${role}"`);
      await tx.query(`select set_config('${CLAIMS_SETTING}', $1, true)`, [JSON.stringify(claims)]);
      return await body(tx);
    } finally {
      if (!tx.closed) {
        await tx.rollback();
      }
    }
  });
}

async function failureOf(run: () => Promise<unknown>): Promise<SqlFailure> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error, "PGlite must reject with an Error instance");
    const code: unknown = (error as { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : undefined,
      message: error.message,
      isDatabaseError: error instanceof messages.DatabaseError,
    };
  }
  return assert.fail("the statement was expected to fail, but it succeeded");
}

async function idsOf(runner: Queryable, sql: string): Promise<number[]> {
  const result = await runner.query<{ id: number }>(sql);
  return result.rows.map((row) => row.id);
}

async function firstRow<T>(runner: Queryable, sql: string, params?: unknown[]): Promise<T> {
  const result = await runner.query<T>(sql, params);
  const row = result.rows[0];
  assert.ok(row !== undefined, `no row came back from: ${sql}`);
  return row;
}

async function snapshot(db: PGlite, table: string): Promise<string> {
  const result = await db.query(`select * from ${table} order by 1`);
  return JSON.stringify(result.rows);
}

async function sessionState(runner: Queryable): Promise<{ user: string; claims: string | null }> {
  return firstRow(
    runner,
    `select current_user::text as "user", current_setting('${CLAIMS_SETTING}', true) as claims`,
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  assert.ok(middle !== undefined, "median of an empty list");
  return middle;
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

const SELECT_IDS = "select id from docs order by id";

// ---------------------------------------------------------------------------------------------
// Claim 1
// ---------------------------------------------------------------------------------------------

async function claimDdl(): Promise<string> {
  return withDb(docsFixture(OWNER_POLICY), async (db) => {
    const roles = await db.query(
      `select rolname::text as name, rolcanlogin, rolsuper, rolbypassrls
         from pg_roles where rolname in ('app_user', 'app_admin') order by rolname`,
    );
    assert.deepEqual(roles.rows, [
      { name: "app_admin", rolcanlogin: false, rolsuper: false, rolbypassrls: true },
      { name: "app_user", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
    ]);

    const flagsSql = `select relrowsecurity, relforcerowsecurity from pg_class
                       where oid = 'public.docs'::regclass`;
    assert.deepEqual(await firstRow(db, flagsSql), {
      relrowsecurity: true,
      relforcerowsecurity: true,
    });

    const policy = await firstRow<{
      cmd: string;
      permissive: string;
      roles: string[];
      qual: string | null;
      with_check: string | null;
    }>(
      db,
      `select cmd, permissive, roles::text[] as roles, qual, with_check
         from pg_policies where schemaname = 'public' and tablename = 'docs'`,
    );
    assert.equal(policy.cmd, "ALL");
    assert.equal(policy.permissive, "PERMISSIVE");
    assert.deepEqual(policy.roles, ["app_user"]);
    assert.match(policy.qual ?? "", /owner = /);
    assert.match(policy.with_check ?? "", /owner = /);

    const privileges = await firstRow(
      db,
      `select has_table_privilege('app_user', 'docs', 'select') as docs_select,
              has_table_privilege('app_user', 'docs', 'delete') as docs_delete,
              has_table_privilege('app_user', 'folders', 'select') as folders_select`,
    );
    assert.deepEqual(privileges, { docs_select: true, docs_delete: true, folders_select: false });

    await db.exec(
      "alter table docs no force row level security; alter table docs disable row level security;",
    );
    assert.deepEqual(await firstRow(db, flagsSql), {
      relrowsecurity: false,
      relforcerowsecurity: false,
    });

    return "roles, grants, ENABLE/FORCE (and their opposites), policy with USING and WITH CHECK all visible in the catalogs";
  });
}

// ---------------------------------------------------------------------------------------------
// Claim 2
// ---------------------------------------------------------------------------------------------

async function claimTransactionLocalIdentity(): Promise<string> {
  return withDb(docsFixture(OWNER_POLICY), async (db) => {
    const before = await snapshot(db, "docs");
    assert.deepEqual(await sessionState(db), { user: SUPERUSER, claims: null });

    const claims = { sub: "alice", role: "app_user", nested: { tenant: "t1" } };
    const inside = await asPersona(db, "app_user", claims, async (tx) => {
      const identity = await firstRow<{
        current_user: string;
        session_user: string;
        raw: string;
        sub: string;
        tenant: string;
      }>(
        tx,
        `select current_user::text, session_user::text,
                current_setting('${CLAIMS_SETTING}', true) as raw,
                current_setting('${CLAIMS_SETTING}', true)::jsonb ->> 'sub' as sub,
                current_setting('${CLAIMS_SETTING}', true)::jsonb #>> '{nested,tenant}' as tenant`,
      );
      await tx.query("insert into docs (id, owner, title) values (100, 'alice', 'written in tx')");
      return { identity, visible: await idsOf(tx, SELECT_IDS) };
    });

    assert.deepEqual(inside.identity, {
      current_user: "app_user",
      session_user: SUPERUSER,
      raw: JSON.stringify(claims),
      sub: "alice",
      tenant: "t1",
    });
    assert.deepEqual(inside.visible, [1, 2, 100], "the write was visible inside the transaction");

    const afterRollback = await sessionState(db);
    assert.equal(afterRollback.user, SUPERUSER, "the role is reset by ROLLBACK");
    assert.equal(
      afterRollback.claims,
      "",
      "after ROLLBACK the claims setting is an empty string (NULL only before its first use)",
    );
    assert.equal(await snapshot(db, "docs"), before, "data is unchanged after tx.rollback()");

    // Second way out: the callback throws, PGlite issues the ROLLBACK itself.
    const thrown = new Error("probe blew up");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec('set local role "app_user"');
        await tx.query(`select set_config('${CLAIMS_SETTING}', $1, true)`, [JSON.stringify(ALICE)]);
        await tx.query("insert into docs (id, owner, title) values (101, 'alice', 'never kept')");
        throw thrown;
      }),
      (error) => error === thrown,
    );
    assert.deepEqual(await sessionState(db), { user: SUPERUSER, claims: "" });
    assert.equal(await snapshot(db, "docs"), before, "data is unchanged after a thrown error");

    return `inside: current_user=app_user session_user=${SUPERUSER}; after ROLLBACK: current_user=${SUPERUSER}, claims=''; rows unchanged`;
  });
}

// ---------------------------------------------------------------------------------------------
// Claim 3
// ---------------------------------------------------------------------------------------------

async function claimFilteringAndControl(): Promise<string> {
  return withDb(docsFixture(OWNER_POLICY), async (db) => {
    const asSuperuser = await idsOf(db, SELECT_IDS);
    const asAlice = await asPersona(db, "app_user", ALICE, (tx) => idsOf(tx, SELECT_IDS));
    const asBob = await asPersona(db, "app_user", BOB, (tx) => idsOf(tx, SELECT_IDS));
    const asNobody = await asPersona(db, "app_user", { sub: "mallory" }, (tx) =>
      idsOf(tx, SELECT_IDS),
    );

    // The control that would make the product lie: identical claims, identical query, but the
    // role switch is forgotten, so the probe runs as the superuser and RLS never applies.
    const withoutSetRole = await db.transaction(async (tx) => {
      await tx.query(`select set_config('${CLAIMS_SETTING}', $1, true)`, [JSON.stringify(ALICE)]);
      const ids = await idsOf(tx, SELECT_IDS);
      await tx.rollback();
      return ids;
    });

    assert.deepEqual(asSuperuser, [1, 2, 3, 4]);
    assert.deepEqual(asAlice, [1, 2]);
    assert.deepEqual(asBob, [3]);
    assert.deepEqual(asNobody, []);
    assert.deepEqual(withoutSetRole, [1, 2, 3, 4]);

    return `superuser=[${asSuperuser}] alice=[${asAlice}] bob=[${asBob}] stranger=[${asNobody}] control without SET LOCAL ROLE=[${withoutSetRole}]`;
  });
}

// ---------------------------------------------------------------------------------------------
// Claim 4
// ---------------------------------------------------------------------------------------------

const OWNED_FIXTURE = `
create role tbl_owner nologin;
create table owned (id int primary key, owner text not null);
insert into owned values (1, 'alice'), (2, 'bob'), (3, 'carol');
alter table owned owner to tbl_owner;
grant select on owned to app_user;
alter table owned enable row level security;
create policy owned_owner on owned for select using (owner = ${SUB});

create table locked (id int primary key);
insert into locked values (1), (2);
grant select, insert on locked to app_user;
alter table locked enable row level security;
`;

async function claimBypasses(): Promise<string> {
  return withDb(docsFixture(OWNER_POLICY) + OWNED_FIXTURE, async (db) => {
    // Superuser: bypasses even with FORCE ROW LEVEL SECURITY (docs has it).
    const superuser = await idsOf(db, SELECT_IDS);
    assert.deepEqual(superuser, [1, 2, 3, 4]);

    // BYPASSRLS role: bypasses for reads and writes, FORCE or not.
    const bypassRole = await asPersona(db, "app_admin", ALICE, async (tx) => ({
      read: await idsOf(tx, SELECT_IDS),
      written: await idsOf(tx, "update docs set title = title returning id"),
    }));
    assert.deepEqual(bypassRole.read, [1, 2, 3, 4]);
    assert.deepEqual(
      bypassRole.written.toSorted((a, b) => a - b),
      [1, 2, 3, 4],
    );

    // Table owner: bypasses until FORCE is set. A non-owner is filtered either way.
    const selectOwned = "select id from owned order by id";
    const ownerWithoutForce = await asPersona(db, "tbl_owner", ALICE, (tx) =>
      idsOf(tx, selectOwned),
    );
    const otherWithoutForce = await asPersona(db, "app_user", ALICE, (tx) =>
      idsOf(tx, selectOwned),
    );
    await db.exec("alter table owned force row level security");
    const ownerWithForce = await asPersona(db, "tbl_owner", ALICE, (tx) => idsOf(tx, selectOwned));
    const otherWithForce = await asPersona(db, "app_user", ALICE, (tx) => idsOf(tx, selectOwned));
    assert.deepEqual(ownerWithoutForce, [1, 2, 3]);
    assert.deepEqual(otherWithoutForce, [1]);
    assert.deepEqual(ownerWithForce, [1]);
    assert.deepEqual(otherWithForce, [1]);

    // RLS enabled with no policy at all is "default deny": empty reads, rejected writes.
    const defaultDenyRead = await asPersona(db, "app_user", ALICE, (tx) =>
      idsOf(tx, "select id from locked order by id"),
    );
    const defaultDenyWrite = await failureOf(() =>
      asPersona(db, "app_user", ALICE, (tx) => tx.query("insert into locked values (3)")),
    );
    assert.deepEqual(defaultDenyRead, []);
    assert.equal(defaultDenyWrite.code, RLS_VIOLATION);

    return `superuser=[${superuser}] BYPASSRLS=[${bypassRole.read}] owner without FORCE=[${ownerWithoutForce}] owner with FORCE=[${ownerWithForce}] no policy=[${defaultDenyRead}]`;
  });
}

// ---------------------------------------------------------------------------------------------
// Claim 5
// ---------------------------------------------------------------------------------------------

async function claimErrorShape(): Promise<string> {
  return withDb(docsFixture(OWNER_POLICY), async (db) => {
    const before = await snapshot(db, "docs");
    const asAlice = (sql: string): Promise<SqlFailure> =>
      failureOf(() => asPersona(db, "app_user", ALICE, (tx) => tx.query(sql)));

    const insertOutOfScope = await asAlice("insert into docs values (50, 'bob', 'x', null)");
    assert.deepEqual(insertOutOfScope, {
      code: RLS_VIOLATION,
      message: 'new row violates row-level security policy for table "docs"',
      isDatabaseError: true,
    });

    const updateOutOfScope = await asAlice("update docs set owner = 'bob' where id = 1");
    assert.equal(updateOutOfScope.code, RLS_VIOLATION);

    // Same SQLSTATE, different cause: a missing table privilege. Only the message tells them apart.
    const noPrivilege = await asAlice("select * from folders");
    assert.deepEqual(noPrivilege, {
      code: RLS_VIOLATION,
      message: "permission denied for table folders",
      isDatabaseError: true,
    });

    const unique = await asAlice("insert into docs values (1, 'alice', 'dup', null)");
    const notNull = await asAlice("insert into docs values (51, 'alice', null, null)");
    const check = await asAlice("insert into docs values (52, 'alice', '', null)");
    const foreignKey = await asAlice("insert into docs values (53, 'alice', 'fk', 999)");
    assert.equal(unique.code, "23505");
    assert.equal(notNull.code, "23502");
    assert.equal(check.code, "23514");
    assert.equal(foreignKey.code, "23503");

    // The policy is checked before the constraints: a row that breaks both reports 42501.
    const policyBeforeUnique = await asAlice("insert into docs values (1, 'bob', 'dup', null)");
    const policyBeforeNotNull = await asAlice("insert into docs values (54, 'bob', null, null)");
    assert.equal(policyBeforeUnique.code, RLS_VIOLATION);
    assert.equal(policyBeforeNotNull.code, RLS_VIOLATION);

    // After an error the transaction is aborted (25P02) until ROLLBACK; a savepoint avoids that.
    const recovery = await db.transaction(async (tx) => {
      await tx.exec('set local role "app_user"');
      await tx.query(`select set_config('${CLAIMS_SETTING}', $1, true)`, [JSON.stringify(ALICE)]);
      const first = await failureOf(() =>
        tx.query("insert into docs values (55, 'bob', 'x', null)"),
      );
      const aborted = await failureOf(() => tx.query("select 1"));
      await tx.rollback();
      return { first, aborted, closed: tx.closed };
    });
    assert.equal(recovery.first.code, RLS_VIOLATION);
    assert.equal(recovery.aborted.code, "25P02");
    assert.equal(recovery.closed, true);

    const savepoint = await asPersona(db, "app_user", ALICE, async (tx) => {
      await tx.exec("savepoint probe");
      const failed = await failureOf(() =>
        tx.query("insert into docs values (56, 'bob', 'x', null)"),
      );
      await tx.exec("rollback to savepoint probe");
      return { failed, stillAlice: await idsOf(tx, SELECT_IDS) };
    });
    assert.equal(savepoint.failed.code, RLS_VIOLATION);
    assert.deepEqual(savepoint.stillAlice, [1, 2], "role and claims survive ROLLBACK TO SAVEPOINT");

    assert.deepEqual(await sessionState(db), { user: SUPERUSER, claims: "" });
    assert.equal(await snapshot(db, "docs"), before, "no failed statement left a trace");

    return `SQLSTATE is on error.code (messages.DatabaseError): RLS insert/update=${insertOutOfScope.code}, missing grant=${noPrivilege.code}, unique=${unique.code}, not null=${notNull.code}, check=${check.code}, fk=${foreignKey.code}, aborted tx=${recovery.aborted.code}; instance usable afterwards`;
  });
}

// ---------------------------------------------------------------------------------------------
// Claim 6
// ---------------------------------------------------------------------------------------------

const MOVE_WHERE_PK = "update docs set owner = 'bob' where id = 1";
const MOVE_RETURNING = "update docs set owner = 'bob' where id = 1 returning id";
const MOVE_EVERYTHING = "update docs set owner = 'bob'";

interface MoveOutcome {
  readonly blockedWith: string | undefined;
  readonly affectedRows: number | undefined;
  readonly returned: number[];
  /** Owner of row 1 as the superuser sees it inside the same transaction, after the update. */
  readonly ownerOfRowOne: string | undefined;
}

async function tryMove(db: PGlite, sql: string): Promise<MoveOutcome> {
  try {
    return await asPersona(db, "app_user", ALICE, async (tx) => {
      const result = await tx.query<{ id: number }>(sql);
      // session_user is the superuser, so the probe can step back out to read the ground truth.
      await tx.exec("reset role");
      const truth = await firstRow<{ owner: string }>(tx, "select owner from docs where id = 1");
      return {
        blockedWith: undefined,
        affectedRows: result.affectedRows,
        returned: result.rows.map((row) => row.id),
        ownerOfRowOne: truth.owner,
      };
    });
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    assert.equal(typeof code, "string", `unexpected failure: ${String(error)}`);
    return {
      blockedWith: code as string,
      affectedRows: undefined,
      returned: [],
      ownerOfRowOne: undefined,
    };
  }
}

const BLOCKED: MoveOutcome = {
  blockedWith: RLS_VIOLATION,
  affectedRows: undefined,
  returned: [],
  ownerOfRowOne: undefined,
};

async function claimReturningAndScopeEscape(): Promise<string> {
  await withDb(docsFixture(OWNER_POLICY), async (db) => {
    const before = await snapshot(db, "docs");
    const updated = await asPersona(db, "app_user", ALICE, (tx) =>
      idsOf(tx, "update docs set title = title returning id"),
    );
    const deleted = await asPersona(db, "app_user", ALICE, async (tx) => {
      const returned = await idsOf(tx, "delete from docs returning id");
      // session_user is still the superuser, so the probe can step out and read the ground truth.
      await tx.exec("reset role");
      return { returned, leftForSuperuser: await idsOf(tx, SELECT_IDS) };
    });
    assert.deepEqual(
      updated.toSorted((a, b) => a - b),
      [1, 2],
    );
    assert.deepEqual(
      deleted.returned.toSorted((a, b) => a - b),
      [1, 2],
    );
    assert.deepEqual(deleted.leftForSuperuser, [3, 4], "only the permitted rows were deleted");
    assert.equal(await snapshot(db, "docs"), before, "the DELETE was rolled back");
  });

  // No WITH CHECK: USING is applied to the new row, so the move is rejected in every shape.
  const usingOnly = `create policy docs_owner on docs for all to app_user using (owner = ${SUB});`;
  await withDb(docsFixture(usingOnly), async (db) => {
    assert.deepEqual(await tryMove(db, MOVE_WHERE_PK), BLOCKED);
    assert.deepEqual(await tryMove(db, MOVE_RETURNING), BLOCKED);
    assert.deepEqual(await tryMove(db, MOVE_EVERYTHING), BLOCKED);
  });

  // Explicit WITH CHECK (true), and the SELECT policy still shows the moved row: allowed.
  const checkTrueSelectOpen = `
create policy docs_read on docs for select to app_user using (true);
create policy docs_write on docs for update to app_user using (owner = ${SUB}) with check (true);`;
  await withDb(docsFixture(checkTrueSelectOpen), async (db) => {
    const before = await snapshot(db, "docs");
    assert.deepEqual(await tryMove(db, MOVE_RETURNING), {
      blockedWith: undefined,
      affectedRows: 1,
      returned: [1],
      ownerOfRowOne: "bob",
    });
    assert.equal(await snapshot(db, "docs"), before, "the escape was rolled back");
  });

  // Explicit WITH CHECK (true) on a FOR ALL policy. Postgres quirk that the escape probe must
  // know about: an UPDATE that reads the table (WHERE or RETURNING) needs SELECT rights, and then
  // the policy's USING is also enforced on the NEW row, so the targeted move is rejected. The
  // same move without WHERE and RETURNING reads nothing and goes through.
  const checkTrueForAll = `
create policy docs_owner on docs for all to app_user using (owner = ${SUB}) with check (true);`;
  await withDb(docsFixture(checkTrueForAll), async (db) => {
    assert.deepEqual(await tryMove(db, MOVE_WHERE_PK), BLOCKED);
    assert.deepEqual(await tryMove(db, MOVE_RETURNING), BLOCKED);
    assert.deepEqual(await tryMove(db, MOVE_EVERYTHING), {
      blockedWith: undefined,
      affectedRows: 2,
      returned: [],
      ownerOfRowOne: "bob",
    });
  });

  return "UPDATE/DELETE RETURNING gave only [1,2]; move out of scope: no WITH CHECK => 42501; WITH CHECK (true) => allowed when the new row stays visible to SELECT, or when the UPDATE has no WHERE/RETURNING";
}

// ---------------------------------------------------------------------------------------------
// Claim 7
// ---------------------------------------------------------------------------------------------

async function claimUuidAndStatementTimeout(): Promise<string> {
  return withDb(
    "create table things (id uuid primary key default gen_random_uuid())",
    async (db) => {
      const uuids = await db.query<{ id: string }>(
        "insert into things select from generate_series(1, 2) returning id::text as id",
      );
      const [first, second] = uuids.rows.map((row) => row.id);
      assert.match(
        first ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.notEqual(first, second);

      await db.exec("set statement_timeout = '100ms'");
      const shown = await firstRow<{ statement_timeout: string }>(db, "show statement_timeout");
      assert.equal(shown.statement_timeout, "100ms", "the setting itself is accepted");

      // While the slow statement runs, count how often the JavaScript event loop gets a turn.
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
      }, 10);
      const startedAt = performance.now();
      let outcome: string;
      try {
        await db.query("select pg_sleep(0.6)");
        outcome = "completed";
      } catch (error) {
        outcome = String((error as { code?: unknown }).code);
      } finally {
        clearInterval(ticker);
      }
      const elapsed = performance.now() - startedAt;

      if (STATEMENT_TIMEOUT_IS_ENFORCED) {
        assert.equal(outcome, "57014", "statement_timeout should cancel the statement");
        assert.ok(elapsed < 500, `cancelled late, after ${ms(elapsed)}`);
      } else {
        assert.equal(
          outcome,
          "completed",
          "PGlite now enforces statement_timeout: flip STATEMENT_TIMEOUT_IS_ENFORCED and revisit ADR 0002",
        );
        assert.ok(elapsed >= 550, `pg_sleep(0.6) returned after only ${ms(elapsed)}`);
      }
      assert.ok(
        ticks <= 3,
        `the event loop ran ${ticks} times during the query; it should be blocked`,
      );

      const alive = await firstRow<{ ok: number }>(db, "select 1 as ok");
      assert.equal(alive.ok, 1);

      return `gen_random_uuid() works; statement_timeout='100ms' is accepted but NOT enforced: pg_sleep(0.6) ${outcome} after ${ms(elapsed)} with ${ticks} event-loop turns (the query blocks its thread)`;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Claim 8
// ---------------------------------------------------------------------------------------------

const CATALOG_FIXTURE = `
create role app_user nologin;
create table accounts (id uuid primary key default gen_random_uuid(), tenant_id int not null, name text);
create table memberships (tenant_id int, user_id int, role text, primary key (tenant_id, user_id));
create table events (at timestamptz, payload text);
insert into accounts (tenant_id, name) values (1, 'one'), (2, 'two');
grant select on accounts to app_user;

alter table accounts enable row level security;
alter table accounts force row level security;
alter table memberships enable row level security;

create policy accounts_read on accounts for select to app_user using (tenant_id = 1);
create policy accounts_insert on accounts for insert to public with check (tenant_id = 1);
create policy accounts_guard on accounts as restrictive for all to public using (name is not null);

create view accounts_definer as select id, tenant_id from accounts;
create view accounts_invoker with (security_invoker = true) as select id, tenant_id from accounts;
grant select on accounts_definer, accounts_invoker to app_user;

create function all_tenants() returns setof int language sql security definer
  set search_path = public, pg_temp as 'select tenant_id from accounts order by 1';
create function visible_tenants() returns setof int language sql
  as 'select tenant_id from accounts order by 1';
create function loose_definer() returns int language sql security definer as 'select 1';
`;

async function claimCatalogIntrospection(): Promise<string> {
  return withDb(CATALOG_FIXTURE, async (db) => {
    const tables = await db.query(
      `select c.relname::text as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        order by c.relname`,
    );
    assert.deepEqual(tables.rows, [
      { name: "accounts", rls: true, forced: true },
      { name: "events", rls: false, forced: false },
      { name: "memberships", rls: true, forced: false },
    ]);

    const policies = await db.query(
      `select tablename::text as "table", policyname::text as name, permissive, cmd,
              roles::text[] as roles, qual, with_check
         from pg_policies where schemaname = 'public'
        order by tablename, policyname`,
    );
    assert.deepEqual(policies.rows, [
      {
        table: "accounts",
        name: "accounts_guard",
        permissive: "RESTRICTIVE",
        cmd: "ALL",
        roles: ["public"],
        qual: "(name IS NOT NULL)",
        with_check: null,
      },
      {
        table: "accounts",
        name: "accounts_insert",
        permissive: "PERMISSIVE",
        cmd: "INSERT",
        roles: ["public"],
        qual: null,
        with_check: "(tenant_id = 1)",
      },
      {
        table: "accounts",
        name: "accounts_read",
        permissive: "PERMISSIVE",
        cmd: "SELECT",
        roles: ["app_user"],
        qual: "(tenant_id = 1)",
        with_check: null,
      },
    ]);

    // The raw catalog is there too, for anything pg_policies does not expose.
    const rawPolicy = await firstRow<{ polcmd: string; polpermissive: boolean; using_sql: string }>(
      db,
      `select polcmd::text, polpermissive, pg_get_expr(polqual, polrelid) as using_sql
         from pg_policy where polname = 'accounts_read'`,
    );
    assert.deepEqual(rawPolicy, { polcmd: "r", polpermissive: true, using_sql: "(tenant_id = 1)" });

    const primaryKeys = await db.query(
      `select c.relname::text as "table", a.attname::text as "column",
              format_type(a.atttypid, a.atttypmod) as type,
              pg_get_expr(d.adbin, d.adrelid) as default_sql
         from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where i.indisprimary and n.nspname = 'public'
        order by c.relname, array_position(i.indkey::int2[], a.attnum)`,
    );
    assert.deepEqual(primaryKeys.rows, [
      { table: "accounts", column: "id", type: "uuid", default_sql: "gen_random_uuid()" },
      { table: "memberships", column: "tenant_id", type: "integer", default_sql: null },
      { table: "memberships", column: "user_id", type: "integer", default_sql: null },
    ]);

    const informationSchemaKeys = await db.query(
      `select tc.table_name::text as "table", kcu.column_name::text as "column"
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_schema = tc.constraint_schema and kcu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
        order by tc.table_name, kcu.ordinal_position`,
    );
    assert.deepEqual(informationSchemaKeys.rows, [
      { table: "accounts", column: "id" },
      { table: "memberships", column: "tenant_id" },
      { table: "memberships", column: "user_id" },
    ]);

    const views = await db.query(
      `select c.relname::text as name, c.reloptions::text[] as options
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v' order by c.relname`,
    );
    assert.deepEqual(views.rows, [
      { name: "accounts_definer", options: null },
      { name: "accounts_invoker", options: ["security_invoker=true"] },
    ]);

    const functions = await db.query(
      `select p.proname::text as name, p.prosecdef as security_definer, p.proconfig::text[] as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' order by p.proname`,
    );
    assert.deepEqual(functions.rows, [
      { name: "all_tenants", security_definer: true, config: ["search_path=public, pg_temp"] },
      { name: "loose_definer", security_definer: true, config: null },
      { name: "visible_tenants", security_definer: false, config: null },
    ]);

    // The flags are not decoration: they change what a filtered role gets to see.
    const seen = await asPersona(db, "app_user", {}, async (tx) => ({
      table: (await tx.query<{ t: number }>("select tenant_id as t from accounts order by 1")).rows,
      definerView: (
        await tx.query<{ t: number }>("select tenant_id as t from accounts_definer order by 1")
      ).rows,
      invokerView: (
        await tx.query<{ t: number }>("select tenant_id as t from accounts_invoker order by 1")
      ).rows,
      definerFunction: (await tx.query<{ t: number }>("select all_tenants() as t")).rows,
      invokerFunction: (await tx.query<{ t: number }>("select visible_tenants() as t")).rows,
    }));
    const tenants = (rows: { t: number }[]): number[] => rows.map((row) => row.t);
    assert.deepEqual(tenants(seen.table), [1]);
    assert.deepEqual(tenants(seen.definerView), [1, 2], "a plain view runs as its owner and leaks");
    assert.deepEqual(tenants(seen.invokerView), [1]);
    assert.deepEqual(tenants(seen.definerFunction), [1, 2], "SECURITY DEFINER runs as its owner");
    assert.deepEqual(tenants(seen.invokerFunction), [1]);

    return "pg_class flags, pg_policies and pg_policy, primary keys via pg_index and information_schema, view reloptions, pg_proc.prosecdef/proconfig all readable; definer view/function leak [1,2] where the table gives [1]";
  });
}

// ---------------------------------------------------------------------------------------------
// Claim 9
// ---------------------------------------------------------------------------------------------

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const CLAIMS_A: JwtClaims = { sub: USER_A, role: "authenticated", email: "a@example.com" };
const CLAIMS_B: JwtClaims = { sub: USER_B, role: "authenticated", email: "b@example.com" };
const CLAIMS_ANON: JwtClaims = { role: "anon" };
const CLAIMS_SERVICE: JwtClaims = { role: "service_role" };

const SUPABASE_SCHEMA = `
create table public.notes_leaky (
  id int primary key,
  user_id uuid not null references auth.users (id),
  body text not null
);
create table public.notes_fixed (like public.notes_leaky including all);
create table public.audit_log (id int primary key, user_id uuid, entry text not null);

alter table public.notes_leaky enable row level security;
alter table public.notes_fixed enable row level security;

-- LEAKY: "signed in" is not "owns the row".
create policy "signed-in users can read notes" on public.notes_leaky
  for select to authenticated using (auth.uid() is not null);

-- CORRECT.
create policy "users manage their own notes" on public.notes_fixed
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
`;

const SUPABASE_SEED = `
insert into auth.users (id, email) values ('${USER_A}', 'a@example.com'), ('${USER_B}', 'b@example.com');
insert into public.notes_leaky values (1, '${USER_A}', 'a1'), (2, '${USER_A}', 'a2'), (3, '${USER_B}', 'b1');
insert into public.notes_fixed select * from public.notes_leaky;
insert into public.audit_log values (1, '${USER_A}', 'signed in'), (2, '${USER_B}', 'signed in');
`;

async function claimShimRolesAndFunctions(ctx: SpikeContext): Promise<string> {
  return withDb(ctx.shimSql, async (db) => {
    const roles = await db.query(
      `select rolname::text as name, rolcanlogin as login, rolsuper as super,
              rolbypassrls as bypassrls, rolinherit as inherit
         from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by rolname`,
    );
    const plain = { login: false, super: false, inherit: false };
    assert.deepEqual(roles.rows, [
      { name: "anon", ...plain, bypassrls: false },
      { name: "authenticated", ...plain, bypassrls: false },
      { name: "service_role", ...plain, bypassrls: true },
    ]);

    const authSql = `select auth.uid()::text as uid, auth.role() as role, auth.email() as email, auth.jwt() as jwt`;
    const signedIn = await asPersona(db, "authenticated", CLAIMS_A, (tx) => firstRow(tx, authSql));
    assert.deepEqual(signedIn, {
      uid: USER_A,
      role: "authenticated",
      email: "a@example.com",
      jwt: CLAIMS_A,
    });

    const anonymous = await asPersona(db, "anon", CLAIMS_ANON, (tx) => firstRow(tx, authSql));
    assert.deepEqual(anonymous, { uid: null, role: "anon", email: null, jwt: CLAIMS_ANON });

    // After a rollback the setting is '' and not NULL. Supabase's nullif(...) guard is what keeps
    // ''::jsonb from raising 22P02 here.
    const outside = await firstRow(db, authSql);
    assert.deepEqual(outside, { uid: null, role: null, email: null, jwt: null });

    // The legacy per-claim setting is consulted first, as on Supabase.
    const legacy = await asPersona(db, "authenticated", CLAIMS_A, async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_B]);
      return firstRow<{ uid: string }>(tx, "select auth.uid()::text as uid");
    });
    assert.equal(legacy.uid, USER_B);

    const usersTable = await failureOf(() =>
      asPersona(db, "anon", CLAIMS_ANON, (tx) => tx.query("select * from auth.users")),
    );
    assert.deepEqual(
      [usersTable.code, usersTable.message],
      [RLS_VIOLATION, "permission denied for table users"],
    );

    return `anon/authenticated NOLOGIN NOINHERIT, service_role BYPASSRLS; auth.uid()=${USER_A}, auth.role(), auth.email(), auth.jwt() read ${CLAIMS_SETTING}; all NULL without claims; auth.users closed to anon`;
  });
}

async function claimShimLeakyAndCorrectPolicy(ctx: SpikeContext): Promise<string> {
  return withDb(ctx.shimSql + SUPABASE_SCHEMA + SUPABASE_SEED, async (db) => {
    const selectAudit = "select id from public.audit_log order by id";

    // Without the default grants, the missing table privilege hides the RLS-disabled table.
    const beforeGrants = await failureOf(() =>
      asPersona(db, "anon", CLAIMS_ANON, (tx) => tx.query(selectAudit)),
    );
    assert.deepEqual(
      [beforeGrants.code, beforeGrants.message],
      [RLS_VIOLATION, "permission denied for table audit_log"],
    );

    await db.exec(ctx.defaultGrantsSql("public"));
    const before = await snapshot(db, "public.notes_fixed");

    const read = async (role: string, claims: JwtClaims, table: string): Promise<number[]> =>
      asPersona(db, role, claims, (tx) => idsOf(tx, `select id from public.${table} order by id`));

    const leaky = {
      a: await read("authenticated", CLAIMS_A, "notes_leaky"),
      b: await read("authenticated", CLAIMS_B, "notes_leaky"),
      anon: await read("anon", CLAIMS_ANON, "notes_leaky"),
    };
    assert.deepEqual(leaky, { a: [1, 2, 3], b: [1, 2, 3], anon: [] });
    const leakedToB = leaky.b.filter((id) => ![3].includes(id));
    assert.deepEqual(leakedToB, [1, 2], "leaked = actual minus expected");

    const fixed = {
      a: await read("authenticated", CLAIMS_A, "notes_fixed"),
      b: await read("authenticated", CLAIMS_B, "notes_fixed"),
      anon: await read("anon", CLAIMS_ANON, "notes_fixed"),
      service: await read("service_role", CLAIMS_SERVICE, "notes_fixed"),
    };
    assert.deepEqual(fixed, { a: [1, 2], b: [3], anon: [], service: [1, 2, 3] });

    const ownInsert = await asPersona(db, "authenticated", CLAIMS_A, (tx) =>
      idsOf(tx, `insert into public.notes_fixed values (10, '${USER_A}', 'mine') returning id`),
    );
    const foreignInsert = await failureOf(() =>
      asPersona(db, "authenticated", CLAIMS_A, (tx) =>
        tx.query(`insert into public.notes_fixed values (11, '${USER_B}', 'not mine')`),
      ),
    );
    const updateReach = await asPersona(db, "authenticated", CLAIMS_B, (tx) =>
      idsOf(tx, "update public.notes_fixed set body = body returning id"),
    );
    assert.deepEqual(ownInsert, [10]);
    assert.equal(foreignInsert.code, RLS_VIOLATION);
    assert.deepEqual(updateReach, [3]);

    // The real-world failure: RLS never enabled, and the default grants make the table public.
    const auditAsAnon = await asPersona(db, "anon", CLAIMS_ANON, (tx) => idsOf(tx, selectAudit));
    assert.deepEqual(auditAsAnon, [1, 2]);

    assert.equal(await snapshot(db, "public.notes_fixed"), before);

    return `LEAKY policy: user B reads [${leaky.b}] (leaked [${leakedToB}]); CORRECT policy: A=[${fixed.a}] B=[${fixed.b}] anon=[${fixed.anon}] service_role=[${fixed.service}]; RLS-disabled audit_log: 42501 before the default grants, anon reads [${auditAsAnon}] after`;
  });
}

async function claimShimGrantOrder(ctx: SpikeContext): Promise<string> {
  const schemaWithRevoke = `
create table public.secrets (id int primary key, value text);
insert into public.secrets values (1, 's');
revoke all on public.secrets from anon, authenticated;`;
  const readSecrets = async (db: PGlite): Promise<string> => {
    try {
      const ids = await asPersona(db, "anon", CLAIMS_ANON, (tx) =>
        idsOf(tx, "select id from public.secrets order by id"),
      );
      return `[${ids}]`;
    } catch (error) {
      return String((error as { code?: unknown }).code);
    }
  };

  // Supabase's order: default privileges exist first, the user's REVOKE wins.
  const grantsFirst = await withDb(
    ctx.shimSql + ctx.defaultGrantsSql("public") + schemaWithRevoke,
    readSecrets,
  );
  // Brief 3.5 order (schema, then grants): the blanket GRANT undoes the user's REVOKE.
  const grantsLast = await withDb(
    ctx.shimSql + schemaWithRevoke + ctx.defaultGrantsSql("public"),
    readSecrets,
  );
  assert.equal(grantsFirst, RLS_VIOLATION);
  assert.equal(grantsLast, "[1]");

  return `a table the user REVOKEd from anon: grants applied before the schema (as Supabase does) => ${grantsFirst}; grants applied after the schema => anon reads ${grantsLast} (a false leak)`;
}

/**
 * Supabase changelog 45329: projects created since 2026-05-30, and every project from 2026-10-30,
 * no longer grant select, insert, update, delete on new public tables to the API roles. The same
 * RLS-disabled table is then NOT readable by anon, and reporting it as readable would be a false
 * finding. This claim pins both answers side by side so that Phase 3 has to choose on purpose.
 */
async function claimShimExplicitGrants(ctx: SpikeContext): Promise<string> {
  const explicit = ctx.defaultGrantsSql("public", { autoExposeNewTables: false });
  const legacy = ctx.defaultGrantsSql("public");
  const selectAudit = "select id from public.audit_log order by id";
  const userSchema = SUPABASE_SCHEMA + SUPABASE_SEED;

  const auditAsAnon = async (db: PGlite): Promise<string> => {
    try {
      const ids = await asPersona(db, "anon", CLAIMS_ANON, (tx) => idsOf(tx, selectAudit));
      return `[${ids}]`;
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown };
      return `${String(failure.code)} ${String(failure.message)}`;
    }
  };

  // Legacy projects: RLS is the only barrier, so the RLS-disabled table is wide open.
  const legacyResult = await withDb(ctx.shimSql + legacy + userSchema, auditAsAnon);
  assert.equal(legacyResult, "[1,2]");

  // Explicit-grant projects: closed, whichever side of the user's schema the grants run on.
  const denied = `${RLS_VIOLATION} permission denied for table audit_log`;
  const explicitFirst = await withDb(ctx.shimSql + explicit + userSchema, auditAsAnon);
  const explicitLast = await withDb(ctx.shimSql + userSchema + explicit, auditAsAnon);
  assert.equal(explicitFirst, denied);
  assert.equal(explicitLast, denied);

  // With the grants Supabase now documents, written by the user, RLS is the barrier again:
  // the RLS-disabled table opens up for anon, the policy-protected one filters per user, and a
  // role the user did not grant anything to is stopped by the privilege check, not by a policy.
  const userGrants = `
grant select on public.audit_log to anon;
grant select, insert, update, delete on public.notes_fixed to authenticated;`;
  return withDb(ctx.shimSql + explicit + userSchema + userGrants, async (db) => {
    const read = async (role: string, claims: JwtClaims, table: string): Promise<number[]> =>
      asPersona(db, role, claims, (tx) => idsOf(tx, `select id from public.${table} order by id`));

    assert.equal(await auditAsAnon(db), "[1,2]");
    const fixed = {
      a: await read("authenticated", CLAIMS_A, "notes_fixed"),
      b: await read("authenticated", CLAIMS_B, "notes_fixed"),
    };
    assert.deepEqual(fixed, { a: [1, 2], b: [3] });
    const anonOnFixed = await failureOf(() => read("anon", CLAIMS_ANON, "notes_fixed"));
    assert.deepEqual(
      [anonOnFixed.code, anonOnFixed.message],
      [RLS_VIOLATION, "permission denied for table notes_fixed"],
    );
    // service_role bypasses RLS, not the privilege check: without a grant it is locked out too.
    const serviceOnFixed = await failureOf(() =>
      read("service_role", CLAIMS_SERVICE, "notes_fixed"),
    );
    assert.equal(serviceOnFixed.code, RLS_VIOLATION);

    return `RLS-disabled audit_log as anon: legacy default grants => ${legacyResult}; autoExposeNewTables=false => ${explicitFirst} (grants before the schema) and the same after it; after the user's own "grant select ... to anon" => [1,2]; notes_fixed granted to authenticated only: A=[${fixed.a}] B=[${fixed.b}], anon and service_role 42501`;
  });
}

// ---------------------------------------------------------------------------------------------
// Claim 10
// ---------------------------------------------------------------------------------------------

async function claimTimings(ctx: SpikeContext): Promise<string> {
  const starts: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const startedAt = performance.now();
    const db = new PGlite();
    await db.waitReady;
    starts.push(performance.now() - startedAt);
    await db.close();
  }

  const db = new PGlite();
  try {
    await db.waitReady;
    const setupStartedAt = performance.now();
    await db.exec(ctx.shimSql + SUPABASE_SCHEMA + SUPABASE_SEED + ctx.defaultGrantsSql("public"));
    const setup = performance.now() - setupStartedAt;

    const probes: number[] = [];
    for (let run = 0; run < 50; run += 1) {
      const startedAt = performance.now();
      const ids = await asPersona(db, "authenticated", CLAIMS_A, (tx) =>
        idsOf(tx, "update public.notes_fixed set body = body returning id"),
      );
      probes.push(performance.now() - startedAt);
      assert.deepEqual(
        ids.toSorted((a, b) => a - b),
        [1, 2],
      );
    }

    const cloneStartedAt = performance.now();
    const copy = await db.clone();
    const clone = performance.now() - cloneStartedAt;
    try {
      const copied = await copy.query<{ id: number }>(
        "select id from public.notes_fixed order by id",
      );
      assert.deepEqual(
        copied.rows.map((row) => row.id),
        [1, 2, 3],
      );
    } finally {
      await copy.close();
    }

    // Generous ceilings: they catch an order-of-magnitude regression, not a noisy CI runner.
    assert.ok(median(starts) < 5000, `fresh instance took ${ms(median(starts))}`);
    assert.ok(median(probes) < 100, `probe transaction took ${ms(median(probes))}`);

    return `fresh instance: median ${ms(median(starts))} (min ${ms(Math.min(...starts))}, max ${ms(Math.max(...starts))}); shim+schema+seed+grants: ${ms(setup)}; probe transaction (BEGIN, SET LOCAL ROLE, set_config, UPDATE RETURNING, ROLLBACK): median ${ms(median(probes))}, max ${ms(Math.max(...probes))} over 50 runs; clone() of a prepared instance: ${ms(clone)}`;
  } finally {
    await db.close();
  }
}

export const claims: readonly Claim[] = [
  {
    id: "1",
    title:
      "CREATE ROLE (NOLOGIN, BYPASSRLS), GRANT, ENABLE and FORCE RLS, CREATE POLICY with USING and WITH CHECK",
    run: claimDdl,
  },
  {
    id: "2",
    title:
      "SET LOCAL ROLE and set_config(request.jwt.claims) live inside the transaction and are gone after ROLLBACK, data unchanged",
    run: claimTransactionLocalIdentity,
  },
  {
    id: "3",
    title:
      "a non-superuser role is really filtered, the superuser is not, and a probe without SET LOCAL ROLE sees everything",
    run: claimFilteringAndControl,
  },
  {
    id: "4",
    title:
      "the three bypasses: superuser, BYPASSRLS role, table owner unless FORCE ROW LEVEL SECURITY",
    run: claimBypasses,
  },
  {
    id: "5",
    title:
      "policy violations surface SQLSTATE 42501 on error.code, constraints 23xxx, and the instance survives a failed transaction",
    run: claimErrorShape,
  },
  {
    id: "6",
    title:
      "UPDATE/DELETE ... RETURNING return only permitted rows; moving a row out of scope needs an explicit WITH CHECK",
    run: claimReturningAndScopeEscape,
  },
  {
    id: "7",
    title:
      "gen_random_uuid() exists; statement_timeout is accepted but does not abort a slow query",
    run: claimUuidAndStatementTimeout,
  },
  {
    id: "8",
    title:
      "catalog introspection: RLS flags, policies, primary keys, view options, SECURITY DEFINER and search_path",
    run: claimCatalogIntrospection,
  },
  {
    id: "9a",
    title: "Supabase shim: roles and auth.uid(), auth.role(), auth.email(), auth.jwt()",
    run: claimShimRolesAndFunctions,
  },
  {
    id: "9b",
    title:
      "Supabase shim end to end: one leaky policy, one correct policy, and an RLS-disabled table readable by anon after the default grants",
    run: claimShimLeakyAndCorrectPolicy,
  },
  {
    id: "9c",
    title:
      "Supabase default grants: applied after the schema they override a user's REVOKE, applied before they do not",
    run: claimShimGrantOrder,
  },
  {
    id: "9d",
    title:
      "Supabase without auto-exposed tables (the default since 2026-05-30): an RLS-disabled table is closed to anon until the user grants it",
    run: claimShimExplicitGrants,
  },
  {
    id: "10",
    title: "a fresh instance per run and a probe transaction are cheap enough",
    run: claimTimings,
  },
];
