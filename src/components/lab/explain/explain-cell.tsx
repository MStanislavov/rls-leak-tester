"use client";

/**
 * Explain and the verified-fix loop, in the footer of the cell drawer (brief 3.2, 3.7, 4.7, 4.8).
 *
 * - Offered on cells the engine PROVED to fail (`isExplainable`), and only when `/api/health`
 *   says the deployment has the feature. Otherwise a calm notice, and the lab works as before.
 * - Nothing leaves the browser before the click, and what leaves it is on screen first: the
 *   request `buildExplainRequest` built, never the seed data and never the schema text.
 * - The model's SQL is a proposal. The matrix is re-run with it on a copy of the scenario, and
 *   `compareRuns` alone decides whether the words "Verified fix" appear (rules.yaml AI-002).
 * - Every piece of model text is a text node (SEC-001).
 */
import { Info, Sparkles, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { CodeListing } from "@/components/site/scroll-region";
import { Button } from "@/components/ui/button";
import { buildExplainRequest, type BuildExplainRequestResult } from "@/lib/ai/build-request";
import type { ExplainClientResult } from "@/lib/ai/client";
import { EXPLAIN_PAYLOAD_MAX_BYTES, type PartialExplanation } from "@/lib/ai/schema";
import {
  INITIAL_EXPLAIN_STATE,
  announcementOf,
  explainReducer,
  isExplainable,
  noticeOfBuildFailure,
  restorableState,
  type ExplainNotice,
  type ExplainState,
  type VerificationState,
} from "@/lib/lab/explain-state";
import { unexpectedStatements, verifyProposedFix } from "@/lib/lab/verify-fix";
import type { MatrixResult } from "@/lib/runner";
import { CopyButton } from "../copy-button";
import type { LabCellSlotProps } from "../lab-extensions";
import { FixLabel, FixOutcome } from "./fix-verification";
import { useExplainAvailability } from "./use-explain-availability";

/**
 * A closed drawer unmounts this component. What it had is kept per run and cell, so reopening
 * the cell does not cost another request (every request counts towards the rate limit). A new
 * run is a new `MatrixResult`, and the old entries go with the old object.
 */
const sessions = new WeakMap<MatrixResult, Map<string, ExplainState>>();

function Notice({
  testId,
  title,
  children,
  tone = "info",
  code,
}: {
  readonly testId: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly tone?: "info" | "problem";
  readonly code?: string;
}) {
  const Icon = tone === "info" ? Info : TriangleAlert;
  return (
    <div
      data-testid={testId}
      data-code={code}
      role={tone === "problem" ? "alert" : "note"}
      className="flex items-start gap-2 rounded-md border bg-muted p-3 text-sm"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">{title}</p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function Paragraphs({ text, testId }: { readonly text: string; readonly testId: string }) {
  return (
    <div data-testid={testId} className="flex flex-col gap-2 text-sm">
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={`${index}-${paragraph.length}`} className="whitespace-pre-wrap">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function PayloadDetails({ json, bytes }: { readonly json: string; readonly bytes: number }) {
  return (
    <details data-testid="explain-payload" className="text-xs">
      <summary className="cursor-pointer rounded font-medium">
        What leaves your browser (<span data-testid="explain-payload-bytes">{bytes}</span> of at
        most {EXPLAIN_PAYLOAD_MAX_BYTES} bytes)
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-muted-foreground">
          Exactly this request goes to this site&apos;s server and from there to the model: the
          table&apos;s definition as the catalog describes it, its policies and grants, the
          persona&apos;s role and claims, the operation, at most 20 primary keys per list, and the
          static findings on the table. Your seed data, your schema text and the probe scripts stay
          here. Server logs record a hash and sizes, never SQL or claims.
        </p>
        <CodeListing
          label="The request that will be sent"
          testId="explain-payload-json"
          className="max-h-48 overflow-auto rounded-md border bg-muted p-2 font-mono whitespace-pre-wrap"
        >
          {json}
        </CodeListing>
      </div>
    </details>
  );
}

function Answer({
  answer,
  complete,
}: {
  readonly answer: PartialExplanation;
  readonly complete: boolean;
}) {
  return (
    <div data-testid="explain-answer" data-complete={complete} className="flex flex-col gap-3">
      {answer.explanation === undefined ? null : (
        <Paragraphs text={answer.explanation} testId="explain-explanation" />
      )}
      {answer.rootCause === undefined ? null : (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Root cause
          </h4>
          <Paragraphs text={answer.rootCause} testId="explain-root-cause" />
        </div>
      )}
    </div>
  );
}

function ProposedSql({
  sql,
  confidence,
  verification,
  complete,
  children,
}: {
  readonly sql: string;
  readonly confidence: string | undefined;
  readonly verification: VerificationState;
  /** `false` while the SQL is still arriving: half a statement is not judged. */
  readonly complete: boolean;
  readonly children?: ReactNode;
}) {
  const unexpected = useMemo(() => (complete ? unexpectedStatements(sql) : []), [complete, sql]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Proposed policy SQL
        </h4>
        <CopyButton text={sql} label="Copy the proposed SQL" testId="explain-copy-sql" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FixLabel verification={verification} />
        {confidence === undefined ? null : (
          <span
            data-testid="explain-confidence"
            data-confidence={confidence}
            className="text-xs text-muted-foreground"
          >
            The model&apos;s own confidence: <span className="font-mono">{confidence}</span>. It
            decides nothing; the re-run does.
          </span>
        )}
      </div>
      <CodeListing
        label="Proposed policy SQL, read-only"
        testId="explain-sql"
        className="max-h-48 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
      >
        {sql}
      </CodeListing>
      {unexpected.length === 0 ? null : (
        <p data-testid="explain-unexpected-sql" className="text-xs">
          <TriangleAlert aria-hidden="true" className="mr-1 inline size-3.5" />
          The proposal holds statements other than policy, GRANT, REVOKE and ALTER TABLE ... ENABLE
          or FORCE ROW LEVEL SECURITY statements (
          <span className="font-mono">{unexpected.join("; ")}</span>). Such SQL can change the data
          instead of the access rules, so it is never re-run, verified or applied.
        </p>
      )}
      {children}
    </div>
  );
}

function OffNotice() {
  return (
    <Notice testId="explain-off-notice" title="AI explanations are off">
      This deployment has no model configured: set{" "}
      <span className="font-mono">ANTHROPIC_API_KEY</span> on the server to switch them on.
      Everything else works without it: the verdict, the matrix, the static checks and the export
      never use a model.
    </Notice>
  );
}

function UnknownNotice({ onRecheck }: { readonly onRecheck: () => void }) {
  return (
    <Notice testId="explain-unknown-notice" title="AI explanations could not be checked">
      <p>
        The server did not say whether explanations are configured. Everything else works without
        them.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={onRecheck}
        data-testid="explain-recheck"
      >
        Check again
      </Button>
    </Notice>
  );
}

function StaleNotice() {
  return (
    <Notice testId="explain-stale-notice" title="The scenario changed since this run">
      Run the matrix again: an explanation and a verified fix are always about the run on screen.
    </Notice>
  );
}

interface ExplainedViewProps {
  readonly state: ExplainState & { readonly phase: "explained" };
  readonly resultIsStale: boolean;
  readonly onVerify: () => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}

function VerificationControls({
  state,
  resultIsStale,
  onVerify,
  onApply,
  onCancel,
}: ExplainedViewProps) {
  const { verification } = state;
  const settled = verification.status === "settled" ? verification : null;
  const canVerify =
    !resultIsStale &&
    (verification.status === "unverified" ||
      // A proposal that was refused before any run stays refused: nothing to try again.
      (settled?.outcome.kind === "incomplete" && settled.outcome.reason !== "not-applied"));
  const canApply = !resultIsStale && settled !== null && settled.verifiedSchemaSql !== null;
  return (
    <>
      {verification.status === "verifying" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span data-testid="fix-progress">
            Re-running the whole matrix on a fresh database with this SQL
            {verification.total > 0 ? `: ${verification.done} of ${verification.total}` : ""}
            ...
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="fix-cancel"
            onClick={onCancel}
          >
            Cancel the re-run
          </Button>
        </div>
      ) : null}
      {settled === null ? null : <FixOutcome outcome={settled.outcome} />}
      {verification.status === "applied" ? (
        <p data-testid="fix-applied" className="text-sm">
          Added to the end of your schema. The scenario has unsaved changes now; run the matrix to
          see the new verdict.
        </p>
      ) : null}
      {resultIsStale ? <StaleNotice /> : null}
      <div className="flex flex-wrap gap-2 empty:hidden">
        {canVerify ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="fix-verify"
            onClick={onVerify}
          >
            Re-run the matrix with this SQL
          </Button>
        ) : null}
        {canApply ? (
          <Button type="button" size="sm" data-testid="fix-apply" onClick={onApply}>
            Apply to my scenario
          </Button>
        ) : null}
      </div>
    </>
  );
}

function ExplainedView(props: ExplainedViewProps) {
  const { explanation, verification, cached } = props.state;
  return (
    <>
      <Answer answer={explanation} complete />
      {cached ? (
        <p data-testid="explain-cached" className="text-xs text-muted-foreground">
          Answered from the server&apos;s cache: an identical request was explained before.
        </p>
      ) : null}
      {verification.status === "no-sql" ? (
        <Notice testId="explain-no-sql" title="No SQL was proposed">
          The model proposed no statement, so there is nothing to re-test and nothing to apply.
        </Notice>
      ) : (
        <ProposedSql
          sql={explanation.proposedPolicySql}
          confidence={explanation.confidence}
          verification={verification}
          complete
        >
          <VerificationControls {...props} />
        </ProposedSql>
      )}
    </>
  );
}

function RequestingView({
  partial,
  onCancel,
}: {
  readonly partial: PartialExplanation;
  readonly onCancel: () => void;
}) {
  return (
    <>
      <p data-testid="explain-waiting" className="text-sm text-muted-foreground">
        {partial.explanation === undefined
          ? "Waiting for the model. It may think for a while before the first words arrive."
          : "The explanation is being written..."}
      </p>
      <Answer answer={partial} complete={false} />
      {partial.proposedPolicySql === undefined ? null : (
        <ProposedSql
          sql={partial.proposedPolicySql}
          confidence={partial.confidence}
          verification={{ status: "unverified" }}
          complete={false}
        />
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="explain-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </>
  );
}

function AskView({
  built,
  failure,
  onExplain,
}: {
  readonly built: BuildExplainRequestResult;
  readonly failure: ExplainNotice | null;
  readonly onExplain: () => void;
}) {
  const payloadJson = useMemo(
    () => (built.ok ? JSON.stringify(built.request, null, 2) : ""),
    [built],
  );
  if (!built.ok) {
    const notice = noticeOfBuildFailure(built.reason);
    return (
      <Notice testId="explain-error" code={notice.code} title={notice.title}>
        {notice.message}
      </Notice>
    );
  }
  return (
    <>
      {failure === null ? null : (
        <Notice testId="explain-error" code={failure.code} title={failure.title} tone="problem">
          <span data-testid="explain-error-message">{failure.message}</span>
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {failure !== null && !failure.retryable ? null : (
          <Button type="button" size="sm" data-testid="explain-button" onClick={onExplain}>
            <Sparkles aria-hidden="true" />
            {failure === null ? "Explain this failure" : "Try again"}
          </Button>
        )}
        <p className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground">
          The engine proved this failure. A model explains it and proposes SQL, which the matrix
          then re-tests. The model never decides a verdict.
        </p>
      </div>
      <PayloadDetails json={payloadJson} bytes={built.bytes} />
    </>
  );
}

function ExplainForCell(props: LabCellSlotProps & { readonly result: MatrixResult }) {
  const { cell, result, scenario, validation, resultIsStale, getScenario, runIsolated } = props;
  const { applySchemaSql } = props;
  const catalog = props.matrixRun?.catalog ?? props.catalog;
  const { availability, recheck } = useExplainAvailability();

  const [state, dispatch] = useReducer(
    explainReducer,
    undefined,
    () => sessions.get(result)?.get(cell.id) ?? INITIAL_EXPLAIN_STATE,
  );
  useEffect(() => {
    const ofRun = sessions.get(result) ?? new Map<string, ExplainState>();
    ofRun.set(cell.id, restorableState(state));
    sessions.set(result, ofRun);
  }, [result, cell.id, state]);

  // One request or one re-run at a time; both end when the drawer closes.
  const inFlight = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );
  const cancel = useCallback(() => inFlight.current?.abort(), []);

  const built = useMemo(
    () =>
      catalog === null
        ? null
        : buildExplainRequest(cell, catalog, validation.scenario ?? scenario, props.findings),
    [cell, catalog, validation.scenario, scenario, props.findings],
  );

  /** `false` when the editors hold text the run never saw: the re-render then says "stale". */
  const stillTheRun = useCallback(
    (): boolean => !resultIsStale && getScenario() === scenario,
    [resultIsStale, getScenario, scenario],
  );

  const verify = useCallback(
    async (proposedPolicySql: string): Promise<void> => {
      const base = validation.scenario;
      if (base === null || !stillTheRun()) {
        return;
      }
      const controller = new AbortController();
      inFlight.current = controller;
      dispatch({ type: "verify/start" });
      const { outcome, schemaSql } = await verifyProposedFix({
        scenario: base,
        before: result,
        targetCellIds: [cell.id],
        proposedPolicySql,
        run: runIsolated,
        options: {
          signal: controller.signal,
          onProgress: ({ done, total }) => dispatch({ type: "verify/progress", done, total }),
        },
      });
      if (inFlight.current === controller) {
        inFlight.current = null;
      }
      dispatch({ type: "verify/finished", outcome, schemaSql });
    },
    [validation.scenario, stillTheRun, result, cell.id, runIsolated],
  );

  const explain = useCallback(async (): Promise<void> => {
    if (built?.ok !== true || !stillTheRun()) {
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    dispatch({ type: "request/start" });
    // The reader pulls in the AI SDK's JSON repair; it is fetched when Explain is first used.
    const answer = await import("@/lib/ai/client")
      .then(({ requestExplanation }) =>
        requestExplanation(built.request, {
          signal: controller.signal,
          onPartial: (partial) => dispatch({ type: "request/partial", partial }),
        }),
      )
      .catch((): ExplainClientResult => ({
        ok: false,
        code: "network",
        message: "The explanation service could not be reached.",
        status: undefined,
        retryAfterSeconds: undefined,
      }));
    if (inFlight.current === controller) {
      inFlight.current = null;
    }
    dispatch({ type: "request/finished", result: answer });
    if (answer.ok && !controller.signal.aborted) {
      // Brief 3.7: the proposal is tested right away; until then it is labelled as a proposal.
      await verify(answer.explanation.proposedPolicySql);
    }
  }, [built, stillTheRun, verify]);

  const apply = useCallback((): void => {
    if (
      state.phase !== "explained" ||
      state.verification.status !== "settled" ||
      state.verification.verifiedSchemaSql === null ||
      !stillTheRun()
    ) {
      return;
    }
    applySchemaSql(state.verification.verifiedSchemaSql);
    dispatch({ type: "fix/applied" });
    toast.success("The verified fix was added to your schema. Run the matrix to confirm it.");
  }, [state, stillTheRun, applySchemaSql]);

  if (availability === "checking" || built === null) {
    return null;
  }

  let body: ReactNode;
  if (state.phase === "explained") {
    body = (
      <ExplainedView
        state={state}
        resultIsStale={resultIsStale}
        onVerify={() => void verify(state.explanation.proposedPolicySql)}
        onApply={apply}
        onCancel={cancel}
      />
    );
  } else if (availability === "off") {
    body = <OffNotice />;
  } else if (availability === "unknown") {
    body = <UnknownNotice onRecheck={recheck} />;
  } else if (state.phase === "requesting") {
    body = <RequestingView partial={state.partial} onCancel={cancel} />;
  } else if (resultIsStale) {
    body = <StaleNotice />;
  } else {
    body = (
      <AskView
        built={built}
        failure={state.phase === "failed" ? state.notice : null}
        onExplain={() => void explain()}
      />
    );
  }

  return (
    <section
      aria-label="AI explanation"
      data-testid="explain-panel"
      data-phase={state.phase}
      data-availability={availability}
      className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Sparkles aria-hidden="true" className="size-3.5" />
        AI explanation
      </h3>
      {body}
      <p role="status" aria-live="polite" data-testid="explain-announcement" className="sr-only">
        {announcementOf(state)}
      </p>
    </section>
  );
}

/** The cell drawer extension: nothing at all for a cell that did not fail. */
export function ExplainCell(props: LabCellSlotProps) {
  const { cell, result } = props;
  if (result === null || !isExplainable(cell.status)) {
    return null;
  }
  return <ExplainForCell key={cell.id} {...props} result={result} />;
}
