/**
 * Feature detection for Explain (brief 4.8): `GET /api/health` says which optional features the
 * deployment has, as booleans. The answer is fetched JSON, so it is parsed with zod (SEC-002).
 * Never throws: a deployment whose health endpoint cannot be read is `unknown`, and the lab then
 * says so instead of offering a button that cannot work.
 */
import { z } from "zod";

export const HEALTH_ENDPOINT = "/api/health";

/** The fields this module reads. The route sends more; none of it is a secret. */
const healthSchema = z.object({
  status: z.literal("ok"),
  features: z.object({ explain: z.boolean() }),
});

export type ExplainAvailability = "on" | "off" | "unknown";

export interface ExplainAvailabilityOptions {
  readonly signal?: AbortSignal;
  /** Test seam; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** Pure: reads a parsed health body. */
export function explainAvailabilityOf(body: unknown): ExplainAvailability {
  const parsed = healthSchema.safeParse(body);
  if (!parsed.success) {
    return "unknown";
  }
  return parsed.data.features.explain ? "on" : "off";
}

export async function fetchExplainAvailability(
  options: ExplainAvailabilityOptions = {},
): Promise<ExplainAvailability> {
  const send = options.fetch ?? fetch;
  try {
    const response = await send(HEALTH_ENDPOINT, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: options.signal ?? null,
    });
    if (!response.ok) {
      return "unknown";
    }
    return explainAvailabilityOf(await response.json());
  } catch {
    return "unknown";
  }
}
