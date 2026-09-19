import { describe, expect, it } from "vitest";
import {
  STATUS_SEVERITY,
  classifyCell,
  classifyInsertCell,
  classifySubProbe,
  countStatuses,
  diffKeys,
  isBlocked,
  isDataException,
  isDatabaseLost,
  isRowSecurityViolation,
  isStatementDenial,
  outcomeOfFailure,
  sortKeys,
  toProbeFailure,
  verdictOf,
} from "./classify";
import { CELL_STATUSES, type CellStatus } from "./result";
import {
  EngineError,
  EngineTerminatedError,
  EngineTimeoutError,
  EngineWedgedError,
  SqlError,
} from "./types";

const evidence = (
  parts: Partial<Parameters<typeof classifyCell>[0]> = {},
): Parameters<typeof classifyCell>[0] => ({
  leakedKeys: [],
  missingKeys: [],
  inconclusive: false,
  subProbes: [],
  ...parts,
});

describe("diffKeys", () => {
  it("leaked is actual minus expected, missing is expected minus actual", () => {
    expect(diffKeys(["a", "b"], ["b", "c"])).toEqual({ leakedKeys: ["c"], missingKeys: ["a"] });
    expect(diffKeys([], [])).toEqual({ leakedKeys: [], missingKeys: [] });
  });

  it("sorts in code-unit order and drops duplicates", () => {
    expect(sortKeys(['["b"]', '["B"]', '["a"]', '["a"]', '["10"]', '["9"]'])).toEqual([
      '["10"]',
      '["9"]',
      '["B"]',
      '["a"]',
      '["b"]',
    ]);
    expect(diffKeys([], ["z", "a", "z"]).leakedKeys).toEqual(["a", "z"]);
  });
});

describe("errors", () => {
  it("42501 is blocked, a policy violation and a missing privilege alike", () => {
    const failure = toProbeFailure(
      new SqlError({ code: "42501", message: "permission denied for table docs" }),
    );
    expect(failure).toEqual({ sqlState: "42501", message: "permission denied for table docs" });
    expect(isBlocked(failure)).toBe(true);
    expect(outcomeOfFailure(failure)).toBe("blocked");
  });

  it.each([
    'new row violates row-level security policy for table "docs"',
    'new row violates row-level security policy "p" for table "docs"',
    "permission denied for table docs",
    "permission denied for view docs_view",
    "permission denied for foreign table remote_docs",
    "permission denied for function is_member",
    "only managers may do this",
  ])("42501 %s: blocked", (message) => {
    expect(isBlocked({ sqlState: "42501", message })).toBe(true);
  });

  it.each([
    "permission denied for schema private",
    "permission denied for type private.status",
    "permission denied for sequence docs_id_seq",
    "permission denied for language plpython3u",
    "permission denied for foreign-data wrapper fdw",
    "permission denied for foreign server remote",
    'query would be affected by row-level security policy for table "docs"',
  ])("42501 %s: not about the probed rows, so inconclusive", (message) => {
    const failure = { sqlState: "42501", message };
    expect(isBlocked(failure)).toBe(false);
    expect(outcomeOfFailure(failure)).toBe("inconclusive");
  });

  it("tells a row's policy violation from a missing privilege, and knows data exceptions", () => {
    const violation = {
      sqlState: "42501",
      message: 'new row violates row-level security policy for table "docs"',
    };
    expect(isRowSecurityViolation(violation)).toBe(true);
    expect(
      isRowSecurityViolation({ sqlState: "42501", message: "permission denied for table docs" }),
    ).toBe(false);
    expect(isRowSecurityViolation({ ...violation, sqlState: "P0001" })).toBe(false);
    expect(isDataException({ sqlState: "22P02", message: "invalid input syntax" })).toBe(true);
    expect(isDataException({ sqlState: "42501", message: "no" })).toBe(false);
    expect(isDataException({ sqlState: null, message: "engine" })).toBe(false);
  });

  it("only a missing privilege or row_security = off is about the whole statement", () => {
    const denial = (message: string, sqlState = "42501"): boolean =>
      isStatementDenial({ sqlState, message });
    expect(denial("permission denied for table docs")).toBe(true);
    expect(denial("permission denied for schema private")).toBe(true);
    expect(denial('query would be affected by row-level security policy for table "docs"')).toBe(
      true,
    );
    // A policy violation and a trigger's own 42501 can depend on the row: measured row by row.
    expect(denial('new row violates row-level security policy for table "docs"')).toBe(false);
    expect(denial("only managers may do this")).toBe(false);
    expect(denial("permission denied for table docs", "P0001")).toBe(false);
  });

  it.each(["23505", "23503", "23502", "23514", "22P02", "57014", "XX000"])(
    "%s is inconclusive, never blocked",
    (code) => {
      const failure = toProbeFailure(new SqlError({ code, message: "boom" }));
      expect(isBlocked(failure)).toBe(false);
      expect(outcomeOfFailure(failure)).toBe("inconclusive");
    },
  );

  it("an engine failure has no SQLSTATE and is inconclusive", () => {
    expect(toProbeFailure(new EngineTimeoutError(5000))).toEqual({
      sqlState: null,
      message: "The database did not answer within 5000 ms and was terminated",
    });
    expect(toProbeFailure("plain")).toEqual({ sqlState: null, message: "plain" });
    expect(outcomeOfFailure(toProbeFailure(new Error("x")))).toBe("inconclusive");
  });

  it("knows when the database is gone", () => {
    expect(isDatabaseLost(new EngineTimeoutError(1))).toBe(true);
    expect(isDatabaseLost(new EngineTerminatedError("gone"))).toBe(true);
    expect(isDatabaseLost(new EngineWedgedError("worn out"))).toBe(true);
    expect(new EngineWedgedError("worn out").name).toBe("EngineWedgedError");
    expect(isDatabaseLost(new EngineError("Transaction is closed"))).toBe(false);
    expect(isDatabaseLost(new SqlError({ code: "42501", message: "no" }))).toBe(false);
  });
});

