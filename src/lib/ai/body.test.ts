import { describe, expect, it } from "vitest";

import { readExplainRequest } from "./body";

function request(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/explain", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body,
  });
}

describe("readExplainRequest", () => {
  it("stops reading at the cap when the body arrives in pieces without a length", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64).fill(0x20));
      },
    });
    const streaming = new Request("http://localhost/api/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Node's fetch needs this for a streamed request body.
      duplex: "half",
    } as RequestInit);

    const result = await readExplainRequest(streaming, 1_000);

    expect(result).toMatchObject({ ok: false, status: 413, code: "payload_too_large" });
    expect(pulled).toBeLessThan(40);
  });

  it("does not believe a Content-Length that understates the body", async () => {
    const result = await readExplainRequest(
      request(JSON.stringify({ padding: "x".repeat(500) }), { "content-length": "10" }),
      100,
    );

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("ignores a Content-Length that is not a number", async () => {
    const result = await readExplainRequest(request("{}", { "content-length": "many" }));

    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
  });

  it("refuses a request without a body, bytes that are not UTF-8, and a missing media type", async () => {
    expect(await readExplainRequest(request(null))).toMatchObject({
      ok: false,
      status: 400,
      message: "The request has no body.",
    });
    expect(await readExplainRequest(request(new Uint8Array([0xff, 0xfe, 0xfd])))).toMatchObject({
      ok: false,
      status: 400,
      message: "The request body is not UTF-8.",
    });
    const bare = new Request("http://localhost/api/explain", { method: "POST", body: "{}" });
    bare.headers.delete("content-type");
    expect(await readExplainRequest(bare)).toMatchObject({ ok: false, status: 415 });
  });

  it("lists at most twenty issues, as paths and messages", async () => {
    const result = await readExplainRequest(request(JSON.stringify({ version: 2, extra: "v" })));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues?.length).toBeGreaterThan(3);
      expect(result.issues?.length).toBeLessThanOrEqual(20);
      expect(result.issues?.some((issue) => issue.startsWith("version: "))).toBe(true);
      expect(result.issues?.some((issue) => issue.includes("extra"))).toBe(true);
      expect(result.bytes).toBe(JSON.stringify({ version: 2, extra: "v" }).length);
    }
  });
});
