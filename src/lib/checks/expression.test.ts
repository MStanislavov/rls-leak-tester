import { describe, expect, it } from "vitest";
import {
  compareCheckToUsing,
  flattenBoolean,
  isLiterallyTrue,
  readsUserMetadata,
  splitBoolean,
  stripOuterParens,
} from "./expression";

describe("stripOuterParens", () => {
  it.each([
    ["  ((a = 1))  ", "a = 1"],
    ["(a) AND (b)", "(a) AND (b)"],
    ["((a) AND (b))", "(a) AND (b)"],
    ["(')')", "')'"],
    ['("a)" = 1)', '"a)" = 1'],
    ["(a = 1", "(a = 1"],
    ["()", ""],
  ])("%s -> %s", (input, expected) => {
    expect(stripOuterParens(input)).toBe(expected);
  });
});

describe("isLiterallyTrue", () => {
  it.each(["true", "TRUE", " ( (true) ) ", "true::boolean", "(true)::bool", "'t'::boolean"])(
    "accepts %s",
    (expression) => {
      expect(isLiterallyTrue(expression)).toBe(true);
    },
  );

  it.each([
    "(1 = 1)",
    "(NOT false)",
    "(true IS TRUE)",
    "false",
    "is_public",
    "(true OR (a = 1))",
    "('true'::text = status)",
    "",
  ])("refuses %s: not the constant, and nothing is evaluated", (expression) => {
    expect(isLiterallyTrue(expression)).toBe(false);
  });

  it("refuses a missing expression", () => {
    expect(isLiterallyTrue(null)).toBe(false);
  });
});

describe("splitBoolean and flattenBoolean", () => {
  it("splits what Postgres prints for a nested AND, literals and BETWEEN included", () => {
    const printed =
      "(((tenant_id >= 1) AND (tenant_id <= 5)) AND (status = 'a and b'::text) AND is_public)";

    expect(splitBoolean(printed)).toEqual({
      operator: "AND",
      parts: ["(tenant_id >= 1) AND (tenant_id <= 5)", "status = 'a and b'::text", "is_public"],
    });
    expect(flattenBoolean(printed, "AND")).toEqual([
      "tenant_id >= 1",
      "tenant_id <= 5",
      "status = 'a and b'::text",
      "is_public",
    ]);
    expect(flattenBoolean(printed, "OR")).toEqual([
      "((tenant_id >= 1) AND (tenant_id <= 5)) AND (status = 'a and b'::text) AND is_public",
    ]);
  });

  it("does not look inside CASE, function calls, arrays, quoted identifiers or strings", () => {
    const expressions = [
      "\nCASE\n    WHEN (is_public AND (status = 'x'::text)) THEN true\n    ELSE false\nEND",
      "coalesce(a AND b, false)",
      "(flags = ARRAY[a AND b])",
      '("this AND that" = 1)',
      "(status = 'it''s this OR that'::text)",
      "(status = E'a\\' OR b'::text)",
    ];
    for (const expression of expressions) {
      expect(splitBoolean(expression).operator).toBeNull();
    }
  });

  it("collapses white space outside literals only", () => {
    expect(flattenBoolean("(a  =\n 1) AND (b = 'x  y')", "AND")).toEqual(["a = 1", "b = 'x  y'"]);
  });

  it("decides nothing for input it cannot read safely", () => {
    // Hand-written, never printed by Postgres: mixed operators, BETWEEN, broken nesting.
    expect(splitBoolean("a AND b OR c").operator).toBeNull();
    expect(splitBoolean("x BETWEEN 1 AND 5").operator).toBeNull();
    expect(splitBoolean("(a AND b").operator).toBeNull();
    expect(splitBoolean("a) AND (b").operator).toBeNull();
    expect(splitBoolean("a AND 'open").operator).toBeNull();
    expect(splitBoolean("a AND END").operator).toBeNull();
  });
});

