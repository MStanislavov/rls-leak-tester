/**
 * The probe executor: the ONE place where a probe meets the database (RUN-001, P5).
 *
 * Every probe transaction is: BEGIN, `set_config('role', <dbRole>, true)`,
 * `set_config('request.jwt.claims', <claims>, true)`, the pinned settings (`identityProbes`), an
 * identity check, the probe, ROLLBACK. The rollback is unconditional (`finally`), so the database
 * is unchanged after a run.
 *
 * The identity check is the guard inside the executor: before the first probe statement it asks
 * Postgres `select current_user` and refuses to go on unless the answer is the persona's role and
 * `row_security` is `on`. The engine's session user is a superuser, which row level security never
 * restricts, so a probe that ran without the switch would report every leaky scenario wrongly;
 * and under `row_security = off` (the header of every pg_dump file) a filtered statement raises
 * 42501 instead of running. With the check such a regression turns every cell `inconclusive` and
 * the verdict NOT PROVEN, instead of lying.
 *
 * A session offers three ways to run a statement:
 *
 * - `run`: as the persona. A Postgres error aborts the transaction and is thrown.
 * - `attempt`: as the persona, inside a savepoint that is always rolled back. A Postgres error is
 *   returned, not thrown, and the transaction stays usable: the per-row fallback. With `readBack`
 *   a statement that went through is followed, still inside the savepoint, by a superuser read.
 * - `asSuperuser`: RESET ROLE, run, switch back, check the identity again. For reading back what
 *   a statement did (the WHERE-less shapes) and for preparing the source row. Never for a probe.
 *   A Postgres error in it is the runner's, never the persona's: it is rethrown WITHOUT its
 *   SQLSTATE (`SuperuserStepError`), so it can never be read as "blocked".
 *
 * The transcript lists every statement that was sent, literals inlined, in order. It is what a
 * cell records as "the exact probe SQL": it cannot drift from what ran, because it is what ran.
 *
 * `executeAsPersona` never throws. A lost database (timeout, terminated worker) comes back as
 * `databaseLost: true`; the caller must rebuild the database before the next probe.
 */
import { isDatabaseLost, toProbeFailure } from "./classify";
import {
  identityProbes,
  RESET_ROLE_PROBE,
  WHOAMI_PROBE,
  staticProbe,
  type Probe,
  type ProbeIdentity,
} from "./probes";
import type { ProbeFailure } from "./result";
import { SqlError, type SqlEngine, type SqlQueryResult, type SqlTransaction } from "./types";

export type Attempt =
  | {
      readonly ok: true;
      readonly result: SqlQueryResult;
      /** The superuser's read inside the savepoint; `null` when none was asked for. */
      readonly readBack: SqlQueryResult | null;
    }
  | { readonly ok: false; readonly failure: ProbeFailure };

export interface PersonaSession {
  run(probe: Probe): Promise<SqlQueryResult>;
  attempt(probe: Probe, readBack?: Probe): Promise<Attempt>;
  /** Runs the statements in order as the superuser and returns the result of the LAST one. */
  asSuperuser(probe: Probe, ...more: readonly Probe[]): Promise<SqlQueryResult>;
}

export type PersonaRun<T> =
  | { readonly ok: true; readonly value: T; readonly sql: string }
  | {
      readonly ok: false;
      readonly failure: ProbeFailure;
      readonly databaseLost: boolean;
      readonly sql: string;
    };

/** Runs `work` in one probe transaction under `identity`. */
export type ProbeExecutor = <T>(
  engine: SqlEngine,
  identity: ProbeIdentity,
  work: (session: PersonaSession) => Promise<T>,
) => Promise<PersonaRun<T>>;

/**
 * Seams for the bypass-guard tests, which prove that a broken executor is caught. Production code
 * never passes them.
 */
export interface ProbeExecutorOptions {
  /** Replaces the statements that switch role and claims. */
  readonly switchIdentity?: (identity: ProbeIdentity) => readonly Probe[];
  /** `false` removes the `current_user` check. */
  readonly verifyIdentity?: boolean;
}

/** The session is not the persona: the probe must not run. */
export class IdentityError extends Error {
  override readonly name = "IdentityError";
}

