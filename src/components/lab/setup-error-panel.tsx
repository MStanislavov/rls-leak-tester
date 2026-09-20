"use client";

import { CircleX, Hourglass, TextCursorInput } from "lucide-react";
import { CodeListing } from "@/components/site/scroll-region";
import { Button } from "@/components/ui/button";
import type { SetupErrorView } from "@/lib/lab";

interface SetupErrorPanelProps {
  readonly error: SetupErrorView;
  /** Switches to the editor that holds the statement and scrolls to the marked line. */
  readonly onShowInEditor: () => void;
}

const PHASE_TITLES: Readonly<Record<SetupErrorView["phase"], string>> = {
  schema: "Schema SQL",
  seed: "Seed SQL",
  shim: "Supabase shim (this product's SQL)",
  grants: "Supabase default grants (this product's SQL)",
};

/**
 * A failed statement of the scenario's SQL (brief 3.3): phase, SQLSTATE, message, the statement
 * and its line. Everything that came from the database or the scenario is a text node.
 */
export function SetupErrorPanel({ error, onShowInEditor }: SetupErrorPanelProps) {
  const Icon = error.timedOut ? Hourglass : CircleX;
  return (
    <section
      role="alert"
      aria-label="Setup error"
      data-testid="setup-error"
      data-phase={error.phase}
      data-sqlstate={error.sqlState ?? ""}
      data-line={error.errorLine}
      data-timed-out={error.timedOut}
      className="flex flex-col gap-3 rounded-lg border border-status-leak/40 bg-status-leak-bg p-4 text-sm"
    >
      <h3 className="flex flex-wrap items-center gap-2 font-semibold text-status-leak">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span>
          {PHASE_TITLES[error.phase]} {error.timedOut ? "timed out" : "failed"} at line{" "}
          <span data-testid="setup-error-line">{error.errorLine}</span>
        </span>
        {error.sqlState === null ? null : (
          <span
            data-testid="setup-error-sqlstate"
            className="rounded border border-status-leak/40 bg-background px-1.5 py-0.5 font-mono text-xs"
          >
            SQLSTATE {error.sqlState}
          </span>
        )}
      </h3>
      <p data-testid="setup-error-message" className="font-mono text-foreground">
        {error.message}
      </p>
      {error.detail === null ? null : (
        <p className="text-foreground">
          <span className="font-medium">Detail: </span>
          {error.detail}
        </p>
      )}
      {error.hint === null ? null : (
        <p className="text-foreground">
          <span className="font-medium">Hint: </span>
          {error.hint}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">
          Statement starting at line {error.statementLine}
        </p>
        <CodeListing
          label="The statement that failed"
          testId="setup-error-statement"
          className="max-h-48 overflow-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap text-foreground"
        >
          {error.statement}
        </CodeListing>
      </div>
      {error.editor === null ? null : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onShowInEditor}
            data-testid="setup-error-show"
          >
            <TextCursorInput aria-hidden="true" />
            Show in the {error.editor} editor
          </Button>
        </div>
      )}
    </section>
  );
}
