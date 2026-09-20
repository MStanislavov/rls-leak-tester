import { describe, expect, it } from "vitest";
import type { ExplainClientResult } from "@/lib/ai/client";
import type { Explanation } from "@/lib/ai/schema";
import { CELL_STATUSES } from "@/lib/runner";
import {
  INITIAL_EXPLAIN_STATE,
  announcementOf,
  explainReducer,
  fixLabelOf,
  isExplainable,
  noticeOfBuildFailure,
  noticeOfFailure,
  restorableState,
  type ExplainAction,
  type ExplainState,
} from "./explain-state";
import type { FixVerification } from "./verify-fix";

const EXPLANATION: Explanation = {
  explanation: "The UPDATE policy checks the old row only.",
  rootCause: "WITH CHECK (true) on projects_update.",
  proposedPolicySql: "alter policy projects_update on public.projects with check (false);",
  confidence: "high",
};

const VERIFIED: FixVerification = {
  kind: "verified",
  fixed: [],
  alsoFixed: [],
  remaining: [],
  verdictBefore: "LEAKING",
  verdictAfter: "ISOLATED",
};
const DID_NOT_PASS: FixVerification = {
  kind: "did-not-pass",
  stillFailing: [],
  regressed: [],
  setupError: null,
  verdictAfter: "LEAKING",
};
const CANCELLED: FixVerification = {
  kind: "incomplete",
  reason: "cancelled",
  message: "The re-run was cancelled.",
};

function failure(
  code: (ExplainClientResult & { ok: false })["code"],
  retryAfterSeconds?: number,
): ExplainClientResult & { ok: false } {
  return { ok: false, code, message: `server said ${code}`, status: 400, retryAfterSeconds };
}

function reduce(actions: readonly ExplainAction[], from = INITIAL_EXPLAIN_STATE): ExplainState {
  return actions.reduce(explainReducer, from);
}

const ANSWERED: readonly ExplainAction[] = [
  { type: "request/start" },
  { type: "request/finished", result: { ok: true, explanation: EXPLANATION, cached: false } },
];

describe("isExplainable", () => {
  it("offers Explain on the failures the engine proved, and on nothing else", () => {
    expect(CELL_STATUSES.filter(isExplainable)).toEqual(["leak", "escape", "overblock"]);
  });
});