describe("classifySubProbe", () => {
  it.each([
    ["blocked", "blocked", "pass"],
    ["allowed", "allowed", "pass"],
    ["blocked", "allowed", "escape"],
    ["allowed", "blocked", "overblock"],
    ["blocked", "inconclusive", "inconclusive"],
    ["allowed", "inconclusive", "inconclusive"],
    ["blocked", "skipped", "skipped"],
  ] as const)("expected %s, outcome %s: %s", (expected, outcome, status) => {
    expect(classifySubProbe(expected, outcome)).toBe(status);
  });
});

describe("classifyCell", () => {
  it("passes when nothing leaked and nothing is missing", () => {
    expect(classifyCell(evidence())).toBe("pass");
  });

  it("a leak wins over everything", () => {
    expect(
      classifyCell(
        evidence({
          leakedKeys: ["x"],
          missingKeys: ["y"],
          inconclusive: true,
          subProbes: [{ status: "escape" }],
        }),
      ),
    ).toBe("leak");
  });

  it("an escape wins over inconclusive and overblock", () => {
    expect(
      classifyCell(
        evidence({
          missingKeys: ["y"],
          subProbes: [{ status: "inconclusive" }, { status: "escape" }],
        }),
      ),
    ).toBe("escape");
  });

  it("inconclusive hides an overblock, from the reach probe or from a sub-probe", () => {
    expect(classifyCell(evidence({ missingKeys: ["y"], inconclusive: true }))).toBe("inconclusive");
    expect(classifyCell(evidence({ subProbes: [{ status: "inconclusive" }] }))).toBe(
      "inconclusive",
    );
  });

  it("only missing keys, or an overblocked sub-probe, is an overblock", () => {
    expect(classifyCell(evidence({ missingKeys: ["y"] }))).toBe("overblock");
    expect(classifyCell(evidence({ subProbes: [{ status: "overblock" }] }))).toBe("overblock");
  });

  it("a skipped sub-probe never turns a passing cell into skipped", () => {
    expect(
      classifyCell(evidence({ subProbes: [{ status: "skipped" }, { status: "skipped" }] })),
    ).toBe("pass");
  });
});

describe("classifyInsertCell", () => {
  it("is skipped only when every class was skipped", () => {
    expect(classifyInsertCell([{ status: "skipped" }, { status: "skipped" }])).toBe("skipped");
    expect(classifyInsertCell([{ status: "skipped" }, { status: "pass" }])).toBe("pass");
  });

  it("follows the cell precedence otherwise", () => {
    expect(classifyInsertCell([{ status: "overblock" }, { status: "escape" }])).toBe("escape");
    expect(classifyInsertCell([{ status: "overblock" }, { status: "inconclusive" }])).toBe(
      "inconclusive",
    );
    expect(classifyInsertCell([{ status: "overblock" }, { status: "pass" }])).toBe("overblock");
  });
});

describe("verdict", () => {
  const counts = (statuses: CellStatus[]): ReturnType<typeof countStatuses> =>
    countStatuses(statuses.map((status) => ({ status })));

  it("counts every status, zero included", () => {
    expect(counts(["pass", "pass", "leak"])).toEqual({
      pass: 2,
      leak: 1,
      escape: 0,
      overblock: 0,
      inconclusive: 0,
      skipped: 0,
    });
  });

  it("is ISOLATED with zero leaks and escapes and at least one measured cell", () => {
    expect(verdictOf(counts(["pass", "overblock", "inconclusive", "skipped"]))).toBe("ISOLATED");
    expect(verdictOf(counts(["overblock"]))).toBe("ISOLATED");
  });

  it("is LEAKING with a leak or an escape", () => {
    expect(verdictOf(counts(["pass", "leak"]))).toBe("LEAKING");
    expect(verdictOf(counts(["escape", "skipped"]))).toBe("LEAKING");
  });

  it("is NOT PROVEN without cells, or with only skipped and inconclusive cells", () => {
    expect(verdictOf(counts([]))).toBe("NOT PROVEN");
    expect(verdictOf(counts(["skipped", "inconclusive", "skipped"]))).toBe("NOT PROVEN");
  });

  it("ranks every status exactly once", () => {
    expect([...STATUS_SEVERITY].sort()).toEqual([...CELL_STATUSES].sort());
  });
});
