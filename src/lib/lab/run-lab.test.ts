/**
 * The host of a run against a real PGlite in Node (the same engine code the browser worker
 * runs), plus scripted engines for what Node cannot do: a statement that never returns.
 */
import { describe, expect, it, vi } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import {
  EngineError,
  EngineTerminatedError,
  EngineTimeoutError,
  type SqlEngine,
} from "@/lib/runner/types";
import type { Scenario } from "@/lib/scenario";
import { MULTI_TENANT_SAAS, TODOS_SHARING } from "@/lib/scenario/templates";
import {
  introspectLab,
  runLab,
  type LabEngineHandle,
  type LabRunPorts,
  type LabTimers,
} from "./run-lab";
import { scenarioFromTemplate, withSql } from "./scenario-edit";

/**
 * Most tests here boot a real PGlite and run a whole matrix. That takes about a second alone and
 * more than Vitest's default 5 s when the full suite has every worker booting WASM at once, which
 * made this file fail now and then. The other real-PGlite suites (tests/runner, tests/golden) set
 * the same kind of watchdog. It is not a product threshold: the run ceiling and the probe timeout
 * are tested below with injected timers, never with the wall clock.
 */
const REAL_ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: REAL_ENGINE_TEST_TIMEOUT_MS });

/** Node has no worker to terminate: closing the in-process database is the closest thing. */
function handleOf(engine: SqlEngine, terminate?: () => void): LabEngineHandle {
  return { engine, terminate: terminate ?? (() => void engine.close().catch(() => undefined)) };
}

const REAL: LabRunPorts = {
  createEngine: async () => handleOf(await createPgliteEngine()),
  supabase: SUPABASE_SETUP_SQL,
};

const realEngine = (): Promise<SqlEngine> => createPgliteEngine();

/** Timers that only fire when the test says so. */
function manualTimers(): LabTimers & { fire(): void; cleared: number } {
  let pending: (() => void) | null = null;
  const timers = {
    cleared: 0,
    set: (callback: () => void) => {
      pending = callback;
      return 1;
    },
    clear: () => {
      timers.cleared += 1;
      pending = null;
    },
    fire: () => pending?.(),
  };
  return timers;
}

/**
 * An engine whose `exec` of `stuckOn` never answers, like a statement inside WASM: `close()`
 * does not end it, only `terminate()` does.
 */
function stuckEngine(
  inner: SqlEngine,
  stuckOn: string,
  error: () => Error,
  onStuck: () => void,
): LabEngineHandle & { closedWhileStuck: () => boolean } {
  let release: ((error: Error) => void) | null = null;
  let closedWhileStuck = false;
  return {
    engine: {
      exec: (sql) =>
        sql === stuckOn
          ? new Promise<void>((_resolve, reject) => {
              release = reject;
              onStuck();
            })
          : inner.exec(sql),
      query: (sql, params) => inner.query(sql, params),
      transaction: (callback) => inner.transaction(callback),
      close: async () => {
        closedWhileStuck = closedWhileStuck || release !== null;
        await inner.close();
      },
    },
    terminate: () => {
      const reject = release;
      release = null;
      reject?.(error());
    },
    closedWhileStuck: () => closedWhileStuck,
  };
}

function leaky(): Scenario {
  return scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky");
}