describe("explainReducer", () => {
  it("streams partial answers while requesting, and only then", () => {
    const streaming = reduce([
      { type: "request/start" },
      { type: "request/partial", partial: { explanation: "The UPD" } },
    ]);

    expect(streaming).toEqual({ phase: "requesting", partial: { explanation: "The UPD" } });
    expect(
      explainReducer(INITIAL_EXPLAIN_STATE, {
        type: "request/partial",
        partial: { rootCause: "x" },
      }),
    ).toBe(INITIAL_EXPLAIN_STATE);
  });

  it("a finished answer is a PROPOSAL: unverified, whatever the model's confidence", () => {
    const state = reduce(ANSWERED);

    expect(state).toEqual({
      phase: "explained",
      explanation: EXPLANATION,
      cached: false,
      verification: { status: "unverified" },
    });
    expect(state.phase === "explained" ? fixLabelOf(state.verification) : "").toBe(
      "Proposed (not yet verified)",
    );
  });

  it("an answer without a statement has nothing to verify", () => {
    for (const proposedPolicySql of ["", "-- no change possible"]) {
      const state = reduce([
        { type: "request/start" },
        {
          type: "request/finished",
          result: { ok: true, explanation: { ...EXPLANATION, proposedPolicySql }, cached: true },
        },
      ]);

      expect(state).toMatchObject({ cached: true, verification: { status: "no-sql" } });
      expect(explainReducer(state, { type: "verify/start" })).toBe(state);
    }
  });

  it("ignores an answer nobody is waiting for", () => {
    expect(explainReducer(INITIAL_EXPLAIN_STATE, ANSWERED[1] as ExplainAction)).toBe(
      INITIAL_EXPLAIN_STATE,
    );
  });

  it("a cancelled request goes back to the button; every other failure is shown", () => {
    const start: ExplainAction = { type: "request/start" };

    expect(reduce([start, { type: "request/finished", result: failure("aborted") }])).toBe(
      INITIAL_EXPLAIN_STATE,
    );
    expect(
      reduce([start, { type: "request/finished", result: failure("rate_limited", 42) }]),
    ).toMatchObject({ phase: "failed", notice: { code: "rate_limited", retryAfterSeconds: 42 } });
  });

  it("verifies: start, progress, outcome; the schema is kept for a verified outcome only", () => {
    const verifying = reduce([
      ...ANSWERED,
      { type: "verify/start" },
      { type: "verify/progress", done: 3, total: 60 },
    ]);
    expect(verifying).toMatchObject({ verification: { status: "verifying", done: 3, total: 60 } });

    const verified = explainReducer(verifying, {
      type: "verify/finished",
      outcome: VERIFIED,
      schemaSql: "the schema with the fix",
    });
    const refused = explainReducer(verifying, {
      type: "verify/finished",
      outcome: DID_NOT_PASS,
      schemaSql: "the schema with the wrong fix",
    });

    expect(verified).toMatchObject({
      verification: { status: "settled", verifiedSchemaSql: "the schema with the fix" },
    });
    expect(refused).toMatchObject({ verification: { status: "settled", verifiedSchemaSql: null } });
  });

  it("no action can settle a verification that is not running", () => {
    const unverified = reduce(ANSWERED);
    const finished: ExplainAction = { type: "verify/finished", outcome: VERIFIED, schemaSql: "x" };

    expect(explainReducer(unverified, finished)).toBe(unverified);
    expect(explainReducer(unverified, { type: "verify/progress", done: 1, total: 2 })).toBe(
      unverified,
    );
    expect(explainReducer(INITIAL_EXPLAIN_STATE, finished)).toBe(INITIAL_EXPLAIN_STATE);
    expect(explainReducer(INITIAL_EXPLAIN_STATE, { type: "verify/start" })).toBe(
      INITIAL_EXPLAIN_STATE,
    );
  });

  it("only an incomplete verification may be started again", () => {
    const settle = (outcome: FixVerification): ExplainState =>
      reduce([
        ...ANSWERED,
        { type: "verify/start" },
        { type: "verify/finished", outcome, schemaSql: "s" },
      ]);

    expect(explainReducer(settle(CANCELLED), { type: "verify/start" })).toMatchObject({
      verification: { status: "verifying" },
    });
    for (const outcome of [VERIFIED, DID_NOT_PASS]) {
      const settled = settle(outcome);
      expect(explainReducer(settled, { type: "verify/start" })).toBe(settled);
    }
  });

  it("only a VERIFIED fix can be applied", () => {
    const settle = (outcome: FixVerification): ExplainState =>
      reduce([
        ...ANSWERED,
        { type: "verify/start" },
        { type: "verify/finished", outcome, schemaSql: "s" },
      ]);
    const applied: ExplainAction = { type: "fix/applied" };

    expect(explainReducer(settle(VERIFIED), applied)).toMatchObject({
      verification: { status: "applied" },
    });
    for (const state of [settle(DID_NOT_PASS), settle(CANCELLED), reduce(ANSWERED)]) {
      expect(explainReducer(state, applied)).toBe(state);
    }
    expect(explainReducer(INITIAL_EXPLAIN_STATE, applied)).toBe(INITIAL_EXPLAIN_STATE);
  });

  it("resets", () => {
    expect(explainReducer(reduce(ANSWERED), { type: "reset" })).toBe(INITIAL_EXPLAIN_STATE);
  });
});

describe("fixLabelOf", () => {
  it('says "Verified fix" for a verified outcome and for nothing else', () => {
    expect(fixLabelOf({ status: "unverified" })).toBe("Proposed (not yet verified)");
    expect(fixLabelOf({ status: "no-sql" })).toBe("Proposed (not yet verified)");
    expect(fixLabelOf({ status: "verifying", done: 59, total: 60 })).toBe(
      "Proposed (not yet verified)",
    );
    expect(fixLabelOf({ status: "settled", outcome: CANCELLED, verifiedSchemaSql: null })).toBe(
      "Proposed (not yet verified)",
    );
    expect(fixLabelOf({ status: "settled", outcome: DID_NOT_PASS, verifiedSchemaSql: null })).toBe(
      "Proposed fix did not pass",
    );
    expect(fixLabelOf({ status: "settled", outcome: VERIFIED, verifiedSchemaSql: "s" })).toBe(
      "Verified fix",
    );
    expect(fixLabelOf({ status: "applied" })).toBe("Verified fix");
  });
});

