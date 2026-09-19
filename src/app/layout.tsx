import type { Metadata } from "next";
import { connection } from "next/server";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "RLS Leak Tester",
  description:
    "Test whether your Postgres and Supabase row-level security policies actually isolate users and tenants, in your browser, with a CI-ready proof.",
};

/**
 * Async on purpose. The Content-Security-Policy carries a per-request nonce (src/proxy.ts), and
 * Next.js can only stamp that nonce on its inline scripts while it renders for a real request. A
 * prerendered page ships scripts without a nonce, the policy blocks them and the page never
 * hydrates. Awaiting `connection()` here opts every route, including the 404 page, into dynamic
 * rendering. Do not remove it without re-running `npm run e2e`; see
 * docs/adr/0003-spike-b-pglite-next-csp.md.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
