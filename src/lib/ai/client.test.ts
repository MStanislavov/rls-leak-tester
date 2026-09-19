import { describe, expect, it } from "vitest";

import {
  EXPLAIN_ENDPOINT,
  parsePartialExplanation,
  readExplanationResponse,
  requestExplanation,
} from "./client";
import type { ExplainRequest, Explanation, PartialExplanation } from "./schema";

const EXPLANATION: Explanation = {
  explanation: "The policy has no WITH CHECK.",
  rootCause: "WITH CHECK is missing.",
  proposedPolicySql: 'ALTER POLICY "p" ON "public"."t" WITH CHECK (true);',
  confidence: "medium",
};
const TEXT = JSON.stringify(EXPLANATION);
const REQUEST = { version: 1 } as unknown as ExplainRequest;

function streamed(chunks: readonly string[], failAtEnd = false): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (failAtEnd) {
        controller.error(new Error("connection lost"));
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

describe("readExplanationResponse", () => {
  it("reads a streamed answer and reports every parseable prefix", async () => {
    const partials: PartialExplanation[] = [];
    const chunks = [TEXT.slice(0, 20), TEXT.slice(20, 90), TEXT.slice(90)];

    const result = await readExplanationResponse(streamed(chunks), (partial) =>
      partials.push(partial),
    );

    expect(result).toEqual({ ok: true, explanation: EXPLANATION, cached: false });
    expect(partials).toHaveLength(3);
    expect(partials[0]).toEqual({ explanation: TEXT.slice(16, 20) });
    expect(partials[0]?.explanation).toBe("The ");
    expect(partials[2]).toEqual(EXPLANATION);
  });

  it("reads a cached answer, sent at once, with the same code", async () => {
    const response = new Response(TEXT, { headers: { "x-explain-cache": "hit" } });

    expect(await readExplanationResponse(response)).toEqual({
      ok: true,
      explanation: EXPLANATION,
      cached: true,
    });
  });

  it("keeps a multi-byte character that is split across two chunks", async () => {
    const text = JSON.stringify({ ...EXPLANATION, explanation: "naïve café" });
    const bytes = new TextEncoder().encode(text);
    const cut = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });

    const result = await readExplanationResponse(new Response(body));

    expect(result).toMatchObject({ ok: true, explanation: { explanation: "naïve café" } });
  });

  it.each([
    ["a stream that broke off", streamed([TEXT.slice(0, 40)], true)],
    ["text that ends early", streamed([TEXT.slice(0, 40)])],
    ["an object of another shape", new Response('{"verdict":"ISOLATED"}')],
    [
      "an object with an extra field",
      new Response(JSON.stringify({ ...EXPLANATION, verdict: "ISOLATED" })),
    ],
    ["an empty answer", new Response("")],
    ["no body", new Response(null)],
  ])("never accepts %s as an answer", async (_name, response) => {
    expect(await readExplanationResponse(response)).toMatchObject({
      ok: false,
      code: "invalid_response",
    });
  });

  it("reports a cancelled read as aborted", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("The user aborted a request.", "AbortError"));
      },
    });

    expect(await readExplanationResponse(new Response(body))).toMatchObject({
      ok: false,
      code: "aborted",
    });
  });

  it("maps an error answer to its code, message and Retry-After", async () => {
    const response = Response.json(
      { error: { code: "rate_limited", message: "Too many explanations requested." } },
      { status: 429, headers: { "Retry-After": "42" } },
    );

    expect(await readExplanationResponse(response)).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many explanations requested.",
      status: 429,
      retryAfterSeconds: 42,
    });
  });

  it("does not trust an error body it cannot validate", async () => {
    const html = new Response("<html>Bad gateway</html>", { status: 502 });
    const odd = Response.json({ error: { code: "made_up", message: "x" } }, { status: 500 });

    expect(await readExplanationResponse(html)).toMatchObject({
      ok: false,
      code: "invalid_response",
      status: 502,
      retryAfterSeconds: undefined,
    });
    expect(await readExplanationResponse(odd)).toMatchObject({ code: "invalid_response" });
  });
});

describe("parsePartialExplanation", () => {
  it("drops what is not valid yet instead of guessing", async () => {
    expect(await parsePartialExplanation("")).toEqual({});
    expect(await parsePartialExplanation("not json")).toEqual({});
    expect(await parsePartialExplanation('{"explanation":"a","confidence":"hi')).toEqual({
      explanation: "a",
    });
    expect(await parsePartialExplanation('{"explanation":5,"rootCause":"r"}')).toEqual({
      rootCause: "r",
    });
    expect(await parsePartialExplanation("[1,2]")).toEqual({});
  });
});

describe("requestExplanation", () => {
  it("posts the request as JSON and reads the answer", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(new Response(TEXT));
    };

    const result = await requestExplanation(REQUEST, { fetch: fakeFetch });

    expect(result).toMatchObject({ ok: true, explanation: EXPLANATION });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EXPLAIN_ENDPOINT);
    expect(calls[0]?.init).toMatchObject({ method: "POST", body: JSON.stringify(REQUEST) });
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("reports a network failure and a cancelled request without throwing", async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    const aborted = new AbortController();
    aborted.abort();

    expect(await requestExplanation(REQUEST, { fetch: offline })).toMatchObject({
      ok: false,
      code: "network",
    });
    expect(
      await requestExplanation(REQUEST, { fetch: offline, signal: aborted.signal }),
    ).toMatchObject({ ok: false, code: "aborted" });
  });
});