describe("runLab", () => {
  it("runs a leaky template: LEAKING, the declared cells, the declared findings", async () => {
    const progress: number[] = [];
    const outcome = await runLab(leaky(), REAL, {
      onProgress: ({ done }) => progress.push(done),
    });
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") {
      return;
    }
    const { result } = outcome.run;
    expect(result.verdict).toBe("LEAKING");
    const failing = result.cells
      .filter((cell) => cell.status === "leak" || cell.status === "escape")
      .map(({ personaId, schema, table, operation, status }) => ({
        personaId,
        schema,
        table,
        operation,
        status,
      }));
    expect(failing).toEqual(MULTI_TENANT_SAAS.leaky.expectedFailures);
    expect(outcome.findings.map((finding) => finding.id)).toEqual(
      MULTI_TENANT_SAAS.leaky.expectedStaticChecks.map((check) => check.id),
    );
    expect(progress).toHaveLength(result.totalCells);
    expect(progress.at(-1)).toBe(result.totalCells);
  });

  it("runs a fixed template: ISOLATED, no findings", async () => {
    const outcome = await runLab(scenarioFromTemplate(TODOS_SHARING, "fixed"), REAL);
    expect(outcome.kind === "done" ? outcome.run.result.verdict : outcome.kind).toBe("ISOLATED");
    expect(outcome.kind === "done" ? outcome.findings : null).toEqual([]);
  });

  it("reports a failing schema statement with its SQLSTATE and the line Postgres points at", async () => {
    const scenario = withSql(
      leaky(),
      "schema",
      "create table public.ok (id int primary key);\n\ncreate table public.broken (\n  id int primary key,\n  oops nonexistent_type\n);",
    );
    const outcome = await runLab(scenario, REAL);
    expect(outcome).toMatchObject({
      kind: "setup-error",
      error: {
        phase: "schema",
        editor: "schema",
        sqlState: "42704",
        statementLine: 3,
        errorLine: 5,
        timedOut: false,
      },
    });
    expect(outcome.kind === "setup-error" ? outcome.error.statement : "").toContain(
      "create table public.broken",
    );
  });

  it("reports a failing seed statement in the seed editor", async () => {
    const scenario = withSql(leaky(), "seed", "insert into public.nowhere values (1);");
    const outcome = await runLab(scenario, REAL);
    expect(outcome).toMatchObject({
      kind: "setup-error",
      error: { phase: "seed", editor: "seed", sqlState: "42P01", statementLine: 1 },
    });
  });

  it("is cancelled before it starts when the signal is already aborted", async () => {
    let created = 0;
    const ports: LabRunPorts = {
      ...REAL,
      createEngine: () => {
        created += 1;
        return REAL.createEngine();
      },
    };
    const outcome = await runLab(leaky(), ports, { signal: AbortSignal.abort() });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(created).toBe(0);
  });

  it("cancels in the middle of a run and closes the engine", async () => {
    const controller = new AbortController();
    let closed = 0;
    let terminated = 0;
    const ports: LabRunPorts = {
      ...REAL,
      createEngine: async () => {
        const engine = await realEngine();
        return handleOf(
          {
            exec: (sql) => engine.exec(sql),
            query: (sql, params) => engine.query(sql, params),
            transaction: (callback) => engine.transaction(callback),
            close: async () => {
              closed += 1;
              await engine.close();
            },
          },
          () => {
            terminated += 1;
          },
        );
      },
    };
    const outcome = await runLab(leaky(), ports, {
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done === 3) {
          controller.abort();
        }
      },
    });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(terminated).toBe(1);
    expect(closed).toBeGreaterThan(0);
  });

  it("cuts a stuck setup statement off at the ceiling and says so", async () => {
    const timers = manualTimers();
    const stuckOn = "select pg_sleep(60)";
    const scenario = withSql(leaky(), "seed", `${stuckOn};`);
    const stuck = Promise.withResolvers<void>();
    const ports: LabRunPorts = {
      ...REAL,
      createEngine: async () =>
        stuckEngine(
          await realEngine(),
          stuckOn,
          () => new EngineTerminatedError("terminated"),
          stuck.resolve,
        ),
    };
    const pending = runLab(scenario, ports, { timers, ceilingMs: 60_000 });
    await stuck.promise;
    timers.fire();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "failed", reason: "ceiling" });
    expect(outcome.kind === "failed" ? outcome.message : "").toContain("60 seconds");
    expect(timers.cleared).toBe(1);
  });

  it("names the seed statement that timed out, by occurrence", async () => {
    const stuckOn = "select pg_sleep(60)";
    const scenario = withSql(leaky(), "seed", `select 1;\n${stuckOn};\nselect 2;`);
    const ports: LabRunPorts = {
      ...REAL,
      createEngine: async () => {
        const inner = await realEngine();
        return handleOf({
          exec: (sql) =>
            sql === stuckOn ? Promise.reject(new EngineTimeoutError(5_000)) : inner.exec(sql),
          query: (sql, params) => inner.query(sql, params),
          transaction: (callback) => inner.transaction(callback),
          close: () => inner.close(),
        });
      },
    };
    const outcome = await runLab(scenario, ports);
    expect(outcome).toMatchObject({
      kind: "setup-error",
      error: {
        phase: "seed",
        editor: "seed",
        sqlState: null,
        statement: stuckOn,
        statementLine: 2,
        errorLine: 2,
        timedOut: true,
      },
    });
    expect(outcome.kind === "setup-error" ? outcome.error.message : "").toContain("5000 ms");
  });

  it("reports an engine that cannot start as a failure, not as a verdict", async () => {
    const ports: LabRunPorts = {
      ...REAL,
      createEngine: () => Promise.reject(new EngineError("The WASM module did not load")),
    };
    expect(await runLab(leaky(), ports)).toEqual({
      kind: "failed",
      reason: "engine",
      message: "The WASM module did not load",
    });
    const odd: LabRunPorts = { ...REAL, createEngine: () => Promise.reject("plain text") };
    expect(await runLab(leaky(), odd)).toMatchObject({ kind: "failed", message: "plain text" });
  });

  it("a timeout in the product's own SQL is an engine failure, there is no statement to show", async () => {
    const ports: LabRunPorts = {
      ...REAL,
      createEngine: async () =>
        handleOf({
          exec: () => Promise.reject(new EngineTimeoutError(5_000)),
          query: () => Promise.reject(new EngineTimeoutError(5_000)),
          transaction: () => Promise.reject(new EngineTimeoutError(5_000)),
          close: async () => undefined,
        }),
    };
    expect(await runLab(leaky(), ports)).toMatchObject({ kind: "failed", reason: "engine" });
  });
});

