/**
 * `GET /auth/callback`: the return leg of GitHub sign-in through Supabase Auth. Exchanges the
 * code for a session (cookies) and redirects to `next`, which is validated against the site's
 * own origin in `@/lib/store/server` (no open redirect). Thin by rule (ARCH-003).
 */
import { handleAuthCallback } from "@/lib/store/server";
import { getAuthRouteDeps } from "@/lib/store/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleAuthCallback(request, await getAuthRouteDeps());
}
