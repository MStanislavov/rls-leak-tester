import type { NextConfig } from "next";
import { buildAssetCsp, buildStaticSecurityHeaders, CSP_HEADER } from "./src/lib/security/csp";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Do not remove without re-running `npm run e2e`. With scope hoisting on, Turbopack
    // (Next.js 16.3.5) merges PGlite's dist chunks into one scope and gives the same new
    // name to a module-level binding and to a local variable inside PGlite's initdb code.
    // The local shadows the binding and the production build fails at run time with
    // "instantiateWasm is not a function". `next dev` never hoists, so only production
    // breaks. Details and evidence: docs/adr/0003-spike-b-pglite-next-csp.md.
    turbopackScopeHoisting: false,
  },
  async headers() {
    return [
      {
        // Request-independent security headers, on every path.
        source: "/:path*",
        headers: buildStaticSecurityHeaders({ isDev }),
      },
      {
        // src/proxy.ts skips the build output, so its policy is set here. It is
        // the policy that governs the PGlite worker (see src/lib/security/csp.ts).
        source: "/_next/static/:path*",
        headers: [{ key: CSP_HEADER, value: buildAssetCsp({ isDev }) }],
      },
    ];
  },
};

export default nextConfig;
