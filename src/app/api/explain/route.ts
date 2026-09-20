/**
 * `POST /api/explain`: thin by rule (ARCH-003). Everything happens in `@/lib/ai/explain`.
 * Node.js runtime because the Redis client needs TCP (REDIS-002). Other methods get the
 * framework's `405`.
 */
import { handleExplain } from "@/lib/ai/explain";
import { createExplainModel } from "@/lib/ai/model";
import { getServerConfig } from "@/lib/config/server";
import { getRedisServices } from "@/lib/redis";
import { resolveRequestUserId } from "@/lib/store/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Seconds. A thinking model plus a follower's wait for the single-flight winner. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const config = getServerConfig();
  const services = getRedisServices(config);
  return handleExplain(request, {
    config,
    model: createExplainModel(config),
    keys: services.keys,
    limiter: services.rateLimiter,
    cache: services.cache,
    lock: services.lock,
    // The per-user limit counts only a user Supabase Auth verified; never a body field.
    resolveUserId: resolveRequestUserId,
  });
}