describe("introspectLab", () => {
  it("returns the catalog and the static findings without running a probe", async () => {
    const outcome = await introspectLab(leaky(), REAL);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") {
      return;
    }
    expect(outcome.catalog.tables.map((table) => table.name)).toEqual([
      "invoices",
      "projects",
      "tenants",
    ]);
    expect(outcome.findings.map((finding) => finding.id)).toEqual(["RLS003", "RLS004"]);
  });

  it("reports a setup error and a cancelled introspection", async () => {
    const broken = withSql(leaky(), "schema", "create table (");
    expect(await introspectLab(broken, REAL)).toMatchObject({
      kind: "setup-error",
      error: { phase: "schema", sqlState: "42601" },
    });
    expect(await introspectLab(leaky(), REAL, { signal: AbortSignal.abort() })).toEqual({
      kind: "cancelled",
    });
  });

  it("stops a stuck introspection when the user cancels, and refuses further calls", async () => {
    const controller = new AbortController();
    const stuckOn = "select pg_sleep(60)";
    const scenario = withSql(leaky(), "seed", `${stuckOn};`);
    const calls: string[] = [];
    const stuck = Promise.withResolvers<void>();
    const ports: LabRunPorts = {
      ...REAL,
      createEngine: async () => {
        const handle = stuckEngine(
          await realEngine(),
          stuckOn,
          () => new EngineTerminatedError("terminated"),
          stuck.resolve,
        );
        return {
          ...handle,
          engine: {
            ...handle.engine,
            exec: (sql) => {
              calls.push(sql);
              return handle.engine.exec(sql);
            },
          },
        };
      },
    };
    const pending = introspectLab(scenario, ports, { signal: controller.signal });
    await stuck.promise;
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(calls.at(-1)).toBe(stuckOn);
  });
});
