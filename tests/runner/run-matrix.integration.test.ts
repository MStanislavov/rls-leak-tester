/**
 * The run as a whole against a real PGlite: determinism, an unchanged database, the rebuild after
 * a lost database, cancellation, progress, and what is thrown.
 */
import { describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { MatrixAbortedError, type MatrixProgress } from "@/lib/runner";
import { SetupError } from "@/lib/runner/setup";
import { EngineTimeoutError, type SqlEngine } from "@/lib/runner/types";
import { tenantScenario } from "./fixtures";
import { ALICE, BOB, CLAIM, cellOf, dumpDatabase, keys, run, scenarioOf } from "./helpers";

describe("determinism", () => {
  it("two runs of the same scenario give byte-identical result JSON", async () => {
    const scenario = tenantScenario("leaky");
    const first = await run(scenario);
    const second = await run(scenario, { now: () => 42 });
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
    expect(first.result.verdict).toBe("LEAKING");
    expect(JSON.stringify(first.result)).not.toMatch(/"(ms|durationMs|startedAt|timestamp)"/);
    // Timings live beside the result, never inside it.
    expect(second.timings).toMatchObject({ totalMs: 0, setupMs: 0, rebuilds: 0 });
    expect(second.timings.cells).toHaveLength(second.result.totalCells);
  }, 60_000);

  it("the fixed variant is ISOLATED, the leaky one differs only where the policy differs", async () => {
    const leaky = (await run(tenantScenario("leaky"))).result;
    const fixed = (await run(tenantScenario("fixed"))).result;
    expect(fixed.verdict).toBe("ISOLATED");
    expect(fixed.counts).toMatchObject({ leak: 0, escape: 0 });
    const differing = leaky.cells
      .filter((cell, index) => cell.status !== fixed.cells[index]?.status)
      .map((cell) => `${cell.id}=${cell.status}`);
    expect(differing).toEqual([
      "alice|public.projects|update=escape",
      "carol|public.projects|update=escape",
    ]);
  }, 60_000);
});

describe("the database after a run", () => {
  it("is unchanged: rows, sequences, policies and roles dump identically before and after", async () => {
    const engine = await createPgliteEngine();
    let before: string | undefined;
    let closed = 0;
    const observed: SqlEngine = {
      ...engine,
      // The first transaction is the first probe: setup, introspection and ground truth are done.
      transaction: async (callback) => {
        before ??= await dumpDatabase(engine);
        return engine.transaction(callback);
      },
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    };
    try {
      const { result } = await run(tenantScenario("leaky"), {
        createEngine: () => Promise.resolve(observed),
      });
      // The run did write inside its transactions: inserts, updates and deletes were allowed.
      expect(result.counts.escape).toBeGreaterThan(0);
      expect(cellOf(result, "alice", "projects", "delete").actualKeys).toEqual(keys(1));
      expect(closed).toBe(1);

      const after = await dumpDatabase(engine);
      expect(before).toBeDefined();
      expect(after).toBe(before);
      expect(after).toContain('"public"."projects_id_seq"=3:true');
      const { rows } = await engine.query("select current_user::text as role");
      expect(rows).toEqual([{ role: "postgres" }]);
    } finally {
      await engine.close();
    }
  }, 60_000);
});

describe("a lost database", () => {
  it("makes the cell inconclusive and rebuilds through the factory", async () => {
    const created: { engine: SqlEngine; closed: boolean }[] = [];
    let timeouts = 0;
    const createEngine = async (): Promise<SqlEngine> => {
      const inner = await createPgliteEngine();
      const entry = { engine: inner, closed: false };
      created.push(entry);
      return {
        ...inner,
        close: async () => {
          entry.closed = true;
          await inner.close();
        },
        transaction: (callback) =>
          inner.transaction((tx) =>
            callback({
              exec: (sql) => tx.exec(sql),
              rollback: () => tx.rollback(),
              get closed() {
                return tx.closed;
              },
              query: (sql, params) => {
                if (timeouts === 0 && sql.startsWith('update "public"."projects" set "name"')) {
                  timeouts += 1;
                  // What the worker engine does: the worker is gone, and so is the database.
                  return Promise.reject(new EngineTimeoutError(5000));
                }
                return tx.query(sql, params);
              },
            }),
          ),
      };
    };

    const progress: MatrixProgress[] = [];
    const { result, timings } = await run(tenantScenario("fixed"), {
      createEngine,
      onProgress: (entry) => progress.push(entry),
    });

    expect(timings.rebuilds).toBe(1);
    expect(created).toHaveLength(2);
    expect(created.map((entry) => entry.closed)).toEqual([true, true]);

    const lost = result.cells.filter((cell) => cell.status === "inconclusive");
    expect(lost.map((cell) => cell.id)).toEqual(["visitor|public.projects|update"]);
    expect(lost[0]).toMatchObject({
      error: { sqlState: null, message: expect.stringContaining("did not answer within 5000 ms") },
      reason: expect.stringContaining("was terminated"),
    });
    expect(lost[0]?.sql).toContain('update "public"."projects" set "name" = "name"');

    // Every later cell ran against the rebuilt database and is measured as usual.
    expect(cellOf(result, "alice", "projects", "update")).toMatchObject({
      status: "pass",
      actualKeys: keys(1, 2),
    });
    expect(result.verdict).toBe("ISOLATED");
    expect(result.counts.inconclusive).toBe(1);
    expect(progress.map((entry) => entry.done)).toEqual(
      Array.from({ length: result.totalCells }, (_, index) => index + 1),
    );
    expect(progress.every((entry) => entry.total === result.totalCells)).toBe(true);
  }, 60_000);
});

describe("cancellation and errors", () => {
  it("stops before the next cell when the signal aborts, and closes the engine", async () => {
    const controller = new AbortController();
    let closed = 0;
    const seen: string[] = [];
    await expect(
      run(tenantScenario("fixed"), {
        signal: controller.signal,
        createEngine: async () => {
          const engine = await createPgliteEngine();
          return {
            ...engine,
            close: async () => {
              closed += 1;
              await engine.close();
            },
          };
        },
        onProgress: ({ cell }) => {
          seen.push(cell.id);
          if (seen.length === 2) {
            controller.abort();
          }
        },
      }),
    ).rejects.toBeInstanceOf(MatrixAbortedError);
    expect(seen).toHaveLength(2);
    expect(closed).toBe(1);
  }, 60_000);

  it("throws SetupError for failing scenario SQL, with the engine closed", async () => {
    let closed = 0;
    const failing = scenarioOf({
      schemaSql: "create table ok (id int primary key);\nselect nope;",
    });
    const attempt = run(failing, {
      createEngine: async () => {
        const engine = await createPgliteEngine();
        return {
          ...engine,
          close: async () => {
            closed += 1;
            await engine.close();
          },
        };
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(SetupError);
    await expect(attempt).rejects.toMatchObject({
      phase: "schema",
      statementIndex: 1,
      sqlState: "42703",
    });
    expect(closed).toBe(1);
  }, 60_000);

  it("a scenario without tables or personas proves nothing", async () => {
    const { result } = await run(scenarioOf({ schemaSql: "" }));
    expect(result).toMatchObject({ verdict: "NOT PROVEN", totalCells: 0, cells: [] });
  }, 60_000);
});

describe("column privileges", () => {
  it("the no-op update uses a column the role may update, and records 42501 when there is none", async () => {
    const own = `user_id = ${CLAIM("sub")}::uuid`;
    const { result } = await run(
      scenarioOf({
        schemaSql: `
          create role app_user nologin;
          create role app_reader nologin;
          create table posts (id int primary key, user_id uuid not null, title text, body text);
          alter table posts enable row level security;
          create policy own on posts for all using (${own});
          grant select on posts to app_user, app_reader;
          grant update (body) on posts to app_user;
        `,
        seedSql: `insert into posts values (1, '${ALICE}', 't', 'b'), (2, '${BOB}', 't', 'b');`,
        personas: [
          { id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } },
          { id: "reader", label: "Reader", dbRole: "app_reader", claims: { sub: ALICE } },
        ],
      }),
    );
    const alice = cellOf(result, "alice", "posts", "update");
    expect(alice).toMatchObject({ status: "pass", actualKeys: keys(1), perRowFallback: false });
    expect(alice.sql).toContain('set "body" = "body"');
    // The owner column is not granted, so the targeted move is refused by the privilege check.
    expect(alice.subProbes.map((probe) => probe.outcome)).toEqual(["blocked", "blocked"]);

    expect(cellOf(result, "reader", "posts", "update")).toMatchObject({
      status: "overblock",
      actualKeys: [],
      missingKeys: keys(1),
      // A missing privilege is about the statement: it is not repeated for every row.
      perRowFallback: false,
      error: { sqlState: "42501", message: "permission denied for table posts" },
    });
  }, 60_000);
});
