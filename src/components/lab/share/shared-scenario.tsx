"use client";

/**
 * The browser half of `/s/[slug]`: the lab, read-only, around a scenario somebody shared, or the
 * reason why there is none. Loaded with `ssr: false` (see `src/app/s/[slug]`), like the lab.
 *
 * The scenario's SQL runs where every scenario runs: in the PGlite worker of this tab (brief
 * 4.7). Its text is only ever rendered as text nodes (SEC-001).
 */
// Keep this import FIRST: it must run before any module below builds a zod schema (see the file).
import "@/lib/lab/zod-csp";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { OWN_SHARED_SQL_NOTICE, SHARED_SQL_NOTICE } from "@/lib/lab/share";
import {
  canRetryShared,
  initialSharedView,
  loadSharedInBrowser,
  SHARED_FAILURE_TEXT,
  type SharedFailure,
  type SharedServerResult,
  type SharedViewState,
} from "@/lib/lab/share-page";
import { createRemoteScenarioStore, type StoredScenario } from "@/lib/store";
import type { LabCellDrawerExtension, LabToolbarExtension } from "../lab-extensions";
import { ForkToLab } from "./fork-to-lab";
import { sharingEnabled } from "./use-sharing-availability";

function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-2 px-4 py-6 sm:px-6">
      <h1 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Shared scenario
      </h1>
      <p data-testid="shared-loading" role="status" className="text-sm text-muted-foreground">
        Loading the shared scenario
      </p>
    </main>
  );
}

const LabWorkbench = dynamic(
  () => import("../lab-workbench").then((module) => module.LabWorkbench),
  { ssr: false, loading: Loading },
);

/** The shared page offers the fork and nothing that edits, explains or exports. */
const SHARED_TOOLBAR: readonly LabToolbarExtension[] = [ForkToLab];
const SHARED_CELL_DRAWER: readonly LabCellDrawerExtension[] = [];

function SharedNotice({ stored }: { readonly stored: StoredScenario }) {
  return (
    <p
      role="note"
      data-testid="shared-notice"
      data-owned={stored.ownedByMe}
      className="flex items-start gap-2 rounded-md border bg-muted p-3 text-sm"
    >
      <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        {stored.ownedByMe ? OWN_SHARED_SQL_NOTICE : SHARED_SQL_NOTICE} It is read-only here:{" "}
        <span className="font-medium">Fork to my lab</span> gives you a copy you can edit.
      </span>
    </p>
  );
}

function Failure({
  reason,
  onRetry,
}: {
  readonly reason: SharedFailure;
  readonly onRetry: (() => void) | null;
}) {
  const text = SHARED_FAILURE_TEXT[reason];
  return (
    <main
      data-testid="shared-failure"
      data-reason={reason}
      className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center gap-4 px-4 py-24 sm:px-6"
    >
      <h1 className="text-2xl font-semibold tracking-tight">{text.title}</h1>
      <p className="text-muted-foreground">{text.body}</p>
      <div className="flex flex-wrap gap-3">
        {onRetry === null ? null : (
          <Button type="button" data-testid="shared-retry" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href="/lab" prefetch={false}>
            Open the lab
          </Link>
        </Button>
      </div>
    </main>
  );
}

export interface SharedScenarioProps {
  /** Validated by the Server Component (`parseScenarioSlugParams`). */
  readonly slug: string;
  readonly initial: SharedServerResult;
}

export function SharedScenario({ slug, initial }: SharedScenarioProps) {
  const [view, setView] = useState<SharedViewState>(() => initialSharedView(initial));

  const load = useCallback(() => {
    setView({ phase: "loading" });
    void loadSharedInBrowser(slug, { sharingEnabled, store: createRemoteScenarioStore() }).then(
      setView,
    );
  }, [slug]);

  // The server found no Supabase configuration. `/api/health` is the deployment's own word on
  // that; only when it says otherwise is the API asked.
  const serverUnconfigured = initial.status === "not_configured";
  useEffect(() => {
    if (!serverUnconfigured) {
      return;
    }
    let active = true;
    void sharingEnabled().then((enabled) => {
      if (active && enabled) {
        load();
      }
    });
    return () => {
      active = false;
    };
  }, [serverUnconfigured, load]);

  if (view.phase === "loading") {
    return <Loading />;
  }
  if (view.phase === "failed") {
    return <Failure reason={view.reason} onRetry={canRetryShared(view) ? load : null} />;
  }
  return (
    <LabWorkbench
      key={view.stored.id}
      entry={{ kind: "blank" }}
      shared={{
        scenario: view.stored.scenario,
        notice: <SharedNotice stored={view.stored} />,
      }}
      toolbarExtensions={SHARED_TOOLBAR}
      cellDrawerExtensions={SHARED_CELL_DRAWER}
    />
  );
}
