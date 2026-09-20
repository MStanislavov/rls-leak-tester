/**
 * `GET /api/scenarios/by-slug/[slug]`: a shared scenario by its exact slug (public, unlisted,
 * or the caller's own), read through the short-lived cache. No session needed. Thin by rule
 * (ARCH-003); Node.js runtime because of Redis (REDIS-002).
 */
import { handleGetScenarioBySlug, parseScenarioSlugParams } from "@/lib/store/server";
import { getScenarioApiDeps } from "@/lib/store/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/scenarios/by-slug/[slug]">,
): Promise<Response> {
  const slug = parseScenarioSlugParams(await context.params);
  return handleGetScenarioBySlug(request, slug, await getScenarioApiDeps());
}
