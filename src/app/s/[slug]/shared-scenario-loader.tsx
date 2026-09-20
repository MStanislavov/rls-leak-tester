"use client";

/**
 * `ssr: false` is only allowed inside a Client Component in Next.js 16, hence this wrapper (the
 * same shape as `src/app/lab/lab-loader.tsx`). It keeps the lab, zod's browser configuration and
 * the store client out of the server render of `/s/[slug]`.
 */
import dynamic from "next/dynamic";
import type { SharedScenarioProps } from "@/components/lab/share/shared-scenario";

const SharedScenario = dynamic(
  () => import("@/components/lab/share/shared-scenario").then((module) => module.SharedScenario),
  {
    ssr: false,
    loading: () => (
      <main className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-2 px-4 py-6 sm:px-6">
        <h1 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Shared scenario
        </h1>
        <p data-testid="shared-loading" role="status" className="text-sm text-muted-foreground">
          Loading the shared scenario
        </p>
      </main>
    ),
  },
);

export function SharedScenarioLoader(props: SharedScenarioProps) {
  return <SharedScenario {...props} />;
}
