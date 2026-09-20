"use client"; // Error boundaries must be Client Components.

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface ErrorPageProps {
  readonly error: Error & { digest?: string };
  /** Next.js 16: re-fetches and re-renders the segment (node_modules/next/dist/docs, error.md). */
  readonly retry: () => void;
}

/**
 * The fallback for an error thrown while a page renders. In production a server error arrives
 * with a generic message and a digest; only the digest is shown, as text, so the owner can match
 * it with the server log. Errors of the user's SQL never come here: the lab shows those next to
 * the statement that caused them.
 */
export default function ErrorPage({ error, retry }: ErrorPageProps) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center gap-4 px-4 py-24 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">
        This page failed to render. Your scenarios are stored in this browser and are not affected.
      </p>
      {error.digest === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          Error reference: <code className="font-mono text-foreground">{error.digest}</code>
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => retry()}>
          <RotateCcw aria-hidden="true" data-icon="inline-start" />
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Back to the start page</Link>
        </Button>
      </div>
    </main>
  );
}
