"use client";

import { ExternalLink, Crosshair, ShieldCheck } from "lucide-react";
import { SeverityBadge } from "@/components/site/severity-badge";
import { findingTableKey } from "@/lib/lab";
import type { Finding } from "@/lib/checks";
import { cn } from "@/lib/utils";

interface FindingsListProps {
  /** `null` until a run or an introspection produced a catalog. */
  readonly findings: readonly Finding[] | null;
  readonly stale: boolean;
  readonly highlightedTable: string | null;
  readonly onHighlight: (table: string | null) => void;
}

function findingKey(finding: Finding): string {
  return `${finding.id}|${finding.object.kind}|${finding.object.qualifiedName}`;
}

/** Only a web address becomes a link; anything else is shown as text. */
function isWebUrl(url: string): boolean {
  return url.startsWith("https://");
}

function FindingCard({
  finding,
  highlightedTable,
  onHighlight,
}: {
  readonly finding: Finding;
  readonly highlightedTable: string | null;
  readonly onHighlight: (table: string | null) => void;
}) {
  const table = findingTableKey(finding);
  const active = table !== null && table === highlightedTable;
  return (
    <li
      data-testid="finding"
      data-finding-id={finding.id}
      data-severity={finding.severity}
      data-table={table ?? ""}
      data-active={active}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm",
        active && "border-primary ring-2 ring-ring/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold">{finding.id}</span>
        <SeverityBadge severity={finding.severity} />
        <span className="font-medium">{finding.title}</span>
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">
        {finding.object.kind} {finding.object.qualifiedName}
      </p>
      <p>{finding.explanation}</p>
      {finding.evidence.length === 0 ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {finding.evidence.map((entry, index) => (
            <div key={`${entry.label}-${index}`} className="contents">
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="font-mono break-all">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {table === null ? null : (
          <button
            type="button"
            aria-pressed={active}
            onClick={() => onHighlight(active ? null : table)}
            data-testid="finding-highlight"
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            <Crosshair aria-hidden="true" className="size-3.5" />
            {active ? "Remove the highlight" : `Highlight ${table} in the matrix`}
          </button>
        )}
        {isWebUrl(finding.docsUrl) ? (
          <a
            href={finding.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            Documentation
            <span className="sr-only"> for {finding.id} (opens in a new tab)</span>
          </a>
        ) : (
          <span className="font-mono text-xs break-all">{finding.docsUrl}</span>
        )}
      </div>
    </li>
  );
}

/** Static checks RLS001 to RLS009: facts from the catalog, next to the matrix, never a verdict. */
export function FindingsList({
  findings,
  stale,
  highlightedTable,
  onHighlight,
}: FindingsListProps) {
  return (
    <section
      aria-labelledby="findings-heading"
      data-testid="findings"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="findings-heading" className="text-base font-semibold">
          Static findings
        </h2>
        <p className="text-xs text-muted-foreground">
          Read from the catalog, no AI. A finding is a fact, not a verdict; the matrix is the proof.
        </p>
      </div>
      {findings === null ? (
        <p className="text-sm text-muted-foreground">
          Run or introspect the scenario to check its tables, policies, views and functions.
        </p>
      ) : null}
      {findings !== null && findings.length === 0 ? (
        <p
          data-testid="findings-empty"
          className="inline-flex items-center gap-1.5 text-sm text-status-pass"
        >
          <ShieldCheck aria-hidden="true" className="size-4" />
          None of the nine static checks found anything.
        </p>
      ) : null}
      {findings !== null && stale ? (
        <p className="text-xs text-muted-foreground">
          From before your last edit; run again to refresh.
        </p>
      ) : null}
      {findings !== null && findings.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {findings.map((finding) => (
            <FindingCard
              key={findingKey(finding)}
              finding={finding}
              highlightedTable={highlightedTable}
              onHighlight={onHighlight}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
