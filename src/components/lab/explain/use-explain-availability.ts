"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchExplainAvailability, type ExplainAvailability } from "@/lib/lab/explain-health";

/**
 * One `GET /api/health` per page, shared by every drawer that opens: the answer does not change
 * while the page lives. An `unknown` answer is not kept, so "Check again" asks once more.
 */
let shared: Promise<ExplainAvailability> | null = null;

function loadAvailability(): Promise<ExplainAvailability> {
  shared ??= fetchExplainAvailability().then((availability) => {
    if (availability === "unknown") {
      shared = null;
    }
    return availability;
  });
  return shared;
}

export interface ExplainAvailabilityState {
  readonly availability: ExplainAvailability | "checking";
  /** Asks the health endpoint again; only useful after `unknown`. */
  readonly recheck: () => void;
}

export function useExplainAvailability(): ExplainAvailabilityState {
  const [availability, setAvailability] = useState<ExplainAvailability | "checking">("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void loadAvailability().then((next) => {
      if (live) {
        setAvailability(next);
      }
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  const recheck = useCallback(() => {
    setAvailability("checking");
    setAttempt((count) => count + 1);
  }, []);

  return { availability, recheck };
}
