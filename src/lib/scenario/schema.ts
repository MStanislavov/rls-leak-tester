/**
 * zod schemas of the scenario model and `parseScenario`, the one door every load path uses
 * (SEC-002): templates, localStorage, the share store, the fork link and the export.
 */
import { z } from "zod";

import { isUuid } from "./claims";
import { ID_PATTERN } from "./ids";
import {
  MAX_CLAIM_PATH_LENGTH,
  MAX_CLAIMS_DEPTH,
  MAX_CLAIMS_JSON_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXPECTATIONS,
  MAX_EXPECTED_ROWS_SQL_LENGTH,
  MAX_EXPOSED_SCHEMAS,
  MAX_ID_LENGTH,
  MAX_IDENTIFIER_BYTES,
  MAX_LABEL_LENGTH,
  MAX_PERSONAS,
  MAX_SCENARIO_JSON_LENGTH,
  MAX_SQL_LENGTH,
  MAX_TABLES,
  MAX_TITLE_LENGTH,
} from "./limits";
import {
  MODES,
  OPERATIONS,
  SCENARIO_VERSION,
  SCOPES,
  SUPABASE_GRANT_REGIMES,
  SUPABASE_ROLES,
  type Expectation,
  type Persona,
  type Scenario,
  type ScenarioOptions,
  type TableConfig,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

const idSchema = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_ID_LENGTH, `must be at most ${MAX_ID_LENGTH} characters`)
  .regex(ID_PATTERN, "may contain only letters, digits, '-' and '_', and must start with one");

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A schema, table, column or role name exactly as the catalog spells it (never quoted). */
const identifierSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((value) => !value.includes("\0"), "must not contain a NUL character")
  .refine(
    (value) => utf8Length(value) <= MAX_IDENTIFIER_BYTES,
    `must be at most ${MAX_IDENTIFIER_BYTES} bytes, the longest name Postgres keeps`,
  );

function sqlSchema(max: number) {
  return z
    .string()
    .max(max, `must be at most ${max} characters`)
    .refine((value) => !value.includes("\0"), "must not contain a NUL character");
}

function jsonDepth(value: unknown, limit: number): number {
  if (typeof value !== "object" || value === null || limit === 0) {
    return 0;
  }
  let deepest = 0;
  for (const item of Object.values(value)) {
    deepest = Math.max(deepest, jsonDepth(item, limit - 1));
  }
  return deepest + 1;
}

function isJsonValue(value: unknown, depthLeft: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || depthLeft === 0) {
    return false;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item, depthLeft - 1));
}

const claimsSchema = z.record(z.string(), z.unknown()).superRefine((claims, ctx) => {
  if (jsonDepth(claims, MAX_CLAIMS_DEPTH + 1) > MAX_CLAIMS_DEPTH) {
    ctx.addIssue({
      code: "custom",
      message: `must not nest deeper than ${MAX_CLAIMS_DEPTH} levels`,
    });
    return;
  }
  if (!isJsonValue(claims, MAX_CLAIMS_DEPTH)) {
    ctx.addIssue({
      code: "custom",
      message: "must be plain JSON: strings, finite numbers, booleans, null, arrays and objects",
    });
    return;
  }
  if (JSON.stringify(claims).length > MAX_CLAIMS_JSON_LENGTH) {
    ctx.addIssue({
      code: "custom",
      message: `must be at most ${MAX_CLAIMS_JSON_LENGTH} characters as JSON`,
    });
  }
});

const claimPathSchema = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_CLAIM_PATH_LENGTH, `must be at most ${MAX_CLAIM_PATH_LENGTH} characters`)
  .refine(
    (path) => path.split(".").every((segment) => segment.length > 0),
    "must be a dot path such as tenant_id or app_metadata.tenant_id, without empty segments",
  );

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

export const modeSchema = z.enum(MODES);
export const operationSchema = z.enum(OPERATIONS);
export const scopeSchema = z.enum(SCOPES);

export const personaSchema = z.strictObject({
  id: idSchema,
  label: z
    .string()
    .min(1, "must not be empty")
    .max(MAX_LABEL_LENGTH, `must be at most ${MAX_LABEL_LENGTH} characters`),
  dbRole: identifierSchema,
  claims: claimsSchema,
  tenantClaimPath: claimPathSchema.optional(),
});

export const tableConfigSchema = z.strictObject({
  schema: identifierSchema,
  name: identifierSchema,
  ownerColumn: identifierSchema.optional(),
  tenantColumn: identifierSchema.optional(),
});

export const expectationSchema = z
  .strictObject({
    personaId: idSchema,
    schema: identifierSchema,
    table: identifierSchema,
    operation: operationSchema,
    scope: scopeSchema,
    expectedRowsSql: sqlSchema(MAX_EXPECTED_ROWS_SQL_LENGTH).optional(),
  })
  .superRefine((expectation, ctx) => {
    const hasSql =
      expectation.expectedRowsSql !== undefined && expectation.expectedRowsSql.trim().length > 0;
    if (expectation.scope === "custom" && !hasSql) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedRowsSql"],
        message:
          "is required when scope is 'custom': a query that returns the primary keys this persona should reach",
      });
    }
    if (expectation.scope !== "custom" && expectation.expectedRowsSql !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedRowsSql"],
        message: `is only allowed when scope is 'custom', not '${expectation.scope}'`,
      });
    }
  });

