import { describe, expect, it } from "vitest";
import {
  IdentityError,
  SuperuserStepError,
  createProbeExecutor,
  executeAsPersona,
} from "./executor";
import { staticProbe } from "./probes";
import {
  EngineTimeoutError,
  SqlError,
  type SqlEngine,
  type SqlQueryResult,
  type SqlRow,
} from "./types";

interface FakeOptions {
  /** What `select current_user` answers. */
  readonly currentUser?: string;
  /** What `current_setting('row_security')` answers. */
  readonly rowSecurity?: string;
  /** Statements (by substring) that raise. */
  readonly failures?: Readonly<Record<string, Error>>;
}

/** A scripted engine: records what is sent and keeps the port's transaction contract. */
function fakeEngine(options: FakeOptions = {}): { engine: SqlEngine; log: string[] } {
  const log: string[] = [];
  const answer = (sql: string): SqlQueryResult => {
    const failure = Object.entries(options.failures ?? {}).find(([part]) => sql.includes(part));
    if (failure !== undefined) {
      throw failure[1];
    }
    const rows: SqlRow[] = sql.includes("current_user")
      ? [
          {
            role: options.currentUser ?? "app",
            session_role: "postgres",
            row_security: options.rowSecurity ?? "on",
          },
        ]
      : [{ k0: "1" }];
    return { rows, affectedRows: 0 };
  };
  const engine: SqlEngine = {
    query: () => Promise.reject(new Error("probes must use the tx handle")),
    exec: () => Promise.reject(new Error("probes must use the tx handle")),
    close: () => Promise.resolve(),
    transaction: async (callback) => {
      log.push("BEGIN");
      let closed = false;
      const end = (statement: string): Promise<void> => {
        if (!closed) {
          closed = true;
          log.push(statement);
        }
        return Promise.resolve();
      };
      try {
        const value = await callback({
          query: (sql, params) => {
            log.push(`${sql} ${JSON.stringify(params ?? [])}`);
            return Promise.resolve().then(() => answer(sql));
          },
          exec: () => Promise.reject(new Error("not used")),
          rollback: () => end("ROLLBACK"),
          get closed() {
            return closed;
          },
        });
        await end("COMMIT");
        return value;
      } catch (error) {
        await end("ROLLBACK");
        throw error;
      }
    },
  };
  return { engine, log };
}

const identity = { role: "app", claimsJson: '{"sub":"a"}' };
const probe = staticProbe("select 1 as k0");
const PINS =
  "select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true), set_config('request.jwt.claim.email', '', true), set_config('request.jwt.claim', '', true), set_config('row_security', 'on', true), set_config('TimeZone', 'UTC', true)";
const WHOAMI =
  "select current_user::text as role, session_user::text as session_role, current_setting('row_security') as row_security";
/** The statements that put a transaction under the persona, BEGIN included. */
const IDENTITY_STATEMENTS = 5;

