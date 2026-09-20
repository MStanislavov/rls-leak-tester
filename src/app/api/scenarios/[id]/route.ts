/**
 * `GET|PATCH|DELETE /api/scenarios/[id]`: one scenario by its row id. `GET` returns the
 * caller's own scenario or a public one; `PATCH` and `DELETE` are for the owner only. Thin by
 * rule (ARCH-003); Node.js runtime because of Redis (REDIS-002).
 */
import {
  handleDeleteScenario,
  handleGetScenario,
  handleUpdateScenario,
  parseScenarioIdParams,
} from "@/lib/store/server";
import { getScenarioApiDeps } from "@/lib/store/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = RouteContext<"/api/scenarios/[id]">;

export async function GET(request: Request, context: Context): Promise<Response> {
  const id = parseScenarioIdParams(await context.params);
  return handleGetScenario(request, id, await getScenarioApiDeps());
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const id = parseScenarioIdParams(await context.params);
  return handleUpdateScenario(request, id, await getScenarioApiDeps());
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const id = parseScenarioIdParams(await context.params);
  return handleDeleteScenario(request, id, await getScenarioApiDeps());
}