export const DEFAULT_EXPOSED_SCHEMAS: readonly string[] = ["public"];
export const DEFAULT_SUPABASE_GRANTS = "legacy";

export const scenarioOptionsSchema = z.strictObject({
  exposedSchemas: z
    .array(identifierSchema)
    .min(1, "must name at least one schema")
    .max(MAX_EXPOSED_SCHEMAS, `must have at most ${MAX_EXPOSED_SCHEMAS} schemas`)
    .refine((schemas) => new Set(schemas).size === schemas.length, "must not repeat a schema")
    .default(() => [...DEFAULT_EXPOSED_SCHEMAS]),
  supabaseGrants: z.enum(SUPABASE_GRANT_REGIMES).default(DEFAULT_SUPABASE_GRANTS),
});

type Ctx = z.core.$RefinementCtx<unknown>;

function cellKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function checkPersonas(scenario: Pick<Scenario, "mode" | "personas">, ctx: Ctx): void {
  const seen = new Set<string>();
  scenario.personas.forEach((persona, index) => {
    if (seen.has(persona.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["personas", index, "id"],
        message: `duplicate persona id '${persona.id}'`,
      });
    }
    seen.add(persona.id);
    if (scenario.mode === "supabase") {
      checkSupabasePersona(persona, index, ctx);
    }
  });
}

function checkSupabasePersona(persona: Persona, index: number, ctx: Ctx): void {
  const roles: readonly string[] = SUPABASE_ROLES;
  if (!roles.includes(persona.dbRole)) {
    ctx.addIssue({
      code: "custom",
      path: ["personas", index, "dbRole"],
      message: `in supabase mode the role must be one of ${SUPABASE_ROLES.join(", ")}; custom roles need postgres mode`,
    });
  }
  const sub = persona.claims.sub;
  if (sub === undefined) {
    if (persona.dbRole === "authenticated") {
      ctx.addIssue({
        code: "custom",
        path: ["personas", index, "claims", "sub"],
        message: "an authenticated persona needs a 'sub' claim: the user's uuid",
      });
    }
    return;
  }
  if (!isUuid(sub)) {
    ctx.addIssue({
      code: "custom",
      path: ["personas", index, "claims", "sub"],
      message:
        "in supabase mode 'sub' must be a uuid such as 00000000-0000-0000-0000-000000000001, because auth.uid() casts it to uuid and fails with SQLSTATE 22P02 otherwise",
    });
  }
}

function checkTables(scenario: Pick<Scenario, "tables">, ctx: Ctx): void {
  const seen = new Set<string>();
  scenario.tables.forEach((table, index) => {
    const key = cellKey([table.schema, table.name]);
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["tables", index],
        message: `duplicate table config for ${table.schema}.${table.name}`,
      });
    }
    seen.add(key);
  });
}

function checkExpectations(scenario: Pick<Scenario, "personas" | "expectations">, ctx: Ctx): void {
  const personaIds = new Set(scenario.personas.map((persona) => persona.id));
  const seen = new Set<string>();
  scenario.expectations.forEach((expectation, index) => {
    if (!personaIds.has(expectation.personaId)) {
      ctx.addIssue({
        code: "custom",
        path: ["expectations", index, "personaId"],
        message: `unknown persona '${expectation.personaId}'`,
      });
    }
    const key = cellKey([
      expectation.personaId,
      expectation.schema,
      expectation.table,
      expectation.operation,
    ]);
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["expectations", index],
        message: `duplicate expectation for persona '${expectation.personaId}', ${expectation.schema}.${expectation.table}, ${expectation.operation}`,
      });
    }
    seen.add(key);
  });
}

export const scenarioSchema = z
  .strictObject({
    id: idSchema,
    version: z.literal(SCENARIO_VERSION),
    title: z
      .string()
      .min(1, "must not be empty")
      .max(MAX_TITLE_LENGTH, `must be at most ${MAX_TITLE_LENGTH} characters`),
    description: z
      .string()
      .max(MAX_DESCRIPTION_LENGTH, `must be at most ${MAX_DESCRIPTION_LENGTH} characters`),
    mode: modeSchema,
    schemaSql: sqlSchema(MAX_SQL_LENGTH),
    seedSql: sqlSchema(MAX_SQL_LENGTH),
    personas: z
      .array(personaSchema)
      .max(MAX_PERSONAS, `must have at most ${MAX_PERSONAS} personas`),
    tables: z.array(tableConfigSchema).max(MAX_TABLES, `must have at most ${MAX_TABLES} tables`),
    expectations: z
      .array(expectationSchema)
      .max(MAX_EXPECTATIONS, `must have at most ${MAX_EXPECTATIONS} expectations`),
    options: scenarioOptionsSchema.optional(),
  })
  .superRefine((scenario, ctx) => {
    checkPersonas(scenario, ctx);
    checkTables(scenario, ctx);
    checkExpectations(scenario, ctx);
  });