describe("executeAsPersona", () => {
  it("switches role and claims, pins the session, checks the identity, probes, rolls back", async () => {
    const { engine, log } = fakeEngine();
    const run = await executeAsPersona(engine, identity, (session) => session.run(probe));
    expect(log).toEqual([
      "BEGIN",
      `select set_config('role', $1::text, true) ["app"]`,
      `select set_config('request.jwt.claims', $1::text, true) ["{\\"sub\\":\\"a\\"}"]`,
      `${PINS} []`,
      `${WHOAMI} []`,
      "select 1 as k0 []",
      "ROLLBACK",
    ]);
    expect(run).toMatchObject({ ok: true, value: { rows: [{ k0: "1" }] } });
    expect(run.sql.split("\n")).toEqual([
      "begin;",
      "select set_config('role', 'app', true);",
      `select set_config('request.jwt.claims', '{"sub":"a"}', true);`,
      `${PINS};`,
      `${WHOAMI};`,
      "select 1 as k0;",
      "rollback;",
    ]);
  });

  it("never commits, even when the work resolves", async () => {
    const { engine, log } = fakeEngine();
    await executeAsPersona(engine, identity, () => Promise.resolve("done"));
    expect(log).not.toContain("COMMIT");
    expect(log.at(-1)).toBe("ROLLBACK");
  });

  it("refuses to probe when current_user is not the persona's role", async () => {
    const { engine, log } = fakeEngine({ currentUser: "postgres" });
    let probed = false;
    const run = await executeAsPersona(engine, identity, () => {
      probed = true;
      return Promise.resolve(1);
    });
    expect(probed).toBe(false);
    expect(run).toMatchObject({
      ok: false,
      databaseLost: false,
      failure: {
        sqlState: null,
        message: expect.stringContaining('as "postgres" instead of "app"'),
      },
    });
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(new IdentityError("x").name).toBe("IdentityError");
  });

  it("refuses to probe when row_security is not on (the header of every pg_dump file)", async () => {
    const { engine } = fakeEngine({ rowSecurity: "off" });
    let probed = false;
    const run = await executeAsPersona(engine, identity, () => {
      probed = true;
      return Promise.resolve(1);
    });
    expect(probed).toBe(false);
    expect(run).toMatchObject({
      ok: false,
      failure: { sqlState: null, message: expect.stringContaining("row_security = off") },
    });
  });

  it("returns a Postgres error with its SQLSTATE and the script so far", async () => {
    const { engine, log } = fakeEngine({
      failures: { "select 1": new SqlError({ code: "42501", message: "permission denied" }) },
    });
    const run = await executeAsPersona(engine, identity, (session) => session.run(probe));
    expect(run).toMatchObject({
      ok: false,
      databaseLost: false,
      failure: { sqlState: "42501", message: "permission denied" },
    });
    expect(run.sql).toContain("select 1 as k0;\nrollback;");
    expect(log.at(-1)).toBe("ROLLBACK");
  });

  it("a role that does not exist fails the switch, never runs as the session user", async () => {
    const { engine } = fakeEngine({
      failures: { "'role'": new SqlError({ code: "22023", message: 'role "app" does not exist' }) },
    });
    const run = await executeAsPersona(engine, identity, (session) => session.run(probe));
    expect(run).toMatchObject({ ok: false, failure: { sqlState: "22023" } });
    expect(run.sql).not.toContain("select 1 as k0");
  });

  it("reports a lost database", async () => {
    const { engine } = fakeEngine({ failures: { "select 1": new EngineTimeoutError(5000) } });
    const run = await executeAsPersona(engine, identity, (session) => session.run(probe));
    expect(run).toMatchObject({ ok: false, databaseLost: true, failure: { sqlState: null } });
  });

  it("attempt wraps the statement in a savepoint and hands a Postgres error back", async () => {
    const { engine, log } = fakeEngine({
      failures: { "delete from b": new SqlError({ code: "23503", message: "still referenced" }) },
    });
    const run = await executeAsPersona(engine, identity, async (session) => [
      await session.attempt(staticProbe("delete from a")),
      await session.attempt(staticProbe("delete from b")),
    ]);
    expect(run).toMatchObject({
      ok: true,
      value: [
        { ok: true, readBack: null },
        { ok: false, failure: { sqlState: "23503", message: "still referenced" } },
      ],
    });
    expect(log.slice(IDENTITY_STATEMENTS, -1)).toEqual([
      "savepoint rls_probe []",
      "delete from a []",
      "rollback to savepoint rls_probe []",
      "release savepoint rls_probe []",
      "savepoint rls_probe []",
      "delete from b []",
      "rollback to savepoint rls_probe []",
      "release savepoint rls_probe []",
    ]);
  });

  it("attempt lets a lost database through", async () => {
    const { engine } = fakeEngine({ failures: { "delete from a": new EngineTimeoutError(1) } });
    const run = await executeAsPersona(engine, identity, (session) =>
      session.attempt(staticProbe("delete from a")),
    );
    expect(run).toMatchObject({ ok: false, databaseLost: true });
  });

  const BECOME_PERSONA = [
    "select set_config('role', $1::text, true)",
    "select set_config('request.jwt.claims', $1::text, true)",
    PINS,
    WHOAMI,
  ];
  const sent = (log: readonly string[]): (string | undefined)[] =>
    log.slice(IDENTITY_STATEMENTS, -1).map((line) => line.split(" [")[0]);

  it("asSuperuser resets the role, runs its statements in order, and becomes the persona again", async () => {
    const { engine, log } = fakeEngine();
    const run = await executeAsPersona(engine, identity, (session) =>
      session.asSuperuser(staticProbe("create temporary table s"), staticProbe("select 2 as k0")),
    );
    expect(sent(log)).toEqual([
      "reset role",
      "create temporary table s",
      "select 2 as k0",
      ...BECOME_PERSONA,
    ]);
    expect(run).toMatchObject({ ok: true, value: { rows: [{ k0: "1" }] } });
  });

  it("a Postgres error of the superuser's part is never the persona's: it loses its SQLSTATE", async () => {
    const { engine } = fakeEngine({
      failures: { "select 2": new SqlError({ code: "42501", message: "permission denied" }) },
    });
    const run = await executeAsPersona(engine, identity, (session) =>
      session.asSuperuser(staticProbe("select 2 as k0")),
    );
    expect(run).toMatchObject({
      ok: false,
      databaseLost: false,
      failure: {
        sqlState: null,
        message: expect.stringContaining("[42501] permission denied"),
      },
    });
    expect(new SuperuserStepError("x").name).toBe("SuperuserStepError");
  });

  it("asSuperuser lets a lost database through", async () => {
    const { engine } = fakeEngine({ failures: { "select 2": new EngineTimeoutError(1) } });
    const run = await executeAsPersona(engine, identity, (session) =>
      session.asSuperuser(staticProbe("select 2 as k0")),
    );
    expect(run).toMatchObject({ ok: false, databaseLost: true });
  });

  it("attempt with a read-back reads as the superuser inside the savepoint, only after success", async () => {
    const { engine, log } = fakeEngine({
      failures: { "update b": new SqlError({ code: "42501", message: "no" }) },
    });
    const readBack = staticProbe("select 3 as k0");
    const run = await executeAsPersona(engine, identity, async (session) => [
      await session.attempt(staticProbe("update a"), readBack),
      await session.attempt(staticProbe("update b"), readBack),
    ]);
    expect(run).toMatchObject({
      ok: true,
      value: [{ ok: true, readBack: { rows: [{ k0: "1" }] } }, { ok: false }],
    });
    expect(sent(log)).toEqual([
      "savepoint rls_probe",
      "update a",
      "reset role",
      "select 3 as k0",
      ...BECOME_PERSONA,
      "rollback to savepoint rls_probe",
      "release savepoint rls_probe",
      "savepoint rls_probe",
      "update b",
      "rollback to savepoint rls_probe",
      "release savepoint rls_probe",
    ]);
  });
});

describe("createProbeExecutor seams (bypass-guard tests only)", () => {
  it("a switch that was forgotten is caught by the identity check", async () => {
    const { engine } = fakeEngine({ currentUser: "postgres" });
    const broken = createProbeExecutor({ switchIdentity: () => [] });
    const run = await broken(engine, identity, (session) => session.run(probe));
    expect(run.ok).toBe(false);
    expect(run.sql).not.toContain("set_config('role'");
  });

  it("without the check the broken executor probes as the session user", async () => {
    const { engine, log } = fakeEngine({ currentUser: "postgres" });
    const broken = createProbeExecutor({ switchIdentity: () => [], verifyIdentity: false });
    const run = await broken(engine, identity, (session) => session.run(probe));
    expect(run.ok).toBe(true);
    expect(log).toEqual(["BEGIN", "select 1 as k0 []", "ROLLBACK"]);
  });
});
