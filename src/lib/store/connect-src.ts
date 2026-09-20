/**
 * The `connect-src` additions the optional Supabase store needs, for `src/proxy.ts`. Pure and
 * import-free on purpose: the proxy runs on every request.
 *
 * The browser talks to Supabase for one thing only, the auth endpoints of the browser client
 * (session refresh, sign-out). Scenario data goes through this app's own `/api/scenarios`.
 * `buildDocumentCsp` accepts `https://` origins only, so a local `http://127.0.0.1:54321` stack
 * adds nothing here (sign-in against a local stack then needs the production-like https setup).
 */
export function supabaseConnectSources(supabaseUrl: string | undefined): string[] {
  if (supabaseUrl === undefined) return [];
  try {
    const url = new URL(supabaseUrl);
    return url.protocol === "https:" ? [url.origin] : [];
  } catch {
    return [];
  }
}
