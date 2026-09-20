/**
 * What the header says after a sign-in that did not work. `GET /auth/callback` redirects back
 * with `?auth_error=<code>`; the query string is chosen by whoever wrote the link, so the code is
 * parsed with the callback's own zod enum (SEC-002) and anything else is ignored.
 */
import { AUTH_ERROR_PARAM, authErrorSchema, type AuthErrorCode } from "@/lib/store/server/auth";

const AUTH_ERROR_TEXT: Readonly<Record<AuthErrorCode, string>> = {
  not_configured: "Sign-in is not set up on this deployment.",
  missing_code: "GitHub did not send a sign-in code. Try signing in again.",
  provider_error: "GitHub reported a problem, or the sign-in was cancelled. Nobody is signed in.",
  exchange_failed: "The sign-in could not be completed. Try signing in again.",
};

/** Pure. `search` is `location.search`. `null` when it carries no known sign-in error. */
export function authErrorMessage(search: string): string | null {
  const code = authErrorSchema.safeParse(new URLSearchParams(search).get(AUTH_ERROR_PARAM));
  return code.success ? AUTH_ERROR_TEXT[code.data] : null;
}

/** Where sign-in comes back to: the page the visitor is on, as a path on this site. */
export function currentReturnPath(location: Pick<Location, "pathname" | "search">): string {
  const search = new URLSearchParams(location.search);
  search.delete(AUTH_ERROR_PARAM);
  const query = search.toString();
  return query === "" ? location.pathname : `${location.pathname}?${query}`;
}
