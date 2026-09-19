/**
 * Next.js 16 proxy (the file convention that replaced `middleware.ts`).
 *
 * Generates a nonce per request and sets the document Content-Security-Policy
 * on the request (so the App Router stamps the nonce on its own scripts) and on
 * the response. Pages must render dynamically for the nonce to reach the HTML;
 * the root layout (`src/app/layout.tsx`) awaits `connection()` for that reason,
 * which covers every route and the 404 page. `npm run e2e` fails if it stops.
 *
 * The request-independent headers and the policy for `/_next/static/*` come
 * from `next.config.ts`, which covers the paths this proxy skips.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isDevelopment } from "@/lib/config/runtime";
import { buildDocumentCsp, CSP_HEADER, generateNonce } from "@/lib/security/csp";

// Rule ARCH-002: only src/lib/config reads the environment. NODE_ENV is inlined at build time.
const isDev = isDevelopment();

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const policy = buildDocumentCsp({ nonce, isDev });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(CSP_HEADER, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, policy);
  return response;
}

export const config = {
  // Everything except the immutable build output, which next.config.ts covers.
  matcher: ["/((?!_next/static).*)"],
};
