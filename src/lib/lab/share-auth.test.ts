import { describe, expect, it } from "vitest";

import { authErrorMessage, currentReturnPath } from "./share-auth";

describe("authErrorMessage", () => {
  it.each(["not_configured", "missing_code", "provider_error", "exchange_failed"])(
    "has a sentence for %s",
    (code) => {
      const message = authErrorMessage(`?template=blank&auth_error=${code}`);
      expect(message).not.toBeNull();
      expect(message).not.toContain(code);
    },
  );

  it.each(["", "?template=blank", "?auth_error=", "?auth_error=%3Cscript%3E", "?auth_error=nope"])(
    "ignores %j",
    (search) => {
      expect(authErrorMessage(search)).toBeNull();
    },
  );
});

describe("currentReturnPath", () => {
  it("keeps the page and its query, without a stale sign-in error", () => {
    expect(currentReturnPath({ pathname: "/lab", search: "" })).toBe("/lab");
    expect(currentReturnPath({ pathname: "/lab", search: "?saved=mine-abc" })).toBe(
      "/lab?saved=mine-abc",
    );
    expect(
      currentReturnPath({ pathname: "/s/notes-abc", search: "?auth_error=exchange_failed" }),
    ).toBe("/s/notes-abc");
    expect(
      currentReturnPath({ pathname: "/lab", search: "?template=blank&auth_error=missing_code" }),
    ).toBe("/lab?template=blank");
  });
});
