import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { CONTENT_ID, SkipLink } from "@/components/site/skip-link";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { getPublicConfig } from "@/lib/config/public";
import { SITE_DESCRIPTION } from "@/lib/site/links";
import { parseNonce } from "@/lib/site/nonce";
import "./globals.css";

/** A page sets `title: "Docs"` and gets "Docs | RLS Leak Tester". Fonts are local (geist). */
export function generateMetadata(): Metadata {
  const { appName, siteUrl } = getPublicConfig();
  return {
    title: { default: appName, template: `%s | ${appName}` },
    description: SITE_DESCRIPTION,
    applicationName: appName,
    ...(siteUrl === undefined ? {} : { metadataBase: new URL(siteUrl) }),
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdfdfe" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

/**
 * Async on purpose. The Content-Security-Policy carries a per-request nonce (src/proxy.ts), and
 * Next.js can only stamp that nonce on its inline scripts while it renders for a real request. A
 * prerendered page ships scripts without a nonce, the policy blocks them and the page never
 * hydrates. Awaiting `connection()` here opts every route, including the 404 page, into dynamic
 * rendering. Do not remove it without re-running `npm run e2e`; see
 * docs/adr/0003-spike-b-pglite-next-csp.md.
 *
 * The same nonce goes to `next-themes`, whose inline script sets the theme class before first
 * paint. `suppressHydrationWarning` on `<html>` is for that class only.
 *
 * Pages render their own `<main>`; the wrapper with `CONTENT_ID` is the skip link's target.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const nonce = parseNonce((await headers()).get("x-nonce"));
  const { appName } = getPublicConfig();
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider nonce={nonce}>
          <SkipLink />
          <SiteHeader appName={appName} />
          <div id={CONTENT_ID} tabIndex={-1} className="flex flex-1 flex-col outline-none">
            {children}
          </div>
          <SiteFooter />
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
