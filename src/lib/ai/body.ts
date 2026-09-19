/**
 * Reads the body of `POST /api/explain` without trusting the caller about its size (SEC-002):
 * the `Content-Length` header is checked first, then the bytes are counted while they arrive and
 * the read stops at the cap, so an oversized body is never buffered, decoded or parsed.
 */
import { z } from "zod";
import {
  EXPLAIN_PAYLOAD_MAX_BYTES,
  explainRequestSchema,
  type ExplainErrorCode,
  type ExplainRequest,
} from "./schema";

export type BodyFailure = {
  readonly ok: false;
  readonly status: 400 | 413 | 415;
  readonly code: Extract<
    ExplainErrorCode,
    "invalid_request" | "payload_too_large" | "unsupported_media_type"
  >;
  readonly message: string;
  /** Paths and zod messages. They name fields, never the values that were sent. */
  readonly issues?: readonly string[];
  /** Bytes read before the decision; for the log. */
  readonly bytes: number;
};

export type BodyResult =
  { readonly ok: true; readonly request: ExplainRequest; readonly bytes: number } | BodyFailure;

const contentLengthSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const contentTypeSchema = z.string().max(200);

const MAX_ISSUES = 20;
const MAX_ISSUE_LENGTH = 300;

function failure(
  status: BodyFailure["status"],
  code: BodyFailure["code"],
  message: string,
  bytes: number,
  issues?: readonly string[],
): BodyFailure {
  return issues === undefined
    ? { ok: false, status, code, message, bytes }
    : { ok: false, status, code, message, bytes, issues };
}

const tooLarge = (bytes: number): BodyFailure =>
  failure(
    413,
    "payload_too_large",
    `The request body is larger than ${EXPLAIN_PAYLOAD_MAX_BYTES} bytes.`,
    bytes,
  );

/** Reads at most `maxBytes`; `undefined` when the body is longer than that. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(text: string): { readonly value: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return undefined;
  }
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) =>
      `${issue.path.map(String).join(".") || "(body)"}: ${issue.message}`.slice(
        0,
        MAX_ISSUE_LENGTH,
      ),
    );
}

/** Media type, size by header, size by bytes, UTF-8, JSON, schema: in that order. */
export async function readExplainRequest(
  request: Request,
  maxBytes: number = EXPLAIN_PAYLOAD_MAX_BYTES,
): Promise<BodyResult> {
  const contentType = contentTypeSchema.safeParse(request.headers.get("content-type") ?? "");
  const mediaType = contentType.success ? contentType.data.split(";")[0]?.trim().toLowerCase() : "";
  if (mediaType !== "application/json") {
    return failure(415, "unsupported_media_type", "Send the request as application/json.", 0);
  }

  const declared = contentLengthSchema.safeParse(request.headers.get("content-length") ?? "");
  if (declared.success && declared.data > maxBytes) {
    return tooLarge(0);
  }
  if (request.body === null) {
    return failure(400, "invalid_request", "The request has no body.", 0);
  }

  const bytes = await readCapped(request.body, maxBytes);
  if (bytes === undefined) {
    return tooLarge(maxBytes);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure(400, "invalid_request", "The request body is not UTF-8.", bytes.byteLength);
  }
  const json = parseJson(text);
  if (json === undefined) {
    return failure(400, "invalid_request", "The request body is not JSON.", bytes.byteLength);
  }
  const parsed = explainRequestSchema.safeParse(json.value);
  if (!parsed.success) {
    return failure(
      400,
      "invalid_request",
      "The request does not have the expected shape.",
      bytes.byteLength,
      describeIssues(parsed.error),
    );
  }
  return { ok: true, request: parsed.data, bytes: bytes.byteLength };
}
