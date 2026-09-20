/**
 * The host of a matrix run (ADR 0012, decision 9): it owns what the pure runner leaves to it.
 *
 * - A FRESH engine per run, through the factory it is given. This module never imports an engine
 *   (SEC-004): a `"use client"` module passes `createEngine` and the Supabase SQL in.
 * - Cancel and the run ceiling (`thresholds.runner.run_ceiling_ms`). Both abort the runner's
 *   signal AND terminate the engine, because the signal is only looked at between cells while a
 *   statement inside WASM can only be ended by terminating its worker. `engine.close()` is no
 *   substitute: it queues behind the statement that is running. A stopped engine refuses every
 *   further call, so a half-finished cell does not boot a new worker just to fail.
 * - The static checks, on the catalog of the same setup.
 * - Turning whatever went wrong into data the UI can render as text: a `SetupError` with its
 *   statement and line, a statement of the user's SQL that timed out (found by its text), a
 *   cancelled run, the ceiling, an engine failure.
 */
import { runStaticChecks, type Finding } from "@/lib/checks";
import { runMatrix, type MatrixProgress, type MatrixRun } from "@/lib/runner";
import { introspect, type Catalog } from "@/lib/runner/introspect";
import {
  SetupError,
  exposedSchemasOf,
  setupDatabase,
  type SupabaseSetupSql,
} from "@/lib/runner/setup";
import {
  EngineTerminatedError,
  EngineTimeoutError,
  type SqlEngine,
  type SqlParam,
} from "@/lib/runner/types";
import type { Scenario } from "@/lib/scenario";
import { locateTimedOutStatement, toSetupErrorView, type SetupErrorView } from "./setup-error-view";
import { PROBE_TIMEOUT_MS, RUN_CEILING_MS } from "./thresholds";

export interface LabEngineHandle {
  readonly engine: SqlEngine;
  /**
   * Ends whatever the database is doing right now, without waiting for it: in the browser it
   * terminates the worker. Calls in flight reject with a lost-database error.
   */
  terminate(): void;
}

export interface LabRunPorts {
  /** A fresh, empty database per call. */
  readonly createEngine: () => Promise<LabEngineHandle>;
  readonly supabase: SupabaseSetupSql;
}

export interface LabTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LabRunOptions {
  /** The Cancel button. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MatrixProgress) => void;
  /** Defaults to the run ceiling of rules.yaml. */
  readonly ceilingMs?: number;
  /** The per-statement timeout the engine was created with; only used in messages. */
  readonly probeTimeoutMs?: number;
  /** Test seam; defaults to `setTimeout` / `clearTimeout`. */
  readonly timers?: LabTimers;
}

export type LabFailureReason = "ceiling" | "engine";

interface Stopped {
  readonly kind: "cancelled";
}
interface Failed {
  readonly kind: "failed";
  readonly reason: LabFailureReason;
  readonly message: string;
}
interface SetupFailed {
  readonly kind: "setup-error";
  readonly error: SetupErrorView;
}

export type LabRunOutcome =
  | {
      readonly kind: "done";
      readonly run: MatrixRun;
      readonly findings: readonly Finding[];
    }
  | SetupFailed
  | Stopped
  | Failed;

export type LabIntrospectOutcome =
  | { readonly kind: "done"; readonly catalog: Catalog; readonly findings: readonly Finding[] }
  | SetupFailed
  | Stopped
  | Failed;

const DEFAULT_TIMERS: LabTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

class LabStoppedError extends Error {
  override readonly name = "LabStoppedError";
}

interface LastExec {
  readonly text: string;
  /** How often the same text had been executed before on this engine. */
  readonly occurrence: number;
}

interface GuardedEngine {
  readonly engine: SqlEngine;
  terminate(): void;
  lastExec(): LastExec | null;
}

/** Refuses every call once the run was stopped, and remembers the last script it was given. */
function guardEngine(handle: LabEngineHandle, isStopped: () => boolean): GuardedEngine {
  const inner = handle.engine;
  const executed = new Map<string, number>();
  let last: LastExec | null = null;
  const refuseWhenStopped = (): void => {
    if (isStopped()) {
      throw new EngineTerminatedError("The run was stopped.");
    }
  };
  const engine: SqlEngine = {
    exec: async (sql: string) => {
      refuseWhenStopped();
      const occurrence = executed.get(sql) ?? 0;
      executed.set(sql, occurrence + 1);
      last = { text: sql, occurrence };
      return inner.exec(sql);
    },
    query: async (sql: string, params?: readonly SqlParam[]) => {
      refuseWhenStopped();
      return inner.query(sql, params);
    },
    transaction: async (callback) => {
      refuseWhenStopped();
      return inner.transaction(callback);
    },
    close: () => inner.close(),
  };
  return { engine, terminate: () => handle.terminate(), lastExec: () => last };
}

