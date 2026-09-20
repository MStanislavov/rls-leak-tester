/**
 * The bucket of the per-address rate limit. What matters: a caller must not be able to choose
 * it, so nothing the caller can write into `X-Forwarded-For` may win over the hop the proxy
 * in front of the app appended.
 */
import { describe, expect, it } from "vitest";

import { UNKNOWN_CLIENT, clientAddress } from "./client-address";

function address(headers: Record<string, string>): string {
  return clientAddress(new Headers(headers));
}

describe("clientAddress", () => {
  it("takes the hop the trusted proxy appended, never one the caller sent", () => {
    // What nginx ($proxy_add_x_forwarded_for), an ALB or Cloudflare forward when the caller
    // sends its own X-Forwarded-For: "spoofed, real".
    expect(address({ "x-forwarded-for": "10.0.0.1, 198.51.100.9" })).toBe("198.51.100.9");
    expect(address({ "x-forwarded-for": "10.0.0.2,198.51.100.9" })).toBe("198.51.100.9");
    expect(address({ "x-forwarded-for": "a, b, 1.1.1.1 ,  2001:db8::9  " })).toBe("2001:db8::9");
  });

  it("reads a header the platform overwrote (one hop)", () => {
    expect(address({ "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
    expect(address({ "x-forwarded-for": "2001:DB8::1" })).toBe("2001:db8::1");
  });

  it("joins repeated headers the way the Fetch API does and still takes the last hop", () => {
    const headers = new Headers();
    headers.append("x-forwarded-for", "10.9.9.9");
    headers.append("x-forwarded-for", "198.51.100.9");

    expect(clientAddress(headers)).toBe("198.51.100.9");
  });

  it("does not fall back to a hop or a header the caller controls", () => {
    // The last hop is not an address: one shared bucket, not the hop before it.
    expect(address({ "x-forwarded-for": "10.0.0.1, <script>" })).toBe(UNKNOWN_CLIENT);
    expect(address({ "x-forwarded-for": "10.0.0.1," })).toBe(UNKNOWN_CLIENT);
    // X-Real-IP and X-Vercel-Forwarded-For are set by some platforms only; behind any other
    // proxy the caller writes them, so they never win over X-Forwarded-For.
    const spoofed = {
      "x-forwarded-for": "198.51.100.9",
      "x-real-ip": "10.0.0.1",
      "x-vercel-forwarded-for": "10.0.0.2",
    };
    expect(address(spoofed)).toBe("198.51.100.9");
    expect(address({ "x-vercel-forwarded-for": "10.0.0.2" })).toBe(UNKNOWN_CLIENT);
  });

  it("uses X-Real-IP only when there is no X-Forwarded-For at all", () => {
    expect(address({ "x-real-ip": "2001:db8::1" })).toBe("2001:db8::1");
    expect(address({ "x-real-ip": " 203.0.113.7 " })).toBe("203.0.113.7");
  });

  it("drops a port, which the caller chooses, so one address stays one bucket", () => {
    expect(address({ "x-forwarded-for": "203.0.113.7:51234" })).toBe("203.0.113.7");
    expect(address({ "x-forwarded-for": "[2001:db8::1]:51234" })).toBe("2001:db8::1");
    expect(address({ "x-forwarded-for": "[2001:db8::1]" })).toBe("2001:db8::1");
  });

  it("puts everything that is no address in one bucket, which is the strict choice", () => {
    for (const value of ["<script>", "unknown", "", " ", "x".repeat(46), "1", "[::1", "::1]:80"]) {
      expect(address({ "x-forwarded-for": value })).toBe(UNKNOWN_CLIENT);
    }
    expect(clientAddress(new Headers())).toBe(UNKNOWN_CLIENT);
  });
});
