/**
 * `POST /auth/signout`: ends the session of this browser and redirects (303) to `next` or `/`.
 * `POST` only, so that a link or an image on another page cannot sign anybody out.
 */
import { handleSignOut } from "@/lib/store/server";
import { getAuthRouteDeps } from "@/lib/store/server/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleSignOut(request, await getAuthRouteDeps());
}
