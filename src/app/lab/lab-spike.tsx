"use client";

/**
 * Spike B surface: starts PGlite in a Web Worker, proves RLS works there and
 * shows the timeout-and-recover path. Loaded only through `lab-loader.tsx`
 * (`ssr: false`), so neither this module nor the worker is part of any other
 * page. Every value is rendered as a text node.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SqlExecutionError,
  WorkerTimeoutError,
  type PgliteWorkerClient,
} from "@/lib/engine/worker/client";
import { createPgliteWorkerClient } from "@/lib/engine/worker/create-worker";
import {
  createMarkerTable,
  markerTablePresent,
  MARKER_TABLE,
  runRlsProof,
  SLOW_SQL,
  type RlsProof,
} from "./rls-proof";

/** Deliberately short so the slow query below is cut off quickly. */
const SLOW_QUERY_TIMEOUT_MS = 1_500;

type ProofState =
  | { readonly status: "starting" }
  | {
      readonly status: "done";
      readonly proof: RlsProof;
      readonly version: string;
      readonly workerStartupMs: number;
      readonly totalMs: number;
    }
  | { readonly status: "error"; readonly message: string; readonly code: string | null };

type SlowState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "timed-out"; readonly afterMs: number }
  | { readonly status: "finished" }
  | { readonly status: "error"; readonly message: string };

/**
 * Whether the marker table exists in the database that answered last. "unknown" until a database
 * has answered, and again after a timeout, because the worker that held the answer is gone.
 */
type MarkerState = "unknown" | "present" | "absent";

function describeError(error: unknown): { message: string; code: string | null } {
  if (error instanceof SqlExecutionError) {
    return { message: error.message, code: error.code };
  }
  return { message: error instanceof Error ? error.message : String(error), code: null };
}

function markerText(marker: MarkerState): string {
  switch (marker) {
    case "unknown":
      return "not checked yet";
    case "present":
      return "present";
    case "absent":
      return "absent";
  }
}

function slowStatusText(slow: SlowState): string {
  switch (slow.status) {
    case "idle":
      return "Not started";
    case "running":
      return "Running a query that sleeps for 10 seconds";
    case "timed-out":
      return `Timed out after ${slow.afterMs} ms; the worker was terminated`;
    case "finished":
      return "Finished without a timeout";
    case "error":
      return `Failed: ${slow.message}`;
  }
}

