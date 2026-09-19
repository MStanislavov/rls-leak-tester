/**
 * Typed client for the PGlite worker, with a timeout on every request.
 *
 * A query that runs inside WASM cannot be cancelled from outside, so the only
 * reliable way to stop one is to terminate the worker. On timeout the client
 * does exactly that, rejects everything that was in flight, and creates a new
 * worker lazily on the next request. The database is in memory: **a new worker
 * is an empty database**, so the caller has to replay its schema and seed.
 *
 * This module has no DOM or bundler dependency; the worker is injected through
 * a factory (see `create-worker.ts` for the real one).
 */
import {
  isWorkerResponse,
  type InitResult,
  type SqlErrorInfo,
  type SqlResultSet,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";

/** The part of the DOM `Worker` the client uses. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
}

export type WorkerFactory = () => WorkerLike;

export interface WorkerClientOptions {
  /** Timeout for `exec`. The brief asks for about five seconds per probe. */
  readonly execTimeoutMs?: number;
  /** Timeout for `init`, which downloads and boots Postgres on a cold start. */
  readonly initTimeoutMs?: number;
}

export const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
export const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/** The request did not finish in time; the worker was terminated. */
export class WorkerTimeoutError extends Error {
  override readonly name = "WorkerTimeoutError";
  constructor(readonly timeoutMs: number) {
    super(`The database worker did not answer within ${timeoutMs} ms and was terminated`);
  }
}

/** The worker went away (timeout of another request, crash or `dispose`). */
export class WorkerTerminatedError extends Error {
  override readonly name = "WorkerTerminatedError";
}

/** Postgres, or the worker, reported an error. `code` is the SQLSTATE if any. */
export class SqlExecutionError extends Error {
  override readonly name = "SqlExecutionError";
  readonly code: string | null;
  readonly detail: string | null;
  readonly hint: string | null;
  readonly position: string | null;
  constructor(info: SqlErrorInfo) {
    super(info.message);
    this.code = info.code;
    this.detail = info.detail;
    this.hint = info.hint;
    this.position = info.position;
  }
}

interface Pending {
  readonly resolve: (response: WorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class PgliteWorkerClient {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private workersCreated = 0;
  private readonly execTimeoutMs: number;
  private readonly initTimeoutMs: number;

  constructor(
    private readonly createWorker: WorkerFactory,
    options: WorkerClientOptions = {},
  ) {
    this.execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  }

  /** How many workers this client has started. It grows by one after every timeout. */
  get generation(): number {
    return this.workersCreated;
  }

  /** `true` while a worker exists. `false` before first use and after a timeout. */
  get alive(): boolean {
    return this.worker !== null;
  }

  /** Starts the worker and Postgres if needed and reports version and start-up time. */
  async init(timeoutMs: number = this.initTimeoutMs): Promise<InitResult> {
    const response = await this.request({ type: "init" }, timeoutMs);
    if (response.ok && response.type === "init") {
      return response.result;
    }
    throw PgliteWorkerClient.failure(response);
  }

  /** Runs one or more statements and returns one result set per statement. */
  async exec(
    sql: string,
    timeoutMs: number = this.execTimeoutMs,
  ): Promise<readonly SqlResultSet[]> {
    const response = await this.request({ type: "exec", sql }, timeoutMs);
    if (response.ok && response.type === "exec") {
      return response.results;
    }
    throw PgliteWorkerClient.failure(response);
  }

  /** Terminates the worker. The client stays usable; the next request starts a new one. */
  dispose(): void {
    this.terminate(new WorkerTerminatedError("The database worker was disposed"));
  }

  private static failure(response: WorkerResponse): Error {
    return response.ok
      ? new WorkerTerminatedError("The database worker sent a response of the wrong type")
      : new SqlExecutionError(response.error);
  }

  private request(
    message: DistributiveOmit<WorkerRequest, "id">,
    timeoutMs: number,
  ): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      const worker = this.ensureWorker();
      const id = this.nextId++;
      const timer = setTimeout(() => {
        const timedOut = this.pending.get(id);
        this.pending.delete(id);
        this.terminate(
          new WorkerTerminatedError("The database worker was terminated by another timeout"),
        );
        timedOut?.reject(new WorkerTimeoutError(timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...message, id } as WorkerRequest);
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) {
      return this.worker;
    }
    const worker = this.createWorker();
    this.workersCreated += 1;
    worker.addEventListener("message", (event) => {
      // A message from a worker that was already replaced is ignored.
      if (this.worker !== worker || !isWorkerResponse(event.data)) {
        return;
      }
      const entry = this.pending.get(event.data.id);
      if (!entry) {
        return;
      }
      this.pending.delete(event.data.id);
      clearTimeout(entry.timer);
      entry.resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      if (this.worker !== worker) {
        return;
      }
      this.terminate(
        new WorkerTerminatedError(`The database worker crashed: ${event.message ?? "unknown"}`),
      );
    });
    this.worker = worker;
    return worker;
  }

  private terminate(reason: Error): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const entry of inFlight) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
  }
}
