/**
 * The state of the Explain panel in the cell drawer, as a pure reducer (brief 3.7).
 *
 * The one rule it guards (rules.yaml AI-002): SQL from the model is a PROPOSAL. It is `unverified`
 * until the matrix was re-run with it, `settled` carries what `compareRuns` decided, and only a
 * `verified` outcome can become `applied`. No action can set a verdict; the outcome is handed in
 * by the caller, who got it from `compareRuns`.
 */
import type { BuildExplainRequestResult } from "@/lib/ai/build-request";
import type { ExplainClientResult } from "@/lib/ai/client";
import {
  EXPLAIN_PAYLOAD_MAX_BYTES,
  FAILING_STATUSES,
  type Explanation,
  type PartialExplanation,
} from "@/lib/ai/schema";
import type { CellStatus } from "@/lib/runner";
import { splitSqlStatements } from "@/lib/scenario";
import type { FixVerification } from "./verify-fix";

/**
 * Explain is offered on the failures the engine PROVED: `leak`, `escape` and `overblock`. An
 * overblock is a failure too (rows the persona should reach are out of reach), the endpoint
 * accepts it, and the verified-fix loop judges it the same way: the cell must pass afterwards.
 * `inconclusive` and `skipped` proved nothing, so there is nothing to explain.
 */
export function isExplainable(status: CellStatus): boolean {
  return (FAILING_STATUSES as readonly string[]).includes(status);
}

export interface ExplainNotice {
  readonly code: string;
  readonly title: string;
  readonly message: string;
  /** From `Retry-After`; `null` when the server named no time. */
  readonly retryAfterSeconds: number | null;
  /** `false` when asking again cannot help (the feature is off, the payload is too large). */
  readonly retryable: boolean;
}

export type VerificationState =
  /** Shown as "Proposed (not yet verified)". */
  | { readonly status: "unverified" }
  /** The model proposed no statement, so there is nothing to test and nothing to apply. */
  | { readonly status: "no-sql" }
  | { readonly status: "verifying"; readonly done: number; readonly total: number }
  | {
      readonly status: "settled";
      readonly outcome: FixVerification;
      /** The schema of the copy that was re-run: what "Apply" writes. `null` unless verified. */
      readonly verifiedSchemaSql: string | null;
    }
  | { readonly status: "applied" };

export type ExplainState =
  | { readonly phase: "idle" }
  | { readonly phase: "requesting"; readonly partial: PartialExplanation }
  | { readonly phase: "failed"; readonly notice: ExplainNotice }
  | {
      readonly phase: "explained";
      readonly explanation: Explanation;
      /** The server answered from its cache: no model call was made. */
      readonly cached: boolean;
      readonly verification: VerificationState;
    };

export type ExplainAction =
  | { readonly type: "request/start" }
  | { readonly type: "request/partial"; readonly partial: PartialExplanation }
  | { readonly type: "request/finished"; readonly result: ExplainClientResult }
  | { readonly type: "verify/start" }
  | { readonly type: "verify/progress"; readonly done: number; readonly total: number }
  | {
      readonly type: "verify/finished";
      readonly outcome: FixVerification;
      /** The schema of the copy that was re-run; `null` when the proposal was never applied. */
      readonly schemaSql: string | null;
    }
  | { readonly type: "fix/applied" }
  | { readonly type: "reset" };

export const INITIAL_EXPLAIN_STATE: ExplainState = { phase: "idle" };

const PAYLOAD_KB = Math.round(EXPLAIN_PAYLOAD_MAX_BYTES / 1024);

function waitText(seconds: number | null): string {
  if (seconds === null) {
    return "Wait a moment and try again.";
  }
  return `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

/** Pure: what the panel says when `/api/explain` did not give an explanation. */
export function noticeOfFailure(result: ExplainClientResult & { ok: false }): ExplainNotice {
  const retryAfterSeconds = result.retryAfterSeconds ?? null;
  const base = { code: result.code, retryAfterSeconds };
  switch (result.code) {
    case "rate_limited":
      return {
        ...base,
        title: "Too many explanations requested",
        message: `${waitText(retryAfterSeconds)} Every request counts towards the limit, also one that is answered from the cache.`,
        retryable: true,
      };
    case "not_configured":
      return {
        ...base,
        title: "AI explanations are off",
        message: result.message,
        retryable: false,
      };
    case "unavailable":
      return {
        ...base,
        title: "Explain is temporarily unavailable",
        message: `${result.message} ${waitText(retryAfterSeconds)}`,
        retryable: true,
      };
    case "payload_too_large":
      return {
        ...base,
        title: "Too large to explain",
        message: `The server refused the request: it is larger than the ${PAYLOAD_KB} KB limit. Nothing was sent to the model.`,
        retryable: false,
      };
    case "invalid_request":
    case "unsupported_media_type":
      return {
        ...base,
        title: "The server refused the request",
        message: result.message,
        retryable: false,
      };
    case "model_failed":
      return {
        ...base,
        title: "The model gave no explanation",
        message: "Nothing was stored. Your results are untouched; try again.",
        retryable: true,
      };
    case "network":
      return {
        ...base,
        title: "The explanation service could not be reached",
        message: "Check your connection and try again. Your scenario and results are untouched.",
        retryable: true,
      };
    case "invalid_response":
    case "aborted":
      return {
        ...base,
        title: "The explanation did not arrive",
        message: result.message,
        retryable: true,
      };
  }
}

/** Pure: why `buildExplainRequest` built nothing. Nothing left the browser in these cases. */
export function noticeOfBuildFailure(
  reason: (BuildExplainRequestResult & { ok: false })["reason"],
): ExplainNotice {
  const base = { code: reason, retryAfterSeconds: null, retryable: false };
  if (reason === "too-large") {
    return {
      ...base,
      title: "Too large to explain",
      message: `This table's definition and policies are larger than the ${PAYLOAD_KB} KB that may leave the browser, so nothing was sent.`,
    };
  }
  return {
    ...base,
    title: "This cell cannot be explained",
    message:
      reason === "not-failing"
        ? "Explain is for cells the engine proved to fail: leak, escape and overblock."
        : "The cell no longer matches the scenario. Run the matrix again.",
  };
}

