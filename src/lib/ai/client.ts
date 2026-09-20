/**
 * The browser side of `/api/explain`: one reader for both answers the route gives, a streamed
 * one and a cached one, because both are the JSON text of an `Explanation` as `text/plain`.
 *
 * While the text arrives, `onPartial` gets whatever prefix of the object can be parsed. The
 * result is only `ok` when the COMPLETE text passes `explanationSchema` (SEC-002): a stream
 * that broke off is a failure, never half an answer.
 *
 * This module decides nothing about verdicts (AI-002). `proposedPolicySql` is a proposal: the UI
 * applies it to a copy of the scenario, re-runs the matrix, and only then may call it verified.
 */
import { parsePartialJson } from "ai";
import { z } from "zod";
import {
  CONFIDENCE_LEVELS,
  explainErrorSchema,
  explanationSchema,
  type ExplainErrorCode,
  type ExplainRequest,
  type Explanation,
  type PartialExplanation,
} from "./schema";

export const EXPLAIN_ENDPOINT = "/api/explain";

export type ExplainClientErrorCode =
  | ExplainErrorCode
  /** The request never got an answer: offline, blocked, DNS. */
  | "network"
  /** The caller's `AbortSignal` fired. */
  | "aborted"
  /** The answer ended early or is not a valid explanation. */
  | "invalid_response";

export type ExplainClientResult =
  | {
      readonly ok: true;
      readonly explanation: Explanation;
      /** True when the server answered from its cache: no model call was made. */
      readonly cached: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ExplainClientErrorCode;
      readonly message: string;
      readonly status: number | undefined;
      /** From `Retry-After`, for `rate_limited` and `unavailable`. */
      readonly retryAfterSeconds: number | undefined;
    };

export type PartialListener = (partial: PartialExplanation) => void;

export interface RequestExplanationOptions {
  readonly signal?: AbortSignal;
  readonly onPartial?: PartialListener;
  /** Test seam; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
}

/** A field that is not there yet, or not valid yet, is simply absent from the partial. */
const partialSchema = z.object({
  explanation: z.string().optional().catch(undefined),
  rootCause: z.string().optional().catch(undefined),
  proposedPolicySql: z.string().optional().catch(undefined),
  confidence: z.enum(CONFIDENCE_LEVELS).optional().catch(undefined),
});

const retryAfterSchema = z
  .string()
  .regex(/^\d{1,6}$/)
  .transform(Number);

function failed(
  code: ExplainClientErrorCode,
  message: string,
  status?: number,
  retryAfterSeconds?: number,
): ExplainClientResult {
  return { ok: false, code, message, status, retryAfterSeconds };
}

const INCOMPLETE = "The explanation arrived incomplete. Try again.";

/** Pure: the fields of a text prefix that can be shown already. */
export async function parsePartialExplanation(text: string): Promise<PartialExplanation> {
  const { value } = await parsePartialJson(text);
  const parsed = partialSchema.safeParse(value);
  if (!parsed.success) {
    return {};
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, field]) => field !== undefined));
}

async function readError(response: Response): Promise<ExplainClientResult> {
  const retryAfter = retryAfterSchema.safeParse(response.headers.get("retry-after") ?? "");
  const retryAfterSeconds = retryAfter.success ? retryAfter.data : undefined;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = explainErrorSchema.safeParse(body);
  if (!parsed.success) {
    return failed(
      "invalid_response",
      `The server answered ${response.status} without a readable reason.`,
      response.status,
      retryAfterSeconds,
    );
  }
  const { code, message } = parsed.data.error;
  return failed(code, message, response.status, retryAfterSeconds);
}

/** Reads one answer of the route, whichever kind it is. Never throws. */
export async function readExplanationResponse(
  response: Response,
  onPartial?: PartialListener,
): Promise<ExplainClientResult> {
  if (!response.ok) {
    return readError(response);
  }
  if (response.body === null) {
    return failed("invalid_response", INCOMPLETE, response.status);
  }

  let text = "";
  try {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      text += next.value;
      if (onPartial !== undefined) {
        onPartial(await parsePartialExplanation(text));
      }
    }
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError"
      ? failed("aborted", "The request was cancelled.", response.status)
      : failed("invalid_response", INCOMPLETE, response.status);
  }

  const { value, state } = await parsePartialJson(text);
  const parsed = explanationSchema.safeParse(state === "successful-parse" ? value : undefined);
  if (!parsed.success) {
    return failed("invalid_response", INCOMPLETE, response.status);
  }
  return {
    ok: true,
    explanation: parsed.data,
    cached: response.headers.get("x-explain-cache") === "hit",
  };
}

/** Sends a request built by `buildExplainRequest` and reads the answer. Never throws. */
export async function requestExplanation(
  request: ExplainRequest,
  options: RequestExplanationOptions = {},
): Promise<ExplainClientResult> {
  const send = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await send(options.endpoint ?? EXPLAIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain, application/json" },
      body: JSON.stringify(request),
      signal: options.signal ?? null,
    });
  } catch {
    return options.signal?.aborted === true
      ? failed("aborted", "The request was cancelled.")
      : failed("network", "The explanation service could not be reached.");
  }
  return readExplanationResponse(response, options.onPartial);
}
