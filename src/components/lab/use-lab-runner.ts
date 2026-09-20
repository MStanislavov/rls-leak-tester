"use client";

import { useCallback, useEffect, useMemo, useRef, type Dispatch } from "react";
import {
  introspectLab,
  runLab,
  type LabAction,
  type LabRunOptions,
  type LabRunOutcome,
} from "@/lib/lab";
import type { Scenario } from "@/lib/scenario";
import { loadLabPorts } from "./lab-engine";

export interface LabRunner {
  /** Runs the matrix for `scenario` (already validated) and reports into the lab's state. */
  run(scenario: Scenario): void;
  /** Setup and catalog only: fills the Tables panel and the static findings. */
  introspect(scenario: Scenario): void;
  /** Stops the run or introspection in flight: aborts and terminates its worker. */
  cancel(): void;
  /**
   * A run of its own, on its own worker, that does not touch the lab's state: what a
   * verified-fix loop uses to re-test a copy of the scenario.
   */
  runIsolated(scenario: Scenario, options?: LabRunOptions): Promise<LabRunOutcome>;
}

function engineFailure(error: unknown): LabRunOutcome & { kind: "failed" } {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    kind: "failed",
    reason: "engine",
    message: `The database engine could not be loaded: ${detail}`,
  };
}

export function useLabRunner(dispatch: Dispatch<LabAction>): LabRunner {
  const inFlight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );

  const run = useCallback(
    (scenario: Scenario) => {
      if (inFlight.current !== null) {
        return;
      }
      const controller = new AbortController();
      inFlight.current = controller;
      dispatch({ type: "run/start", purpose: "run" });

      // At most one progress update per frame: a large matrix finishes hundreds of cells a second.
      let latest: { done: number; total: number } | null = null;
      let frame: number | null = null;
      const onProgress = (progress: { done: number; total: number }): void => {
        latest = { done: progress.done, total: progress.total };
        frame ??= requestAnimationFrame(() => {
          frame = null;
          if (latest !== null && inFlight.current === controller) {
            dispatch({ type: "run/progress", ...latest });
          }
        });
      };

      void loadLabPorts()
        .then((ports) => runLab(scenario, ports, { signal: controller.signal, onProgress }))
        .catch(engineFailure)
        .then((outcome) => {
          if (frame !== null) {
            cancelAnimationFrame(frame);
          }
          if (inFlight.current === controller) {
            inFlight.current = null;
            dispatch({ type: "run/finished", outcome });
          }
        });
    },
    [dispatch],
  );

  const introspect = useCallback(
    (scenario: Scenario) => {
      if (inFlight.current !== null) {
        return;
      }
      const controller = new AbortController();
      inFlight.current = controller;
      dispatch({ type: "run/start", purpose: "introspect" });
      void loadLabPorts()
        .then((ports) => introspectLab(scenario, ports, { signal: controller.signal }))
        .catch(engineFailure)
        .then((outcome) => {
          if (inFlight.current === controller) {
            inFlight.current = null;
            dispatch({ type: "introspect/finished", outcome });
          }
        });
    },
    [dispatch],
  );

  const cancel = useCallback(() => {
    inFlight.current?.abort();
  }, []);

  const runIsolated = useCallback(
    (scenario: Scenario, options?: LabRunOptions) =>
      loadLabPorts()
        .then((ports) => runLab(scenario, ports, options))
        .catch(engineFailure),
    [],
  );

  return useMemo(
    () => ({ run, introspect, cancel, runIsolated }),
    [run, introspect, cancel, runIsolated],
  );
}
