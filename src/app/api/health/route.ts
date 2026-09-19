/** `GET /api/health`: build id and feature booleans, never values (brief 4.6). */
import { buildHealthReport } from "@/lib/ai/health";
import { getServerConfig } from "@/lib/config/server";

// `@/lib/ai` is imported, so rule REDIS-002 asks for the explicit runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(buildHealthReport(getServerConfig()), {
    headers: { "Cache-Control": "no-store" },
  });
}
