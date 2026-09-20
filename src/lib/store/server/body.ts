/**
 * Reads and validates the body of a scenario write without trusting the caller about its size
 * (SEC-002): media type, `Content-Length`, bytes counted while they arrive, strict UTF-8, JSON,
 * the zod shape, and last `parseScenario`. Every failure is a `StoreError`; issues name fields,
 * never the values that were sent.
 */
import { z } from "zod";

import { parseScenario, type Scenario } from "@/lib/scenario";

import { StoreError, type StoreErrorIssue, type Visibility } from "../types";
import { createScenarioBodySchema, updateScenarioBodySchema } from "../wire";
import { SCENARIO_BODY_MAX_BYTES } from "./policy";

const contentLengthSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const contentTypeSchema = z.string().max(200);

const tooLarge = (maxBytes: number): StoreError =>
  new StoreError("too_large", `The request body is larger than ${maxBytes} bytes.`);

const invalid = (message: string, issues?: readonly StoreErrorIssue[]): StoreError =>
  new StoreError("invalid", message, { issues });

/** Decodes at most `maxBytes` of the stream; throws `too_large` as soon as there is more. */
async function readCappedText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = body.getReader();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw invalid("The request body is not UTF-8.");
  }
}

/** The JSON value of the body. Throws `invalid` or `too_large`. */
export async function readJsonBody(
  request: Request,
  maxBytes: number = SCENARIO_BODY_MAX_BYTES,
): Promise<unknown> {
  const contentType = contentTypeSchema.safeParse(request.headers.get("content-type") ?? "");
  const mediaType = contentType.success ? contentType.data.split(";")[0]?.trim().toLowerCase() : "";
  if (mediaType !== "application/json") {
    throw invalid("Send the request as application/json.");
  }
  const declared = contentLengthSchema.safeParse(request.headers.get("content-length") ?? "");
  if (declared.success && declared.data > maxBytes) throw tooLarge(maxBytes);
  if (request.body === null) throw invalid("The request has no body.");

  const text = await readCappedText(request.body, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid("The request body is not JSON.");
  }
}

function shapeIssues(error: z.ZodError): StoreErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(body)",
    message: issue.message,
  }));
}

function validScenario(value: unknown): Scenario {
  const parsed = parseScenario(value);
  if (parsed.ok) return parsed.scenario;
  throw invalid("The scenario is not valid and was not saved.", [
    ...parsed.issues.map((issue) => ({
      path: issue.path === "" ? "scenario" : `scenario.${issue.path}`,
      message: issue.message,
    })),
  ]);
}

export interface CreateScenarioInput {
  scenario: Scenario;
  visibility: Visibility;
}

export interface UpdateScenarioInput {
  scenario?: Scenario;
  visibility?: Visibility;
}

/** Pure: the JSON value of a `POST /api/scenarios` body, validated. Throws `invalid`. */
export function parseCreateScenarioBody(value: unknown): CreateScenarioInput {
  const body = createScenarioBodySchema.safeParse(value);
  if (!body.success) {
    throw invalid("The request does not have the expected shape.", shapeIssues(body.error));
  }
  return {
    scenario: validScenario(body.data.scenario),
    visibility: body.data.visibility ?? "private",
  };
}

/** Pure: the JSON value of a `PATCH /api/scenarios/[id]` body, validated. Throws `invalid`. */
export function parseUpdateScenarioBody(value: unknown): UpdateScenarioInput {
  const body = updateScenarioBodySchema.safeParse(value);
  if (!body.success) {
    throw invalid("The request does not have the expected shape.", shapeIssues(body.error));
  }
  const input: UpdateScenarioInput = {};
  if (body.data.scenario !== undefined) input.scenario = validScenario(body.data.scenario);
  if (body.data.visibility !== undefined) input.visibility = body.data.visibility;
  return input;
}
