import { describe, expect, it } from "vitest";

import { AUTH_ERROR_CODES, parseAuthErrorCode } from "./auth-errors";
import { authErrorSchema } from "./server/auth";

describe("parseAuthErrorCode", () => {
  it("accepts exactly the codes the callback's zod enum accepts", () => {
    expect(authErrorSchema.options).toEqual([...AUTH_ERROR_CODES]);
    for (const code of AUTH_ERROR_CODES) {
      expect(parseAuthErrorCode(code)).toBe(code);
    }
  });

  it.each([
    null,
    undefined,
    "",
    "nope",
    "EXCHANGE_FAILED",
    " exchange_failed",
    1,
    ["missing_code"],
  ])("answers null for %j", (value) => {
    expect(parseAuthErrorCode(value)).toBeNull();
    expect(authErrorSchema.safeParse(value).success).toBe(false);
  });
});
