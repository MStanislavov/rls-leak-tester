/**
 * GitHub sign-in through Supabase Auth, server half: `GET /auth/callback` exchanges the OAuth
 * code (PKCE; the verifier sits in a cookie the browser client wrote) for a session, and
 * `POST /auth/signout` ends it. Both answer with a redirect, and the target of that redirect is
 * the classic hole: `next` comes from the URL, so it is resolved against the site's own origin
 * and refused unless it stays there (no open redirect).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { AUTH_ERROR_CODES, AUTH_ERROR_PARAM, type AuthErrorCode } from "../auth-errors";
import { isCrossSiteRequest } from "./http";

export const AUTH_CALLBACK_PATH = "/auth/callback";
export const AUTH_SIGNOUT_PATH = "/auth/signout";
/** Where a sign-in lands when `next` is missing or refused. */
export const DEFAULT_AFTER_SIGN_IN = "/lab";
export const DEFAULT_AFTER_SIGN_OUT = "/";
export { AUTH_ERROR_CODES, AUTH_ERROR_PARAM, type AuthErrorCode };
export const authErrorSchema = z.enum(AUTH_ERROR_CODES);

const nextSchema = z.string().min(1).max(2048);
const codeSchema = z.string().min(1).max(1024);

/**
 * Pure. The absolute URL to redirect to: `next` resolved against `siteOrigin`, accepted only
 * when the result is still on that origin; otherwise `fallback` on that origin. `//host`,
 * `/\host`, `https://host`, a tab inside the slashes, `javascript:` and user-info tricks all
 * resolve to another origin (or to `null`) and fall back. The answer is always built from the
 * parsed URL, never from the raw text.
 */
export function safeRedirectUrl(next: unknown, siteOrigin: string, fallback: string): URL {
  const base = new URL(siteOrigin);
  const fallbackUrl = new URL(fallback, base.origin);
  const parsed = nextSchema.safeParse(next);
  if (!parsed.success || !parsed.data.startsWith("/")) return fallbackUrl;
  let target: URL;
  try {
    target = new URL(parsed.data, base.origin);
  } catch {
    return fallbackUrl;
  }
  if (target.origin !== base.origin) return fallbackUrl;
  if (target.pathname.startsWith("//") || target.pathname.startsWith(AUTH_CALLBACK_PATH)) {
    return fallbackUrl;
  }
  target.username = "";
  target.password = "";
  return target;
}

function redirect(target: URL, status: 302 | 303): Response {
  return new Response(null, {
    status,
    headers: { Location: target.href, "Cache-Control": "no-store" },
  });
}

export interface AuthRouteDeps {
  /** The request's Supabase client, or `undefined` when Supabase is not configured. */
  readonly supabase: SupabaseClient | undefined;
  /** `NEXT_PUBLIC_SITE_URL` when set; otherwise the origin of the request is used. */
  readonly siteUrl: string | undefined;
}

/** `GET /auth/callback?code=...&next=/lab` */
export async function handleAuthCallback(request: Request, deps: AuthRouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const query = z
    .object({
      code: codeSchema.optional(),
      // zod 4: a bare `z.unknown()` key is REQUIRED; a callback without `next` is normal.
      next: z.unknown().optional(),
      error: z.string().max(200).optional(),
    })
    .safeParse(Object.fromEntries(url.searchParams));
  const origin = deps.siteUrl ?? url.origin;
  const target = safeRedirectUrl(
    query.success ? query.data.next : undefined,
    origin,
    DEFAULT_AFTER_SIGN_IN,
  );
  const fail = (code: AuthErrorCode): Response => {
    target.searchParams.set(AUTH_ERROR_PARAM, code);
    return redirect(target, 302);
  };

  if (deps.supabase === undefined) return fail("not_configured");
  if (query.success && query.data.error !== undefined) return fail("provider_error");
  if (!query.success || query.data.code === undefined) return fail("missing_code");

  try {
    const { error } = await deps.supabase.auth.exchangeCodeForSession(query.data.code);
    if (error !== null) return fail("exchange_failed");
  } catch {
    return fail("exchange_failed");
  }
  target.searchParams.delete(AUTH_ERROR_PARAM);
  return redirect(target, 302);
}

/** `POST /auth/signout`: a form target. A cross-site post is ignored (and changes nothing). */
export async function handleSignOut(request: Request, deps: AuthRouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const target = safeRedirectUrl(
    url.searchParams.get("next"),
    deps.siteUrl ?? url.origin,
    DEFAULT_AFTER_SIGN_OUT,
  );
  if (deps.supabase !== undefined && !isCrossSiteRequest(request.headers)) {
    try {
      await deps.supabase.auth.signOut({ scope: "local" });
    } catch {
      // auth-js removes the local session (the cookies) even when the revocation call fails.
    }
  }
  return redirect(target, 303);
}