describe("restorableState", () => {
  it("brings work that was in flight back as not started", () => {
    expect(restorableState(reduce([{ type: "request/start" }]))).toBe(INITIAL_EXPLAIN_STATE);
    expect(restorableState(reduce([...ANSWERED, { type: "verify/start" }]))).toMatchObject({
      phase: "explained",
      verification: { status: "unverified" },
    });
  });

  it("keeps what is settled", () => {
    const settled = reduce([
      ...ANSWERED,
      { type: "verify/start" },
      { type: "verify/finished", outcome: VERIFIED, schemaSql: "s" },
    ]);

    expect(restorableState(settled)).toBe(settled);
    expect(restorableState(INITIAL_EXPLAIN_STATE)).toBe(INITIAL_EXPLAIN_STATE);
  });
});

describe("noticeOfFailure", () => {
  it("429: says when to try again, and that cache hits count", () => {
    const notice = noticeOfFailure(failure("rate_limited", 17));

    expect(notice).toMatchObject({ retryAfterSeconds: 17, retryable: true });
    expect(notice.message).toContain("Try again in 17 seconds.");
    expect(notice.message).toContain("answered from the cache");
    expect(noticeOfFailure(failure("rate_limited", 1)).message).toContain("in 1 second.");
    expect(noticeOfFailure(failure("rate_limited")).message).toContain("Wait a moment");
  });

  it("503: not configured cannot be retried, unavailable can", () => {
    expect(noticeOfFailure(failure("not_configured"))).toMatchObject({
      title: "AI explanations are off",
      message: "server said not_configured",
      retryable: false,
    });
    const unavailable = noticeOfFailure(failure("unavailable", 30));
    expect(unavailable.retryable).toBe(true);
    expect(unavailable.message).toBe("server said unavailable Try again in 30 seconds.");
  });

  it("413 and 400: retrying the same request cannot help", () => {
    expect(noticeOfFailure(failure("payload_too_large"))).toMatchObject({
      title: "Too large to explain",
      retryable: false,
    });
    expect(noticeOfFailure(failure("payload_too_large")).message).toContain("30 KB");
    for (const code of ["invalid_request", "unsupported_media_type"] as const) {
      expect(noticeOfFailure(failure(code))).toMatchObject({
        message: `server said ${code}`,
        retryable: false,
      });
    }
  });

  it("network, model and broken answers can be retried", () => {
    for (const code of ["network", "model_failed", "invalid_response", "aborted"] as const) {
      const notice = noticeOfFailure(failure(code));
      expect(notice).toMatchObject({ code, retryable: true, retryAfterSeconds: null });
      expect(notice.title.length).toBeGreaterThan(0);
    }
  });
});

describe("noticeOfBuildFailure", () => {
  it("says that nothing was sent", () => {
    expect(noticeOfBuildFailure("too-large").message).toContain("nothing was sent");
    expect(noticeOfBuildFailure("not-failing").message).toContain("leak, escape and overblock");
    for (const reason of ["unknown-table", "unknown-persona"] as const) {
      expect(noticeOfBuildFailure(reason)).toMatchObject({
        code: reason,
        retryable: false,
        message: "The cell no longer matches the scenario. Run the matrix again.",
      });
    }
  });
});

describe("announcementOf", () => {
  it("announces progress and the outcome, and never a fix that was not verified", () => {
    const settle = (outcome: FixVerification): ExplainState =>
      reduce([
        ...ANSWERED,
        { type: "verify/start" },
        { type: "verify/finished", outcome, schemaSql: "s" },
      ]);

    expect(announcementOf(INITIAL_EXPLAIN_STATE)).toBe("");
    expect(announcementOf(reduce([{ type: "request/start" }]))).toContain("being written");
    expect(announcementOf(reduce(ANSWERED))).toContain("not yet verified");
    expect(announcementOf(reduce([...ANSWERED, { type: "verify/start" }]))).toContain("re-run");
    expect(announcementOf(settle(VERIFIED))).toContain("Verified fix");
    expect(announcementOf(settle(DID_NOT_PASS))).toBe("Proposed fix did not pass.");
    expect(announcementOf(settle(CANCELLED))).toBe("The proposal was not tested.");
    expect(announcementOf(explainReducer(settle(VERIFIED), { type: "fix/applied" }))).toContain(
      "added to your schema",
    );
    expect(
      announcementOf({
        phase: "explained",
        explanation: EXPLANATION,
        cached: false,
        verification: { status: "no-sql" },
      }),
    ).toContain("no SQL");
  });
});
