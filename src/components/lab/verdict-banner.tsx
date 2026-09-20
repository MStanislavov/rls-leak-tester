"use client";

import { Ban, CircleX, History, Loader, Play } from "lucide-react";
import { useMemo } from "react";
import {
  STATUS_CLASSES,
  STATUS_ICONS,
  VERDICT_CLASSES,
  VERDICT_ICONS,
} from "@/components/site/status-badge";
import { buildVerdictView, runStatusText, verdictAnnouncement, type RunState } from "@/lib/lab";
import type { MatrixResult, MatrixTimings } from "@/lib/runner";
import { cn } from "@/lib/utils";

interface VerdictBannerProps {
  readonly run: RunState;
  readonly result: MatrixResult | null;
  readonly timings: MatrixTimings | null;
  readonly stale: boolean;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function Progress({ run }: { readonly run: RunState }) {
  const running = run.status === "running";
  return (
    <div className="flex flex-col gap-2" data-testid="run-progress">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Loader aria-hidden="true" className="size-4 motion-safe:animate-spin" />
        {runStatusText(run)}
      </p>
      <progress
        aria-label="Run progress"
        className="h-1.5 w-full accent-primary"
        {...(running ? { value: run.done, max: Math.max(run.total, 1) } : {})}
      />
    </div>
  );
}

function Verdict({
  result,
  timings,
  stale,
}: {
  readonly result: MatrixResult;
  readonly timings: MatrixTimings | null;
  readonly stale: boolean;
}) {
  const view = useMemo(() => buildVerdictView(result), [result]);
  const Icon = VERDICT_ICONS[view.verdict];
  const deciding = view.deciding.filter((entry) => entry.count > 0 || view.verdict === "LEAKING");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p
          className={cn(
            "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-lg font-semibold tracking-wide",
            VERDICT_CLASSES[view.verdict],
          )}
        >
          <Icon aria-hidden="true" className="size-5" />
          {view.verdict}
        </p>
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Cells by status">
          {[...deciding, ...view.beside].map((entry) => {
            const StatusIcon = STATUS_ICONS[entry.status];
            return (
              <li
                key={entry.status}
                data-testid="verdict-count"
                data-status={entry.status}
                data-count={entry.count}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium",
                  STATUS_CLASSES[entry.status],
                )}
              >
                <StatusIcon aria-hidden="true" className="size-3.5" />
                {entry.label}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-sm text-muted-foreground">{view.description}</p>
      <p className="text-xs text-muted-foreground">
        {view.totalCells} cells
        {timings === null
          ? ""
          : `, ${seconds(timings.totalMs)} in total, ${seconds(timings.setupMs)} of it setup`}
        {timings !== null && timings.rebuilds > 0
          ? `, database rebuilt ${timings.rebuilds} time${timings.rebuilds === 1 ? "" : "s"} after a timeout`
          : ""}
        . Every status comes from executed SQL and compared row sets.
      </p>
      {stale ? (
        <p
          data-testid="result-stale"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-status-overblock"
        >
          <History aria-hidden="true" className="size-4" />
          The scenario changed after this run. Run again to test what is in the editors now.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The verdict, or what the run is doing. The visible part is rich; what a screen reader hears is
 * the one sentence in the polite live region, which is always mounted so that a change is read.
 */
export function VerdictBanner({ run, result, timings, stale }: VerdictBannerProps) {
  const busy = run.status === "setting-up" || run.status === "running";
  const failed = run.status === "failed" ? run : null;
  const showResult = !busy && failed === null && result !== null;
  // Everything that qualifies the verdict on screen (cancelled, stale) is part of the sentence.
  const announcement = verdictAnnouncement(run, result, stale);

  return (
    <section
      aria-label="Verdict"
      data-testid="verdict"
      data-verdict={showResult ? result.verdict : "none"}
      data-run-status={run.status}
      className="rounded-lg border bg-card p-4"
    >
      <p role="status" aria-live="polite" className="sr-only" data-testid="verdict-announcement">
        {announcement}
      </p>
      {busy ? <Progress run={run} /> : null}
      {failed !== null ? (
        <p className="flex items-start gap-2 text-sm font-medium text-status-leak">
          <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span data-testid="run-failure">
            {failed.reason === "setup" ? runStatusText(failed) : failed.message}
          </span>
        </p>
      ) : null}
      {!busy && run.status === "cancelled" ? (
        <p className="mb-3 flex items-center gap-2 text-sm font-medium text-status-inconclusive">
          <Ban aria-hidden="true" className="size-4" />
          {result === null
            ? runStatusText(run)
            : "Run cancelled. The result below is from the run before it."}
        </p>
      ) : null}
      {showResult ? <Verdict result={result} timings={timings} stale={stale} /> : null}
      {!busy && failed === null && result === null && run.status !== "cancelled" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Play aria-hidden="true" className="size-4" />
          Not run yet. Press Run to start Postgres in this tab and test every persona against every
          table.
        </p>
      ) : null}
    </section>
  );
}
