"use client";

/**
 * Everything the runner recorded for one cell (brief 3.5): status, expected / actual / leaked /
 * missing keys, the exact SQL that ran, SQLSTATE and message, the sub-probes and the policies
 * that applied. Esc closes it and the focus returns to the cell. Every value is a text node.
 */
import { ShieldOff } from "lucide-react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { StatusBadge } from "@/components/site/status-badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SUB_PROBE_OUTCOME_LABELS,
  buildCellKeyLists,
  buildSubProbeViews,
  cellTranscript,
  type KeyListView,
  type SubProbeView,
} from "@/lib/lab";
import type { CellPolicy, CellResult, MatrixPersona, ProbeFailure } from "@/lib/runner";
import { statusMeta } from "@/lib/site/status";
import { CopyButton } from "./copy-button";
import { focusMatrixCell } from "./result-matrix";

interface CellDrawerProps {
  readonly cell: CellResult | null;
  readonly persona: MatrixPersona | null;
  readonly onClose: () => void;
  /** The footer slot: `LAB_CELL_DRAWER_EXTENSIONS`, rendered by the workbench. */
  readonly footer: ReactNode;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function SqlBlock({
  sql,
  label,
  testId,
}: {
  readonly sql: string;
  readonly label: string;
  readonly testId?: string;
}) {
  return (
    <pre
      tabIndex={0}
      role="group"
      aria-label={label}
      data-testid={testId}
      className="max-h-72 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {sql}
    </pre>
  );
}

function Failure({ error }: { readonly error: ProbeFailure }) {
  return (
    <p data-testid="cell-drawer-error" className="rounded-md border bg-muted p-2 text-xs">
      <span className="font-mono font-semibold">
        {error.sqlState === null ? "engine error" : `SQLSTATE ${error.sqlState}`}
      </span>
      <span className="font-mono"> {error.message}</span>
    </p>
  );
}

function KeyList({
  title,
  list,
  testId,
}: {
  readonly title: string;
  readonly list: KeyListView;
  readonly testId: string;
}) {
  return (
    <div data-testid={testId} data-count={list.total} className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">
          {title} <span className="font-mono text-muted-foreground">({list.total})</span>
        </h4>
        {list.total > 0 ? (
          <CopyButton text={list.copyText} label={`Copy ${title.toLowerCase()} keys`} />
        ) : null}
      </div>
      {list.total === 0 ? (
        <p className="text-xs text-muted-foreground">none</p>
      ) : (
        <ul
          tabIndex={0}
          aria-label={`${title} keys`}
          className="max-h-40 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs"
        >
          {list.shown.map((key, index) => (
            <li key={`${index}-${key}`} className="break-all">
              {key}
            </li>
          ))}
          {list.hidden > 0 ? (
            <li className="pt-1 font-sans text-muted-foreground">
              and {list.hidden} more; Copy takes all {list.total}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function SubProbe({ view }: { readonly view: SubProbeView }) {
  const { probe } = view;
  return (
    <li
      data-testid="cell-drawer-subprobe"
      data-kind={probe.kind}
      data-status={probe.status}
      className="flex flex-col gap-2 rounded-md border p-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={probe.status} size="sm" />
        <span className="text-sm font-medium">{view.title}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-mono">{probe.kind}</span>: {view.distinction}; outcome{" "}
        <span className="font-mono">{SUB_PROBE_OUTCOME_LABELS[probe.outcome]}</span>
      </p>
      {probe.reason === null ? null : <p className="text-xs">{probe.reason}</p>}
      {probe.error === null ? null : <Failure error={probe.error} />}
      {view.movedKeys.total > 0 ? (
        <KeyList
          title="Rows carrying the foreign value afterwards"
          list={view.movedKeys}
          testId="cell-drawer-moved-keys"
        />
      ) : null}
      {probe.sql === "" ? null : (
        <details>
          <summary className="cursor-pointer rounded text-xs font-medium">
            SQL of this probe
          </summary>
          <div className="mt-2 flex flex-col gap-1">
            <div className="flex justify-end">
              <CopyButton text={probe.sql} label={`Copy the SQL of ${view.title}`} />
            </div>
            <SqlBlock sql={probe.sql} label={`SQL of ${view.title}`} />
          </div>
        </details>
      )}
    </li>
  );
}

function Policy({ policy }: { readonly policy: CellPolicy }) {
  return (
    <li
      data-testid="cell-drawer-policy"
      className="flex flex-col gap-1 rounded-md border p-2 text-xs"
    >
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="font-mono text-sm font-semibold">{policy.name}</span>
        <span className="font-mono uppercase">{policy.command}</span>
        <span>{policy.permissive ? "permissive" : "restrictive"}</span>
        <span>
          to <span className="font-mono">{policy.roles.join(", ")}</span>
        </span>
      </p>
      <p className="text-muted-foreground">
        {policy.appliesAs === "command"
          ? "Applies to this command."
          : "A SELECT policy: Postgres also applies it to statements that read the row."}
      </p>
      <p className="font-mono break-all">
        USING {policy.using ?? "(none)"}
        <br />
        WITH CHECK {policy.withCheck ?? "(none: USING covers the new row)"}
      </p>
    </li>
  );
}

function CellDetails({
  cell,
  persona,
}: {
  readonly cell: CellResult;
  readonly persona: MatrixPersona | null;
}) {
  const keys = useMemo(() => buildCellKeyLists(cell), [cell]);
  const subProbes = useMemo(() => buildSubProbeViews(cell), [cell]);
  const transcript = useMemo(() => cellTranscript(cell), [cell]);
  return (
    <div className="flex flex-col gap-5 px-4 pb-4">
      <Section title="Status">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="cell-drawer-status" data-status={cell.status}>
            <StatusBadge status={cell.status} />
          </span>
          <span className="text-sm">
            expected scope <span className="font-mono">{cell.scope}</span>
            {cell.expectationSource === "default" ? " (a default, not set by you)" : ""}
          </span>
        </div>
        <p className="text-sm">{statusMeta(cell.status).meaning}</p>
        {cell.reason === null ? null : (
          <p data-testid="cell-drawer-reason" className="text-sm font-medium">
            {cell.reason}
          </p>
        )}
        {cell.rlsBypass === null ? null : (
          <p className="inline-flex items-start gap-1.5 text-sm">
            <ShieldOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Row level security does not restrict this role on this table ({cell.rlsBypass}): no
            policy was involved in what it reached.
          </p>
        )}
        {cell.perRowFallback ? (
          <p className="text-sm">
            The bulk statement raised an error, so reach was measured row by row in savepoints.
          </p>
        ) : null}
        {cell.error === null ? null : <Failure error={cell.error} />}
      </Section>

      {persona === null ? null : (
        <Section title="Ran as">
          <p className="font-mono text-xs break-all">
            role {persona.dbRole}
            <br />
            request.jwt.claims {persona.claimsJson}
          </p>
        </Section>
      )}

      <Section title="Row keys">
        <div className="grid gap-3 sm:grid-cols-2">
          <KeyList title="Expected" list={keys.expected} testId="cell-drawer-expected" />
          <KeyList title="Actual" list={keys.actual} testId="cell-drawer-actual" />
          <KeyList title="Leaked" list={keys.leaked} testId="cell-drawer-leaked" />
          <KeyList title="Missing" list={keys.missing} testId="cell-drawer-missing" />
          {keys.blind.total > 0 ? (
            <KeyList
              title="Reached only without WHERE and RETURNING"
              list={keys.blind}
              testId="cell-drawer-blind"
            />
          ) : null}
        </div>
      </Section>

      {cell.sql === "" ? null : (
        <Section title="Probe SQL, exactly as it ran">
          <div className="flex justify-end">
            <CopyButton text={cell.sql} label="Copy the probe SQL" testId="cell-drawer-copy-sql" />
          </div>
          <SqlBlock sql={cell.sql} label="Probe SQL transcript" testId="cell-drawer-sql" />
        </Section>
      )}

      {subProbes.length === 0 ? null : (
        <Section title={`Sub-probes (${subProbes.length})`}>
          <ul className="flex flex-col gap-2">
            {subProbes.map((view) => (
              <SubProbe key={view.id} view={view} />
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Policies that applied (${cell.policies.length})`}>
        {cell.policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No policy applies to this role, table and command.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {cell.policies.map((policy) => (
              <Policy key={`${policy.name}-${policy.appliesAs}`} policy={policy} />
            ))}
          </ul>
        )}
      </Section>

      {transcript === "" || transcript === cell.sql ? null : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CopyButton text={transcript} label="Copy every script of this cell" />
          every script of this cell, in order
        </div>
      )}
    </div>
  );
}

export function CellDrawer({ cell, persona, onClose, footer }: CellDrawerProps) {
  const cellId = cell?.id ?? null;
  // By the time the sheet has closed `cell` is gone, so the cell to return to is remembered.
  const lastCellId = useRef<string | null>(null);
  useEffect(() => {
    if (cellId !== null) {
      lastCellId.current = cellId;
    }
  }, [cellId]);
  return (
    <Sheet
      open={cell !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        side="right"
        data-testid="cell-drawer"
        data-cell-id={cellId ?? ""}
        className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          // Radix would focus the trigger; the grid has none, so the cell gets the focus back.
          event.preventDefault();
          if (lastCellId.current !== null) {
            focusMatrixCell(lastCellId.current);
          }
        }}
      >
        <SheetHeader>
          <SheetTitle className="pr-8 font-mono text-sm break-all" data-testid="cell-drawer-title">
            {cell === null
              ? "Cell"
              : `${cell.operation.toUpperCase()} ${cell.schema}.${cell.table} as ${cell.personaId}`}
          </SheetTitle>
          <SheetDescription>
            {persona === null
              ? "Details of one matrix cell."
              : `${persona.label}, role ${persona.dbRole}`}
          </SheetDescription>
        </SheetHeader>
        {cell === null ? null : <CellDetails cell={cell} persona={persona} />}
        <SheetFooter
          data-testid="cell-drawer-footer"
          className="sticky bottom-0 border-t bg-popover empty:hidden"
        >
          {footer}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