describe("compareCheckToUsing", () => {
  const OWN = "(auth.uid() = user_id)";
  const OWN_AND_TENANT = "((auth.uid() = user_id) AND (tenant_id = 1))";

  it("never calls a missing WITH CHECK looser: Postgres applies USING to the new row", () => {
    expect(compareCheckToUsing(OWN, null)).toEqual({ looser: false });
    expect(compareCheckToUsing(null, null)).toEqual({ looser: false });
  });

  it("flags WITH CHECK (true) against a real USING", () => {
    expect(compareCheckToUsing(OWN_AND_TENANT, "true")).toEqual({
      looser: true,
      reason: "check-true",
      dropped: ["auth.uid() = user_id", "tenant_id = 1"],
      added: [],
    });
  });

  it("flags a check-only WITH CHECK (true): it loosens the other UPDATE policies", () => {
    expect(compareCheckToUsing(null, "true")).toMatchObject({
      looser: true,
      reason: "check-true-without-using",
    });
  });

  it("does not flag true against true, nor an identical or reordered check", () => {
    expect(compareCheckToUsing("true", "true")).toEqual({ looser: false });
    expect(compareCheckToUsing(OWN, OWN)).toEqual({ looser: false });
    expect(
      compareCheckToUsing(OWN_AND_TENANT, "((tenant_id = 1) AND (auth.uid() = user_id))"),
    ).toEqual({ looser: false });
  });

  it("does not flag an OR-ed USING whose alternatives the check repeats in another order", () => {
    expect(
      compareCheckToUsing(
        "((auth.uid() = user_id) OR is_public)",
        "(is_public OR (auth.uid() = user_id))",
      ),
    ).toEqual({ looser: false });
  });

  it("flags a check that drops AND-ed conditions of USING", () => {
    expect(compareCheckToUsing(OWN_AND_TENANT, OWN)).toEqual({
      looser: true,
      reason: "drops-conditions",
      dropped: ["tenant_id = 1"],
      added: [],
    });
  });

  it("flags a check that adds OR alternatives to USING or to a part of it", () => {
    expect(compareCheckToUsing(OWN, `(${OWN} OR is_public)`)).toEqual({
      looser: true,
      reason: "adds-alternatives",
      dropped: [],
      added: ["is_public"],
    });
    expect(compareCheckToUsing(OWN_AND_TENANT, `(${OWN} OR is_public)`)).toEqual({
      looser: true,
      reason: "adds-alternatives",
      dropped: ["tenant_id = 1"],
      added: ["is_public"],
    });
    expect(
      compareCheckToUsing(`(${OWN} OR is_public)`, `(${OWN} OR is_public OR is_demo)`),
    ).toEqual({ looser: true, reason: "adds-alternatives", dropped: [], added: ["is_demo"] });
  });

  it("does not guess: stricter, unrelated or merely different conditions are left alone", () => {
    expect(compareCheckToUsing(OWN, OWN_AND_TENANT)).toEqual({ looser: false });
    expect(compareCheckToUsing("(tenant_id = 1)", "(tenant_id > 0)")).toEqual({ looser: false });
    expect(compareCheckToUsing(`(${OWN} OR is_public)`, OWN)).toEqual({ looser: false });
    expect(compareCheckToUsing(`(${OWN} OR is_public)`, `(${OWN} OR is_demo)`)).toEqual({
      looser: false,
    });
    expect(compareCheckToUsing(null, OWN)).toEqual({ looser: false });
    expect(compareCheckToUsing("true", OWN)).toEqual({ looser: false });
  });
});

describe("readsUserMetadata", () => {
  it.each([
    "(((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text) = 'admin'::text)",
    "((auth.jwt() #>> '{user_metadata,role}'::text[]) = 'admin'::text)",
    "((((current_setting('request.jwt.claims'::text, true))::jsonb -> 'user_metadata'::text) ->> 'role'::text) = 'admin'::text)",
    'jsonb_path_exists(auth.jwt(), \'$."user_metadata"."admin"\'::jsonpath)',
    "(EXISTS ( SELECT 1 FROM auth.users u WHERE ((u.raw_user_meta_data ->> 'role'::text) = 'admin'::text)))",
    '(( SELECT u."raw_user_meta_data" FROM auth.users u) IS NOT NULL)',
  ])("sees %s", (expression) => {
    expect(readsUserMetadata(expression)).toBe(true);
  });

  it.each([
    "(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)",
    "((user_metadata ->> 'visible'::text) = 'yes'::text)",
    "((auth.jwt() ->> 'user_metadata_version'::text) = '2'::text)",
    "(my_raw_user_meta_data IS NOT NULL)",
    "(auth.uid() = user_id)",
  ])("leaves %s alone", (expression) => {
    expect(readsUserMetadata(expression)).toBe(false);
  });

  it("leaves a missing expression alone", () => {
    expect(readsUserMetadata(null)).toBe(false);
  });
});
