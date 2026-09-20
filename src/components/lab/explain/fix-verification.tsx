"use client";

/**
 * What the re-run of the matrix said about a proposed fix (brief 3.7, rules.yaml AI-002). The
 * words "Verified fix" appear for a `verified` outcome of `compareRuns` and for nothing else.
 * Every value is a text node.
 */
import { CircleCheck, CircleX, FlaskConical, Hourglass, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { fixLabelOf, type VerificationState } from "@/lib/lab/explain-state";
import {
  cellChangeText,
  cellChangeTitle,
  type CellChange,
  type FixVerification,
} from "@/lib/lab/verify-fix";
import { cn } from "@/lib/utils";

export type FixStatus =
  "unverified" | "no-sql" | "verifying" | "verified" | "did-not-pass" | "incomplete" | "applied";

export function fixStatusOf(verification: VerificationState): FixStatus {
  return verification.status === "settled" ? verification.outcome.kind : verification.status;
}

const LABEL_CLASSES: Readonly<Record<FixStatus, string>> = {
  unverified: "border-dashed border-status-inconclusive/50 bg-status-inconclusive-bg",
  "no-sql": "border-dashed border-status-inconclusive/50 bg-status-inconclusive-bg",
  verifying: "border-dashed border-status-inconclusive/50 bg-status-inconclusive-bg",
  incomplete: "border-dashed border-status-inconclusive/50 bg-status-inconclusive-bg",
  verified: "border-status-pass/30 bg-status-pass-bg text-status-pass",
  applied: "border-status-pass/30 bg-status-pass-bg text-status-pass",
  "did-not-pass": "border-status-leak/40 bg-status-leak-bg text-status-leak",
};

const LABEL_ICONS: Readonly<Record<FixStatus, LucideIcon>> = {
  unverified: FlaskConical,
  "no-sql": FlaskConical,
  verifying: Hourglass,
  incomplete: FlaskConical,
  verified: CircleCheck,
  applied: CircleCheck,
  "did-not-pass": CircleX,
};

/** The label over the proposed SQL: never colour alone, always the words. */
export function FixLabel({ verification }: { readonly verification: VerificationState }) {
  const status = fixStatusOf(verification);
  const Icon = LABEL_ICONS[status];
  return (
    <span
      data-testid="fix-label"
      data-fix-status={status}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm font-medium",
        LABEL_CLASSES[status],
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {fixLabelOf(verification)}
    </span>
  );
}

function ChangeList({
  title,
  changes,
  testId,
}: {
  readonly title: string;
  readonly changes: readonly CellChange[];
  readonly testId: string;
}) {
  if (changes.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <h5 className="text-xs font-medium">
        {title} <span className="font-mono text-muted-foreground">({changes.length})</span>
      </h5>
      <ul data-testid={testId} data-count={changes.length} className="flex flex-col gap-1 text-xs">
        {changes.map((change) => (
          <li
            key={change.id}
            data-testid="fix-cell"
            data-cell-id={change.id}
            data-before={change.before ?? "none"}
            data-after={change.after ?? "gone"}
            className="rounded-md border bg-background px-2 py-1"
          >
            <span className="font-mono break-all">{cellChangeTitle(change)}</span>
            <span className="text-muted-foreground">: {cellChangeText(change)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Box({
  tone,
  testId,
  children,
}: {
  readonly tone: "pass" | "leak" | "neutral";
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3 text-sm",
        tone === "pass" && "border-status-pass/30 bg-status-pass-bg",
        tone === "leak" && "border-status-leak/40 bg-status-leak-bg",
        tone === "neutral" && "bg-muted",
      )}
    >
      {children}
    </div>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function FixOutcome({ outcome }: { readonly outcome: FixVerification }) {
  if (outcome.kind === "verified") {
    return (
      <Box tone="pass" testId="fix-verified">
        <p>
          The matrix was re-run on a fresh database with this SQL appended to your schema:{" "}
          {plural(
            outcome.fixed.length,
            "cell that failed now passes",
            "cells that failed now pass",
          )}{" "}
          and no other cell got worse. Verdict with the fix:{" "}
          <span data-testid="fix-verdict-after" className="font-mono font-semibold">
            {outcome.verdictAfter}
          </span>
          .
        </p>
        <ChangeList title="Fixed" changes={outcome.fixed} testId="fix-fixed" />
        <ChangeList
          title="Also fixed by the same SQL"
          changes={outcome.alsoFixed}
          testId="fix-also-fixed"
        />
        <ChangeList
          title="Failed before and still fail; this fix does not touch them"
          changes={outcome.remaining}
          testId="fix-remaining"
        />
      </Box>
    );
  }
  if (outcome.kind === "did-not-pass") {
    const { setupError } = outcome;
    return (
      <Box tone="leak" testId="fix-did-not-pass">
        {setupError === null ? (
          <p>
            The matrix was re-run with this SQL and{" "}
            {outcome.stillFailing.length > 0
              ? "it does not fix the failure"
              : "the cell passes, but other cells got worse"}
            . It was not applied to your scenario.
          </p>
        ) : (
          <div data-testid="fix-setup-error" data-sqlstate={setupError.sqlState ?? ""}>
            <p>
              The SQL did not apply:{" "}
              {setupError.timedOut
                ? "a statement did not finish in time"
                : "Postgres refused a statement"}{" "}
              while the database was built with it. Nothing was changed in your scenario.
            </p>
            <p className="mt-1 font-mono text-xs break-all">
              {setupError.sqlState === null ? "" : `SQLSTATE ${setupError.sqlState} `}
              {setupError.message}
            </p>
            <pre
              tabIndex={0}
              role="group"
              aria-label="The statement that failed"
              className="mt-2 max-h-32 overflow-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap"
            >
              {setupError.statement}
            </pre>
          </div>
        )}
        <ChangeList
          title="Still failing"
          changes={outcome.stillFailing}
          testId="fix-still-failing"
        />
        <ChangeList
          title="Made worse by the proposal"
          changes={outcome.regressed}
          testId="fix-regressed"
        />
      </Box>
    );
  }
  return (
    <Box tone="neutral" testId="fix-incomplete">
      <p>The proposal was not tested, so it stays a proposal. {outcome.message}</p>
    </Box>
  );
}
