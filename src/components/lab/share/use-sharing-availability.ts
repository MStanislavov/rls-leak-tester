"use client";

/**
 * Is sharing configured on this deployment? The answer comes from `GET /api/health` (booleans
 * only, parsed with zod in `@/lib/lab/share`), asked once per page load however many components
 * want to know. Until the answer is there, and whenever it cannot be read, sharing is off.
 */
import { useEffect, useState } from "react";
import { fetchSharingEnabled } from "@/lib/lab/share";

export type SharingAvailability = "checking" | "enabled" | "disabled";

let pending: Promise<boolean> | undefined;

/** Never rejects. */
export function sharingEnabled(): Promise<boolean> {
  pending ??= fetchSharingEnabled((input, init) => globalThis.fetch(input, init));
  return pending;
}

export function useSharingAvailability(): SharingAvailability {
  const [availability, setAvailability] = useState<SharingAvailability>("checking");

  useEffect(() => {
    let active = true;
    void sharingEnabled().then((enabled) => {
      if (active) {
        setAvailability(enabled ? "enabled" : "disabled");
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return availability;
}
