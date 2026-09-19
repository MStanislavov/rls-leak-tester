import { describe, expect, it } from "vitest";
import {
  buildAssetCsp,
  buildDocumentCsp,
  buildDocumentCspDirectives,
  buildStaticSecurityHeaders,
  CspConfigError,
  generateNonce,
  serializeCsp,
} from "./csp";

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";

function directive(policy: string, name: string): string[] {
  const match = policy
    .split("; ")
    .map((part) => part.split(" "))
    .find(([head]) => head === name);
  if (!match) {
    throw new Error(`directive ${name} not found in: ${policy}`);
  }
  return match.slice(1);
}

describe("buildDocumentCsp (production)", () => {
  const policy = buildDocumentCsp({ nonce: NONCE, isDev: false });

  it("is exactly the documented production policy", () => {
    expect(policy).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'wasm-unsafe-eval'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
      ].join("; "),
    );
  });

  it("never allows eval or inline script", () => {
    const scriptSrc = directive(policy, "script-src");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  it("allows workers from the same origin and blob URLs only", () => {
    expect(directive(policy, "worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("forbids framing, plugins and foreign base URLs", () => {
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
  });
});

describe("buildDocumentCsp (development)", () => {
  const policy = buildDocumentCsp({ nonce: NONCE, isDev: true });

  it("adds 'unsafe-eval' for React's dev tooling and nothing else to script-src", () => {
    expect(directive(policy, "script-src")).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "'wasm-unsafe-eval'",
      "'unsafe-eval'",
    ]);
  });

  it("does not upgrade insecure requests on the plain-http dev server", () => {
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});

describe("connect-src extension", () => {
  it("appends validated origins after 'self' and removes duplicates", () => {
    const policy = buildDocumentCsp({
      nonce: NONCE,
      isDev: false,
      connectSrc: [
        "https://abc.supabase.co",
        "wss://abc.supabase.co",
        "https://abc.supabase.co",
        "https://*.example.com:8443",
      ],
    });
    expect(directive(policy, "connect-src")).toEqual([
      "'self'",
      "https://abc.supabase.co",
      "wss://abc.supabase.co",
      "https://*.example.com:8443",
    ]);
  });

  it.each([
    "https://evil.example; script-src *",
    "https://a.example https://b.example",
    "https://a.example,https://b.example",
    "'unsafe-inline'",
    "*",
    "https:",
    "http://plain.example",
    "https://host.example/path",
    "https://host.example\r\nX-Injected: 1",
    "",
  ])("rejects %j", (source) => {
    expect(() => buildDocumentCsp({ nonce: NONCE, isDev: false, connectSrc: [source] })).toThrow(
      CspConfigError,
    );
    expect(() => buildAssetCsp({ isDev: false, connectSrc: [source] })).toThrow(CspConfigError);
  });
});

describe("nonce handling", () => {
  it.each(["", "short", "has space in it 1234567", "abc';script-src*;'aaaaaaaaaa"])(
    "rejects the malformed nonce %j",
    (nonce) => {
      expect(() => buildDocumentCspDirectives({ nonce, isDev: false })).toThrow(CspConfigError);
    },
  );

  it("generates distinct, well-formed nonces", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(() => buildDocumentCsp({ nonce, isDev: false })).not.toThrow();
    }
  });
});

describe("buildAssetCsp", () => {
  it("is the nonce-free policy the PGlite worker script is served with", () => {
    expect(buildAssetCsp({ isDev: false })).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  });

  it("adds 'unsafe-eval' in development only", () => {
    expect(directive(buildAssetCsp({ isDev: true }), "script-src")).toContain("'unsafe-eval'");
    expect(directive(buildAssetCsp({ isDev: false }), "script-src")).not.toContain("'unsafe-eval'");
  });
});

describe("serializeCsp", () => {
  it("renders a directive without sources as a bare name", () => {
    expect(
      serializeCsp([
        ["default-src", ["'self'"]],
        ["upgrade-insecure-requests", []],
      ]),
    ).toBe("default-src 'self'; upgrade-insecure-requests");
  });
});

describe("buildStaticSecurityHeaders", () => {
  it("sets the four request-independent headers in every mode", () => {
    for (const isDev of [true, false]) {
      const headers = new Map(buildStaticSecurityHeaders({ isDev }).map((h) => [h.key, h.value]));
      expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(headers.get("X-Frame-Options")).toBe("DENY");
      expect(headers.get("Permissions-Policy")).toContain("camera=()");
    }
  });

  it("adds HSTS in production only", () => {
    const keys = (isDev: boolean) => buildStaticSecurityHeaders({ isDev }).map((h) => h.key);
    expect(keys(false)).toContain("Strict-Transport-Security");
    expect(keys(true)).not.toContain("Strict-Transport-Security");
  });
});