/** A statement of the runner's own superuser part failed. Deliberately not a `SqlError`. */
export class SuperuserStepError extends Error {
  override readonly name = "SuperuserStepError";
}

const SAVEPOINT = "rls_probe";
const SAVEPOINT_PROBE = staticProbe(`savepoint ${SAVEPOINT}`);
const ROLLBACK_TO_PROBE = staticProbe(`rollback to savepoint ${SAVEPOINT}`);
const RELEASE_PROBE = staticProbe(`release savepoint ${SAVEPOINT}`);

class Session implements PersonaSession {
  readonly transcript: string[] = ["begin"];

  constructor(
    private readonly tx: SqlTransaction,
    private readonly identity: ProbeIdentity,
    private readonly options: ProbeExecutorOptions,
  ) {}

  private async send(probe: Probe): Promise<SqlQueryResult> {
    this.transcript.push(probe.inlined);
    return this.tx.query(probe.sql, probe.params);
  }

  /** Switches to the persona and proves it. Called before any probe statement. */
  async becomePersona(): Promise<void> {
    const switchIdentity = this.options.switchIdentity ?? identityProbes;
    for (const probe of switchIdentity(this.identity)) {
      await this.send(probe);
    }
    if (this.options.verifyIdentity === false) {
      return;
    }
    const { rows } = await this.send(WHOAMI_PROBE);
    const role = rows[0]?.role;
    if (role !== this.identity.role) {
      throw new IdentityError(
        `The probe would have run as "${String(role)}" instead of "${this.identity.role}": the role switch did not take effect. Nothing was probed.`,
      );
    }
    const rowSecurity = rows[0]?.row_security;
    if (rowSecurity !== "on") {
      throw new IdentityError(
        `The probe would have run with row_security = ${String(rowSecurity)}: a statement that a policy filters would raise an error instead of running. Nothing was probed.`,
      );
    }
  }

  run(probe: Probe): Promise<SqlQueryResult> {
    return this.send(probe);
  }

  async attempt(probe: Probe, readBack?: Probe): Promise<Attempt> {
    await this.send(SAVEPOINT_PROBE);
    let attempt: Attempt;
    try {
      const result = await this.send(probe);
      attempt = {
        ok: true,
        result,
        readBack: readBack === undefined ? null : await this.asSuperuser(readBack),
      };
    } catch (error) {
      if (!(error instanceof SqlError)) {
        throw error;
      }
      attempt = { ok: false, failure: toProbeFailure(error) };
    }
    await this.send(ROLLBACK_TO_PROBE);
    await this.send(RELEASE_PROBE);
    return attempt;
  }

  async asSuperuser(probe: Probe, ...more: readonly Probe[]): Promise<SqlQueryResult> {
    await this.send(RESET_ROLE_PROBE);
    let result: SqlQueryResult;
    try {
      result = await this.send(probe);
      for (const next of more) {
        result = await this.send(next);
      }
    } catch (error) {
      // The transaction is aborted, so nothing can run as the superuser after it.
      if (error instanceof SqlError) {
        throw new SuperuserStepError(
          `A statement the runner sends as the superuser failed: [${error.code}] ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    await this.becomePersona();
    return result;
  }

  script(): string {
    return [...this.transcript, "rollback"].map((line) => `${line};`).join("\n");
  }
}

export function createProbeExecutor(options: ProbeExecutorOptions = {}): ProbeExecutor {
  return async (engine, identity, work) => {
    const open: { session?: Session } = {};
    const script = (): string => open.session?.script() ?? "";
    try {
      const value = await engine.transaction(async (tx) => {
        const session = new Session(tx, identity, options);
        open.session = session;
        try {
          await session.becomePersona();
          return await work(session);
        } finally {
          await tx.rollback();
        }
      });
      return { ok: true, value, sql: script() };
    } catch (error) {
      return {
        ok: false,
        failure: toProbeFailure(error),
        databaseLost: isDatabaseLost(error),
        sql: script(),
      };
    }
  };
}

/** The executor every run uses. */
export const executeAsPersona: ProbeExecutor = createProbeExecutor();
