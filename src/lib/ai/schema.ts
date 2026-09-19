/**
 * The two boundaries of `/api/explain` (brief 3.7, rules.yaml SEC-002): what the browser may send
 * and what the model may answer. Shared by the route, the client helper and the request builder.
 *
 * The request is the minimum: one table's DDL, its policies, one persona's role and claims, the
 * operation, capped samples of the expected and actual keys, and the static findings on that
 * table. Every object is strict, so a field that is not listed here (`seedSql`, `schemaSql`, a
 * whole scenario) is refused rather than silently forwarded to the model.
 */
import { z } from "zod";

/** `thresholds.ai.explain_payload_max_bytes` in rules.yaml: bytes of the request body. */
export const EXPLAIN_PAYLOAD_MAX_BYTES = 30_720;
export const EXPLAIN_REQUEST_VERSION = 1;

/** Keys per list. The totals travel beside the samples, so the model knows what was cut. */
export const MAX_KEY_SAMPLE = 20;
export const MAX_KEY_LENGTH = 300;
export const MAX_POLICIES = 40;
export const MAX_FINDINGS = 12;
export const MAX_FINDING_EVIDENCE = 8;
export const MAX_SUB_PROBES = 8;
export const MAX_GRANTS = 16;
export const MAX_DDL_LENGTH = 12_000;
export const MAX_EXPRESSION_LENGTH = 4_000;
export const MAX_STATEMENT_LENGTH = 2_000;
export const MAX_EXPECTED_ROWS_SQL_LENGTH = 10_000;
export const MAX_CLAIMS_LENGTH = 4_200;

/** The statuses Explain is offered on: failures the engine proved. */
export const FAILING_STATUSES = ["leak", "escape", "overblock"] as const;
export type FailingStatus = (typeof FAILING_STATUSES)[number];

const name = z.string().min(1).max(128);
const shortText = z.string().max(500);

const probeFailureSchema = z.strictObject({
  sqlState: z.string().max(5).nullable(),
  message: z.string().max(1_000),
});

const keyListSchema = z.strictObject({
  /** How many keys the engine saw; `sample` holds at most `MAX_KEY_SAMPLE` of them. */
  total: z.number().int().min(0).max(10_000_000),
  sample: z.array(z.string().max(MAX_KEY_LENGTH)).max(MAX_KEY_SAMPLE),
});

const subProbeSchema = z.strictObject({
  kind: z.enum([
    "escape-targeted",
    "escape-bulk",
    "insert-own",
    "insert-same-tenant",
    "insert-other",
    "insert-in-scope",
    "insert-out-of-scope",
  ]),
  expected: z.enum(["allowed", "blocked"]),
  outcome: z.enum(["allowed", "blocked", "inconclusive", "skipped"]),
  status: z.enum(["pass", "escape", "overblock", "inconclusive", "skipped"]),
  reason: shortText.nullable(),
  error: probeFailureSchema.nullable(),
});

const policySchema = z.strictObject({
  name,
  command: z.enum(["all", "select", "insert", "update", "delete"]),
  permissive: z.boolean(),
  roles: z.array(name).max(32),
  using: z.string().max(MAX_EXPRESSION_LENGTH).nullable(),
  withCheck: z.string().max(MAX_EXPRESSION_LENGTH).nullable(),
  /** How the engine used the policy for this cell; `none`: another role or command. */
  appliesAs: z.enum(["command", "visibility", "none"]),
});

const findingSchema = z.strictObject({
  id: z.string().regex(/^RLS\d{3}$/),
  severity: z.enum(["critical", "high", "medium", "info"]),
  title: shortText,
  object: shortText,
  explanation: z.string().max(1_500),
  evidence: z
    .array(z.strictObject({ label: z.string().max(80), value: z.string().max(1_000) }))
    .max(MAX_FINDING_EVIDENCE),
});