export function LabSpike() {
  const clientRef = useRef<PgliteWorkerClient | null>(null);
  const [proof, setProof] = useState<ProofState>({ status: "starting" });
  const [slow, setSlow] = useState<SlowState>({ status: "idle" });
  const [generation, setGeneration] = useState(0);
  const [runs, setRuns] = useState(0);
  const [marker, setMarker] = useState<MarkerState>("unknown");
  const [markerError, setMarkerError] = useState<string | null>(null);
  const [pings, setPings] = useState(0);

  const getClient = useCallback((): PgliteWorkerClient => {
    clientRef.current ??= createPgliteWorkerClient();
    return clientRef.current;
  }, []);

  const runProof = useCallback(async () => {
    setProof({ status: "starting" });
    const client = getClient();
    const startedAt = performance.now();
    try {
      const init = await client.init();
      const result = await runRlsProof(client);
      const markerPresent = await markerTablePresent(client);
      setMarker(markerPresent ? "present" : "absent");
      setProof({
        status: "done",
        proof: result,
        version: init.version,
        workerStartupMs: init.startupMs,
        totalMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      setProof({ status: "error", ...describeError(error) });
    } finally {
      setGeneration(client.generation);
      setRuns((n) => n + 1);
    }
  }, [getClient]);

  const runSlowQuery = useCallback(async () => {
    setSlow({ status: "running" });
    const client = getClient();
    try {
      await client.exec(SLOW_SQL, SLOW_QUERY_TIMEOUT_MS);
      setSlow({ status: "finished" });
    } catch (error) {
      if (error instanceof WorkerTimeoutError) {
        setSlow({ status: "timed-out", afterMs: error.timeoutMs });
        setMarker("unknown");
      } else {
        setSlow({ status: "error", message: describeError(error).message });
      }
    } finally {
      setGeneration(client.generation);
    }
  }, [getClient]);

  const createMarker = useCallback(async () => {
    setMarkerError(null);
    const client = getClient();
    try {
      setMarker((await createMarkerTable(client)) ? "present" : "absent");
    } catch (error) {
      setMarkerError(describeError(error).message);
    } finally {
      setGeneration(client.generation);
    }
  }, [getClient]);

  useEffect(() => {
    // Deferred by one task so React's development double-mount starts one worker, not two.
    const timer = setTimeout(() => {
      void runProof();
    }, 0);
    return () => {
      clearTimeout(timer);
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, [runProof]);

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="proof-heading" className="flex flex-col gap-3">
        <h2 id="proof-heading" className="text-lg font-medium">
          Row-level security inside the worker
        </h2>
        <p data-testid="lab-status" data-status={proof.status} role="status">
          {proof.status === "starting" && "Starting Postgres in a Web Worker"}
          {proof.status === "done" && "Postgres answered from the worker"}
          {proof.status === "error" && "The worker reported an error"}
        </p>

        {proof.status === "error" && (
          <p data-testid="lab-error" className="text-destructive">
            {proof.code ? `SQLSTATE ${proof.code}: ` : ""}
            {proof.message}
          </p>
        )}

        {proof.status === "done" && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt>Version</dt>
            <dd data-testid="lab-version">{proof.version}</dd>
            <dt>Rows seen by the superuser</dt>
            <dd data-testid="lab-total-rows">{proof.proof.totalRowsAsSuperuser}</dd>
            <dt>Role inside the transaction</dt>
            <dd data-testid="lab-acting-role">{proof.proof.actingRole}</dd>
            <dt>Rows seen by that role as alice</dt>
            <dd data-testid="lab-visible-count">{proof.proof.visibleRows.length}</dd>
            <dt>Postgres start-up inside the worker</dt>
            <dd>
              <span data-testid="lab-worker-startup-ms">{proof.workerStartupMs}</span> ms
            </dd>
            <dt>Start-up and proof, measured on the page</dt>
            <dd>
              <span data-testid="lab-total-ms">{proof.totalMs}</span> ms
            </dd>
          </dl>
        )}

        {proof.status === "done" && (
          <ul data-testid="lab-visible-rows" className="font-mono text-sm">
            {proof.proof.visibleRows.map((row) => (
              <li key={row.id} data-testid="lab-visible-row">
                {row.id} {row.owner} {row.body}
              </li>
            ))}
          </ul>
        )}

        <div>
          <Button
            data-testid="lab-rerun"
            variant="outline"
            disabled={proof.status === "starting"}
            onClick={() => void runProof()}
          >
            Run the proof again
          </Button>
        </div>
      </section>

      <section aria-labelledby="timeout-heading" className="flex flex-col gap-3">
        <h2 id="timeout-heading" className="text-lg font-medium">
          Timeout and recovery
        </h2>
        <p data-testid="slow-status" data-status={slow.status} role="status">
          {slowStatusText(slow)}
        </p>
        <p className="text-sm">
          Workers started so far: <span data-testid="lab-generation">{generation}</span>
        </p>
        <p className="text-sm">
          Proof runs finished so far: <span data-testid="lab-run-count">{runs}</span>
        </p>
        <p className="text-sm">
          Clicks while the query runs: <span data-testid="ping-count">{pings}</span>
        </p>
        <p className="text-sm">
          Table <code>{MARKER_TABLE}</code> in the database that answered last:{" "}
          <span data-testid="lab-marker" data-marker={marker}>
            {markerText(marker)}
          </span>
        </p>
        {markerError !== null && (
          <p data-testid="lab-marker-error" className="text-destructive text-sm">
            {markerError}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="slow-run"
            variant="outline"
            disabled={slow.status === "running" || proof.status === "starting"}
            onClick={() => void runSlowQuery()}
          >
            Run a slow query with a {SLOW_QUERY_TIMEOUT_MS} ms timeout
          </Button>
          <Button
            data-testid="marker-create"
            variant="outline"
            disabled={marker !== "absent" || slow.status === "running"}
            onClick={() => void createMarker()}
          >
            Create the marker table
          </Button>
          <Button
            data-testid="ping-button"
            variant="secondary"
            onClick={() => setPings((n) => n + 1)}
          >
            Count a click
          </Button>
        </div>
      </section>
    </div>
  );
}