// ---------------------------------------------------------------------------------------------
// The schemas and the types in types.ts are the same thing, checked at compile time
// ---------------------------------------------------------------------------------------------

type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? SameKeys<A, B> : false) : false;

export const SCHEMAS_MATCH_TYPES: {
  persona: Same<z.infer<typeof personaSchema>, Persona>;
  tableConfig: Same<z.infer<typeof tableConfigSchema>, TableConfig>;
  expectation: Same<z.infer<typeof expectationSchema>, Expectation>;
  options: Same<z.infer<typeof scenarioOptionsSchema>, ScenarioOptions>;
  scenario: Same<z.infer<typeof scenarioSchema>, Scenario>;
} = { persona: true, tableConfig: true, expectation: true, options: true, scenario: true };

// ---------------------------------------------------------------------------------------------
// Versions and migrations
// ---------------------------------------------------------------------------------------------

/** Turns a scenario of version N into one of version N + 1. Pure; the input is not mutated. */
export type ScenarioMigration = (
  input: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

/**
 * The migrate hook. Keyed by the version a migration reads. Empty while version 1 is the only
 * format; a future version 2 adds `1: (v1) => v2` here and nothing else changes.
 */
export const SCENARIO_MIGRATIONS: Readonly<Record<number, ScenarioMigration>> = {};

export interface ScenarioIssue {
  /** Where in the scenario, for example `personas[0].claims.sub`; empty for the whole document. */
  path: string;
  message: string;
}

export type ParseScenarioResult =
  { ok: true; scenario: Scenario } | { ok: false; issues: ScenarioIssue[]; message: string };

function failure(issues: ScenarioIssue[]): ParseScenarioResult {
  const message = issues
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
    .join("\n");
  return { ok: false, issues, message };
}

export function formatIssuePath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const part of path) {
    if (typeof part === "number") {
      text += `[${part}]`;
    } else {
      text += text === "" ? String(part) : `.${String(part)}`;
    }
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MigrateResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/**
 * Brings a raw scenario document to `target`. Unknown, newer and unmigratable versions are
 * refused with a message a user can act on. `migrations` and `target` are parameters so the hook
 * is testable before a second version exists.
 */
export function migrateScenario(
  input: Readonly<Record<string, unknown>>,
  migrations: Readonly<Record<number, ScenarioMigration>> = SCENARIO_MIGRATIONS,
  target: number = SCENARIO_VERSION,
): MigrateResult {
  const version = input.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      message: `is missing or not a version number; this build reads scenario version ${target}`,
    };
  }
  if (version > target) {
    return {
      ok: false,
      message: `scenario version ${version} is newer than this build, which reads version ${target}; update RLS Leak Tester to open it`,
    };
  }
  let current: Record<string, unknown> = { ...input };
  for (let from = version; from < target; from += 1) {
    const migration = migrations[from];
    if (migration === undefined) {
      return {
        ok: false,
        message: `scenario version ${version} is no longer supported; this build reads version ${target}`,
      };
    }
    current = { ...migration(current), version: from + 1 };
  }
  return { ok: true, value: current };
}

/**
 * Validates an untrusted value as a scenario. Every load path calls this (SEC-002). Never throws:
 * the result is the typed scenario, or a list of readable issues with their paths.
 */
export function parseScenario(input: unknown): ParseScenarioResult {
  if (!isRecord(input)) {
    return failure([{ path: "", message: "A scenario must be a JSON object" }]);
  }
  const migrated = migrateScenario(input);
  if (!migrated.ok) {
    return failure([{ path: "version", message: migrated.message }]);
  }
  const parsed = scenarioSchema.safeParse(migrated.value);
  if (parsed.success) {
    return { ok: true, scenario: parsed.data };
  }
  return failure(
    parsed.error.issues.map((issue) => ({
      path: formatIssuePath(issue.path),
      message: issue.message,
    })),
  );
}

/** `parseScenario` for JSON text: refuses oversized input before parsing it. Never throws. */
export function parseScenarioJson(text: string): ParseScenarioResult {
  if (text.length > MAX_SCENARIO_JSON_LENGTH) {
    return failure([
      {
        path: "",
        message: `The scenario is larger than ${MAX_SCENARIO_JSON_LENGTH} characters and was not read`,
      },
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure([{ path: "", message: "The scenario is not valid JSON" }]);
  }
  return parseScenario(raw);
}

/** The options of a scenario with every default filled in. */
export function resolveOptions(scenario: Pick<Scenario, "options">): ScenarioOptions {
  return {
    exposedSchemas: [...(scenario.options?.exposedSchemas ?? DEFAULT_EXPOSED_SCHEMAS)],
    supabaseGrants: scenario.options?.supabaseGrants ?? DEFAULT_SUPABASE_GRANTS,
  };
}
