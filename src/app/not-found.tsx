import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

/** Rendered per request like every page (the root layout awaits `connection()`), so it hydrates. */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center gap-4 px-4 py-24 sm:px-6">
      <h1 className="font-mono text-5xl font-semibold tracking-tight">404</h1>
      <p className="text-lg font-medium">This page does not exist.</p>
      <p className="text-muted-foreground">
        A shared scenario may have been deleted or made private by its owner. Nothing you have saved
        in this browser is affected.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/">Back to the start page</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/lab" prefetch={false}>
            Open the lab
          </Link>
        </Button>
      </div>
    </main>
  );
}
