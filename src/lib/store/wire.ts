/**
 * The JSON that travels between the browser and `/api/scenarios`, as zod schemas. The routes
 * build their answers from these shapes and the remote store parses every answer with them
 * (SEC-002). No server-only import here: this module is part of the client bundle.
 */
import { z } from "zod";

import { MAX_TITLE_LENGTH, parseScenario, type Scenario } from "@/lib/scenario";

import { STORE_ERROR_CODES, VISIBILITIES } from "./types";

export const SCENARIOS_API_PATH = "/api/scenarios";

export const visibilitySchema = z.enum(VISIBILITIES);

/** The same rule as the `scenarios_slug_format` check constraint of the migration. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 64;

export const slugSchema = z.string().min(MIN_SLUG_LENGTH).max(MAX_SLUG_LENGTH).regex(SLUG_PATTERN);
/** A row id of the Supabase store. */
export const remoteIdSchema = z.uuid();

/** Any JSON value in, a validated `Scenario` out: `parseScenario` with its issues and paths. */
export const scenarioFieldSchema = z.unknown().transform((value, ctx): Scenario => {
  const parsed = parseScenario(value);
  if (parsed.ok) return parsed.scenario;
  for (const issue of parsed.issues) {
    ctx.addIssue({ code: "custom", message: issue.message, params: { scenarioPath: issue.path } });
  }
  return z.NEVER;
});

const summaryShape = {
  id: remoteIdSchema,
  slug: slugSchema,
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  visibility: visibilitySchema,
  updatedAt: z.iso.datetime(),
};

export const storedScenarioSummarySchema = z.object(summaryShape);
export const storedScenarioSchema = z.object({
  ...summaryShape,
  scenario: scenarioFieldSchema,
  ownedByMe: z.boolean(),
});

/** `GET /api/scenarios` */
export const scenarioListResponseSchema = z.object({
  scenarios: z.array(storedScenarioSummarySchema),
});
/** `POST /api/scenarios`, `GET|PATCH /api/scenarios/[id]`, `GET /api/scenarios/by-slug/[slug]` */
export const scenarioResponseSchema = z.object({ scenario: storedScenarioSchema });

const MAX_ISSUES = 50;

/** Every answer that is not a success. `issues` name fields, never the values that were sent. */
export const storeErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(STORE_ERROR_CODES),
    message: z.string().max(1000),
    issues: z
      .array(z.object({ path: z.string().max(300), message: z.string().max(500) }))
      .max(MAX_ISSUES)
      .optional(),
  }),
});
export type StoreErrorBody = z.infer<typeof storeErrorBodySchema>;

/** `POST /api/scenarios` */
export const createScenarioBodySchema = z.strictObject({
  scenario: z.unknown(),
  visibility: visibilitySchema.optional(),
});
/** `PATCH /api/scenarios/[id]`: the scenario, the visibility, or both. */
export const updateScenarioBodySchema = z
  .strictObject({ scenario: z.unknown().optional(), visibility: visibilitySchema.optional() })
  .refine((body) => body.scenario !== undefined || body.visibility !== undefined, {
    error: "Send a scenario, a visibility, or both",
  });
