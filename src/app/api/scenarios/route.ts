/**
 * `GET /api/scenarios` (the caller's own scenarios) and `POST /api/scenarios` (create). Thin by
 * rule (ARCH-003): everything happens in `@/lib/store/server`. Node.js runtime because the
 * Redis client needs TCP (REDIS-002). Without Supabase both answer `503 not_configured`.
 */
import { handleCreateScenario, handleListScenarios } from "@/lib/store/server";
import { getScenarioApiDeps } from "@/lib/store/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleListScenarios(request, await getScenarioApiDeps());
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateScenario(request, await getScenarioApiDeps());
}