type StopReason = "cancelled" | "ceiling";

interface Session {
  readonly signal: AbortSignal;
  readonly createEngine: () => Promise<SqlEngine>;
  stopReason(): StopReason | null;
  lastExec(): LastExec | null;
  dispose(): void;
}

/** Cancel, ceiling and the engine factory of one run or one introspection. */
function openSession(ports: LabRunPorts, options: LabRunOptions): Session {
  const timers = options.timers ?? DEFAULT_TIMERS;
  const controller = new AbortController();
  let reason: StopReason | null = null;
  let current: GuardedEngine | null = null;

  const stop = (why: StopReason): void => {
    if (reason !== null) {
      return;
    }
    reason = why;
    controller.abort();
    // Ends the statement that is running inside the worker right now.
    current?.terminate();
  };
  const onCancel = (): void => stop("cancelled");
  if (options.signal?.aborted === true) {
    stop("cancelled");
  }
  options.signal?.addEventListener("abort", onCancel, { once: true });
  const ceiling = timers.set(() => stop("ceiling"), options.ceilingMs ?? RUN_CEILING_MS);

  return {
    signal: controller.signal,
    createEngine: async () => {
      if (reason !== null) {
        throw new LabStoppedError("The run was stopped.");
      }
      const guarded = guardEngine(await ports.createEngine(), () => reason !== null);
      current = guarded;
      if (reason !== null) {
        guarded.terminate();
        await guarded.engine.close().catch(() => undefined);
        throw new LabStoppedError("The run was stopped.");
      }
      return guarded.engine;
    },
    stopReason: () => reason,
    lastExec: () => current?.lastExec() ?? null,
    dispose: () => {
      timers.clear(ceiling);
      options.signal?.removeEventListener("abort", onCancel);
    },
  };
}

function failureOf(
  error: unknown,
  scenario: Scenario,
  session: Session,
  options: LabRunOptions,
): SetupFailed | Stopped | Failed {
  const reason = session.stopReason();
  if (reason === "cancelled") {
    return { kind: "cancelled" };
  }
  if (reason === "ceiling") {
    const seconds = Math.round((options.ceilingMs ?? RUN_CEILING_MS) / 1000);
    return {
      kind: "failed",
      reason: "ceiling",
      message: `The run was stopped after ${seconds} seconds, the ceiling for a whole run. Nothing was proven. Look for a policy, function or trigger that sleeps or loops.`,
    };
  }
  if (error instanceof SetupError) {
    return { kind: "setup-error", error: toSetupErrorView(error) };
  }
  if (error instanceof EngineTimeoutError) {
    const last = session.lastExec();
    const located =
      last === null
        ? null
        : locateTimedOutStatement(
            scenario,
            last.text,
            last.occurrence,
            options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
          );
    if (located !== null) {
      return { kind: "setup-error", error: located };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "failed", reason: "engine", message };
}

/** Runs the matrix and the static checks for `scenario`, which must have passed `parseScenario`. */
export async function runLab(
  scenario: Scenario,
  ports: LabRunPorts,
  options: LabRunOptions = {},
): Promise<LabRunOutcome> {
  const session = openSession(ports, options);
  try {
    const run = await runMatrix(scenario, {
      createEngine: session.createEngine,
      supabase: ports.supabase,
      signal: session.signal,
      onProgress: options.onProgress,
    });
    return { kind: "done", run, findings: runStaticChecks(run.catalog, scenario) };
  } catch (error) {
    return failureOf(error, scenario, session, options);
  } finally {
    session.dispose();
  }
}

/** Setup and catalog only: what the Tables panel and the static checks need, without probes. */
export async function introspectLab(
  scenario: Scenario,
  ports: LabRunPorts,
  options: LabRunOptions = {},
): Promise<LabIntrospectOutcome> {
  const session = openSession(ports, options);
  let engine: SqlEngine | null = null;
  try {
    engine = await session.createEngine();
    await setupDatabase(engine, scenario, ports.supabase);
    const catalog = await introspect(engine, exposedSchemasOf(scenario));
    return { kind: "done", catalog, findings: runStaticChecks(catalog, scenario) };
  } catch (error) {
    return failureOf(error, scenario, session, options);
  } finally {
    session.dispose();
    await engine?.close().catch(() => undefined);
  }
}