function initialVerification(explanation: Explanation): VerificationState {
  return splitSqlStatements(explanation.proposedPolicySql).length === 0
    ? { status: "no-sql" }
    : { status: "unverified" };
}

type ExplainedState = ExplainState & { readonly phase: "explained" };

function isExplained(state: ExplainState): state is ExplainedState {
  return state.phase === "explained";
}

function isVerifying(state: ExplainState): state is ExplainedState {
  return isExplained(state) && state.verification.status === "verifying";
}

/** A re-run may start when none ran yet, or when the last one did not complete. */
function mayVerify(verification: VerificationState): boolean {
  return (
    verification.status === "unverified" ||
    (verification.status === "settled" && verification.outcome.kind === "incomplete")
  );
}

function isVerifiedFix(verification: VerificationState): boolean {
  return verification.status === "settled" && verification.outcome.kind === "verified";
}

function withVerification(state: ExplainedState, verification: VerificationState): ExplainState {
  return { ...state, verification };
}

function requestFinished(state: ExplainState, result: ExplainClientResult): ExplainState {
  if (state.phase !== "requesting") {
    return state;
  }
  if (result.ok) {
    return {
      phase: "explained",
      explanation: result.explanation,
      cached: result.cached,
      verification: initialVerification(result.explanation),
    };
  }
  return result.code === "aborted"
    ? INITIAL_EXPLAIN_STATE
    : { phase: "failed", notice: noticeOfFailure(result) };
}

function verifyFinished(
  state: ExplainState,
  outcome: FixVerification,
  schemaSql: string | null,
): ExplainState {
  return isVerifying(state)
    ? withVerification(state, {
        status: "settled",
        outcome,
        verifiedSchemaSql: outcome.kind === "verified" ? schemaSql : null,
      })
    : state;
}

export function explainReducer(state: ExplainState, action: ExplainAction): ExplainState {
  switch (action.type) {
    case "request/start":
      return { phase: "requesting", partial: {} };
    case "request/partial":
      return state.phase === "requesting"
        ? { phase: "requesting", partial: action.partial }
        : state;
    case "request/finished":
      return requestFinished(state, action.result);
    case "verify/start":
      return isExplained(state) && mayVerify(state.verification)
        ? withVerification(state, { status: "verifying", done: 0, total: 0 })
        : state;
    case "verify/progress":
      return isVerifying(state)
        ? withVerification(state, { status: "verifying", done: action.done, total: action.total })
        : state;
    case "verify/finished":
      return verifyFinished(state, action.outcome, action.schemaSql);
    case "fix/applied":
      return isExplained(state) && isVerifiedFix(state.verification)
        ? withVerification(state, { status: "applied" })
        : state;
    case "reset":
      return INITIAL_EXPLAIN_STATE;
  }
}

/**
 * Pure: what a closed and reopened drawer may show again. A request or a re-run that was in
 * flight was aborted when the drawer closed, so it comes back as not started.
 */
export function restorableState(state: ExplainState): ExplainState {
  if (state.phase === "requesting") {
    return INITIAL_EXPLAIN_STATE;
  }
  if (state.phase === "explained" && state.verification.status === "verifying") {
    return { ...state, verification: { status: "unverified" } };
  }
  return state;
}

export type FixLabel = "Proposed (not yet verified)" | "Verified fix" | "Proposed fix did not pass";

/** Pure: the label over the proposed SQL. "Verified fix" needs a verified outcome, nothing less. */
export function fixLabelOf(verification: VerificationState): FixLabel {
  if (verification.status === "applied") {
    return "Verified fix";
  }
  if (verification.status !== "settled") {
    return "Proposed (not yet verified)";
  }
  switch (verification.outcome.kind) {
    case "verified":
      return "Verified fix";
    case "did-not-pass":
      return "Proposed fix did not pass";
    case "incomplete":
      return "Proposed (not yet verified)";
  }
}

/** Pure: what the panel's polite live region says; empty when there is nothing to announce. */
export function announcementOf(state: ExplainState): string {
  if (state.phase === "requesting") {
    return "The explanation is being written.";
  }
  if (state.phase !== "explained") {
    return "";
  }
  const { verification } = state;
  switch (verification.status) {
    case "verifying":
      return "Explanation complete. The matrix is being re-run with the proposed SQL.";
    case "applied":
      return "The verified fix was added to your schema.";
    case "no-sql":
      return "Explanation complete. The model proposed no SQL.";
    case "unverified":
      return "Explanation complete. The SQL is proposed and not yet verified.";
    case "settled":
      if (verification.outcome.kind === "verified") {
        return "Verified fix: the failing cell passes and no other cell got worse.";
      }
      return verification.outcome.kind === "did-not-pass"
        ? "Proposed fix did not pass."
        : "The proposal was not tested.";
  }
}