export const explainRequestSchema = z.strictObject({
  version: z.literal(EXPLAIN_REQUEST_VERSION),
  mode: z.enum(["supabase", "postgres"]),
  cell: z.strictObject({
    operation: z.enum(["select", "insert", "update", "delete"]),
    status: z.enum(FAILING_STATUSES),
    scope: z.enum(["none", "own", "tenant", "all", "custom"]),
    expectationSource: z.enum(["explicit", "default"]),
    /** Only for the `custom` scope: the query that defines the rows the persona should reach. */
    expectedRowsSql: z.string().max(MAX_EXPECTED_ROWS_SQL_LENGTH).nullable(),
    reason: shortText.nullable(),
    /** The bare reach statement. It holds no row values; insert cells have none. */
    statement: z.string().max(MAX_STATEMENT_LENGTH),
    perRowFallback: z.boolean(),
    error: probeFailureSchema.nullable(),
    rlsBypass: z.enum(["superuser", "bypassrls", "table-owner", "rls-disabled"]).nullable(),
    subProbes: z.array(subProbeSchema).max(MAX_SUB_PROBES),
  }),
  table: z.strictObject({
    schema: name,
    name,
    /** Rendered from the catalog: columns, types, defaults, primary key, RLS switches. */
    ddl: z.string().min(1).max(MAX_DDL_LENGTH),
    owner: name,
    rlsEnabled: z.boolean(),
    rlsForced: z.boolean(),
    ownerColumn: name.nullable(),
    tenantColumn: name.nullable(),
    /** Table privileges the persona's role holds, directly, by membership or through PUBLIC. */
    grants: z.array(z.string().max(32)).max(MAX_GRANTS),
  }),
  policies: z.array(policySchema).max(MAX_POLICIES),
  persona: z.strictObject({
    dbRole: name,
    /** The claims the probe ran with, as JSON text. Data, never instructions. */
    claimsJson: z.string().max(MAX_CLAIMS_LENGTH),
    tenantClaimPath: z.string().max(200).nullable(),
  }),
  keys: z.strictObject({
    expected: keyListSchema,
    actual: keyListSchema,
    leaked: keyListSchema,
    missing: keyListSchema,
    blind: keyListSchema,
  }),
  findings: z.array(findingSchema).max(MAX_FINDINGS),
});

export type ExplainRequest = z.infer<typeof explainRequestSchema>;
export type ExplainKeyList = z.infer<typeof keyListSchema>;
export type ExplainFinding = z.infer<typeof findingSchema>;

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const MAX_EXPLANATION_LENGTH = 8_000;
export const MAX_ROOT_CAUSE_LENGTH = 2_000;
export const MAX_POLICY_SQL_LENGTH = 10_000;

/**
 * What the model is asked for. No length limits here: the provider's structured output mode
 * supports only part of JSON Schema, and the limits are enforced by `explanationSchema` below.
 * There is no verdict field on purpose (rules.yaml AI-002).
 */
export const explanationModelSchema = z.object({
  explanation: z
    .string()
    .describe(
      "Plain text, a few short paragraphs: why the proven failure happens, walking through the policies, grants and claims that were given.",
    ),
  rootCause: z
    .string()
    .describe("One or two sentences naming the policy, grant or setting at fault."),
  proposedPolicySql: z
    .string()
    .describe(
      "SQL that can be appended to the schema to fix the failure: DROP POLICY IF EXISTS / CREATE POLICY / ALTER TABLE / GRANT / REVOKE statements only, schema-qualified. An empty string when no SQL change can be proposed.",
    ),
  confidence: z
    .enum(CONFIDENCE_LEVELS)
    .describe("How sure you are that the proposed SQL fixes the failure without side effects."),
});

/** The validated answer: what is cached, and what the client accepts. */
export const explanationSchema = z.strictObject({
  explanation: z.string().trim().min(1).max(MAX_EXPLANATION_LENGTH),
  rootCause: z.string().trim().min(1).max(MAX_ROOT_CAUSE_LENGTH),
  proposedPolicySql: z.string().max(MAX_POLICY_SQL_LENGTH),
  confidence: z.enum(CONFIDENCE_LEVELS),
});

export type Explanation = z.infer<typeof explanationSchema>;
/** What the client sees while the answer streams: any prefix of the object. */
export type PartialExplanation = Partial<Explanation>;

export const EXPLAIN_ERROR_CODES = [
  "invalid_request",
  "payload_too_large",
  "unsupported_media_type",
  "not_configured",
  "rate_limited",
  "unavailable",
  "model_failed",
] as const;
export type ExplainErrorCode = (typeof EXPLAIN_ERROR_CODES)[number];

/** Every non-streaming answer of the route. `issues` name paths, never values. */
export const explainErrorSchema = z.object({
  error: z.object({
    code: z.enum(EXPLAIN_ERROR_CODES),
    message: z.string().max(500),
    issues: z.array(z.string().max(300)).max(20).optional(),
  }),
});
export type ExplainErrorBody = z.infer<typeof explainErrorSchema>;

/** Pure: bytes of `text` as UTF-8, which is what the payload cap counts. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
