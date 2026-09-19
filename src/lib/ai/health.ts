/**
 * The body of `GET /api/health` (brief 4.6): the build id and which optional features are
 * configured, as booleans. It is built field by field from the feature flags, so no value of the
 * configuration (a key, a URL, a model id) can end up in it.
 */
import type { ServerConfig } from "@/lib/config/server";

export interface HealthReport {
  readonly status: "ok";
  readonly buildId: string;
  readonly features: {
    readonly explain: boolean;
    readonly redis: boolean;
    readonly supabase: boolean;
  };
}

/** Pure. */
export function buildHealthReport(
  config: Pick<ServerConfig, "buildId" | "features">,
): HealthReport {
  return {
    status: "ok",
    buildId: config.buildId,
    features: {
      explain: config.features.explainEnabled,
      redis: config.features.redisEnabled,
      supabase: config.features.supabaseEnabled,
    },
  };
}
