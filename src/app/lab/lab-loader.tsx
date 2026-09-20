"use client";

/**
 * `ssr: false` is only allowed inside a Client Component in Next.js 16, hence this small wrapper.
 * It keeps the workbench, CodeMirror, PGlite and the worker out of the server render and out of
 * every chunk that another page loads (ADR 0003).
 */
import dynamic from "next/dynamic";
import type { LabEntry } from "@/lib/lab";

const LabWorkbench = dynamic(
  () => import("@/components/lab/lab-workbench").then((module) => module.LabWorkbench),
  {
    ssr: false,
    loading: () => (
      <main className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-2 px-4 py-6 sm:px-6">
        <h1 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Lab</h1>
        <p data-testid="lab-loading" role="status" className="text-sm text-muted-foreground">
          Loading the lab
        </p>
      </main>
    ),
  },
);

export function LabLoader({ entry }: { readonly entry: LabEntry }) {
  return <LabWorkbench entry={entry} />;
}
