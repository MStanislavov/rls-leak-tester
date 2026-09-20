/**
 * The Supabase side of the store: queries on `public.scenarios` and the
 * `get_scenario_by_slug` function, made with the CALLER's client, so every statement runs
 * under the caller's JWT and the row level security of `supabase/migrations` applies. There is
 * no service-role client in this application.
 *
 * Everything PostgREST returns is parsed with zod before use (SEC-002). A PostgREST error never
 * reaches the browser: it is mapped to a `StoreError` code and only its SQLSTATE is kept.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { MAX_TITLE_LENGTH, parseScenario, type Scenario } from "@/lib/scenario";

import { StoreError, type Visibility } from "../types";
import { remoteIdSchema, slugSchema, visibilitySchema } from "../wire";
import { LIST_MAX_ROWS, UNAVAILABLE_RETRY_AFTER_SECONDS } from "./policy";

export const SCENARIOS_TABLE = "scenarios";
export const GET_BY_SLUG_FUNCTION = "get_scenario_by_slug";

const SUMMARY_COLUMNS = "id, slug, owner, title, visibility, updated_at";
const ROW_COLUMNS = `${SUMMARY_COLUMNS}, payload`;
/** What `get_scenario_by_slug` returns: the owner's user id is not among its columns. */
const SHARED_COLUMNS = "id, slug, title, visibility, updated_at, payload, is_owner";

/** `timestamptz` as PostgREST prints it (an offset, microseconds), normalised to ISO 8601 UTC. */
const timestampSchema = z
  .string()
  .max(64)
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()))
  .transform((date) => date.toISOString());

const summaryRowSchema = z.object({
  id: remoteIdSchema,
  slug: slugSchema,
  owner: z.uuid(),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  visibility: visibilitySchema,
  updated_at: timestampSchema,
});
const fullRowSchema = summaryRowSchema.extend({ payload: z.unknown() });
const sharedRowSchema = fullRowSchema.omit({ owner: true }).extend({ is_owner: z.boolean() });

export interface ScenarioSummaryRow {
  id: string;
  slug: string;
  owner: string;
  title: string;
  visibility: Visibility;
  updatedAt: string;
}

export interface ScenarioRow extends ScenarioSummaryRow {
  scenario: Scenario;
}

/** A row read by its slug. Whose it is stays in the database; only "is it the caller's" leaves. */
export interface SharedScenarioRow extends Omit<ScenarioRow, "owner"> {
  isOwner: boolean;
}

export interface ScenarioRowInput {
  slug: string;
  title: string;
  scenario: Scenario;
  visibility: Visibility;
}

export type ScenarioRowPatch = Partial<Omit<ScenarioRowInput, "slug">>;

export interface ScenarioRepository {
  listByOwner(ownerId: string): Promise<ScenarioSummaryRow[]>;
  /** Through the table: the caller's own row or a public one. */
  findById(id: string): Promise<ScenarioRow | undefined>;
  /** The owner of a row the caller can see (own or public), without reading its payload. */
  ownerOf(id: string): Promise<string | undefined>;
  /** Through `get_scenario_by_slug`: public, unlisted, or the caller's own. */
  findBySlug(slug: string): Promise<SharedScenarioRow | undefined>;
  /** `"slug-taken"` when the unique constraint on the slug refused the insert. */
  insert(input: ScenarioRowInput): Promise<ScenarioRow | "slug-taken">;
  update(id: string, ownerId: string, patch: ScenarioRowPatch): Promise<ScenarioRow | undefined>;
  /** The slug of the deleted row, for the cache. */
  remove(id: string, ownerId: string): Promise<string | undefined>;
}

interface PostgrestFailure {
  code?: unknown;
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

function sqlState(error: PostgrestFailure): string {
  return typeof error.code === "string" ? error.code.slice(0, 16) : "unknown";
}

/** Maps a PostgREST failure. The message of the database is never forwarded. */
function toStoreError(error: PostgrestFailure, operation: string): StoreError {
  const code = sqlState(error);
  const cause = { operation, sqlState: code };
  if (code === INSUFFICIENT_PRIVILEGE) {
    return new StoreError("forbidden", "The database refused this change.", { cause });
  }
  if (code === CHECK_VIOLATION) {
    return new StoreError(
      "invalid",
      "The database refused the scenario: it breaks a size or format limit.",
      {
        cause,
      },
    );
  }
  return new StoreError("unavailable", "The scenario store did not answer. Try again shortly.", {
    cause,
    retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
  });
}

function corrupt(operation: string): StoreError {
  return new StoreError("corrupt", "What is stored here is not a readable scenario.", {
    cause: { operation },
  });
}

function parseSummaryRows(data: unknown, operation: string): ScenarioSummaryRow[] {
  const rows = z.array(summaryRowSchema).safeParse(data);
  if (!rows.success) throw corrupt(operation);
  return rows.data.map(({ updated_at: updatedAt, ...row }) => ({ ...row, updatedAt }));
}

/** The first row of a PostgREST answer, validated by `schema`; its payload parsed as a scenario. */
function parseFirst<T extends { payload?: unknown }>(
  schema: z.ZodType<T>,
  data: unknown,
  operation: string,
): { row: T; scenario: Scenario } | undefined {
  const rows = z.array(z.unknown()).safeParse(data);
  if (!rows.success) throw corrupt(operation);
  if (rows.data.length === 0) return undefined;
  const row = schema.safeParse(rows.data[0]);
  if (!row.success) throw corrupt(operation);
  const scenario = parseScenario(row.data.payload);
  if (!scenario.ok) throw corrupt(operation);
  return { row: row.data, scenario: scenario.scenario };
}

function parseFirstRow(data: unknown, operation: string): ScenarioRow | undefined {
  const first = parseFirst(fullRowSchema, data, operation);
  if (first === undefined) return undefined;
  const { id, slug, owner, title, visibility, updated_at: updatedAt } = first.row;
  return { id, slug, owner, title, visibility, updatedAt, scenario: first.scenario };
}

function parseSharedRow(data: unknown, operation: string): SharedScenarioRow | undefined {
  const first = parseFirst(sharedRowSchema, data, operation);
  if (first === undefined) return undefined;
  const { id, slug, title, visibility, updated_at: updatedAt, is_owner: isOwner } = first.row;
  return { id, slug, title, visibility, updatedAt, isOwner, scenario: first.scenario };
}

function toColumns(patch: ScenarioRowPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (patch.title !== undefined) columns["title"] = patch.title;
  if (patch.scenario !== undefined) columns["payload"] = patch.scenario;
  if (patch.visibility !== undefined) columns["visibility"] = patch.visibility;
  return columns;
}

export function createSupabaseScenarioRepository(client: SupabaseClient): ScenarioRepository {
  return {
    listByOwner: async (ownerId) => {
      const { data, error } = await client
        .from(SCENARIOS_TABLE)
        .select(SUMMARY_COLUMNS)
        .eq("owner", ownerId)
        .order("updated_at", { ascending: false })
        .limit(LIST_MAX_ROWS);
      if (error !== null) throw toStoreError(error, "list");
      return parseSummaryRows(data, "list");
    },

    findById: async (id) => {
      const { data, error } = await client
        .from(SCENARIOS_TABLE)
        .select(ROW_COLUMNS)
        .eq("id", id)
        .limit(1);
      if (error !== null) throw toStoreError(error, "find");
      return parseFirstRow(data, "find");
    },

    ownerOf: async (id) => {
      const { data, error } = await client
        .from(SCENARIOS_TABLE)
        .select("owner")
        .eq("id", id)
        .limit(1);
      if (error !== null) throw toStoreError(error, "owner-of");
      const rows = z.array(z.object({ owner: z.uuid() })).safeParse(data);
      if (!rows.success) throw corrupt("owner-of");
      return rows.data[0]?.owner;
    },

    findBySlug: async (slug) => {
      const { data, error } = await client
        .rpc(GET_BY_SLUG_FUNCTION, { p_slug: slug })
        .select(SHARED_COLUMNS)
        .limit(1);
      if (error !== null) throw toStoreError(error, "find-by-slug");
      return parseSharedRow(data, "find-by-slug");
    },

    insert: async (input) => {
      // No `owner`: the column default is auth.uid(), and WITH CHECK refuses anything else.
      const { data, error } = await client
        .from(SCENARIOS_TABLE)
        .insert({ slug: input.slug, ...toColumns(input) })
        .select(ROW_COLUMNS);
      if (error !== null) {
        if (sqlState(error) === UNIQUE_VIOLATION) return "slug-taken";
        throw toStoreError(error, "insert");
      }
      const row = parseFirstRow(data, "insert");
      if (row === undefined) throw corrupt("insert");
      return row;
    },

    update: async (id, ownerId, patch) => {
      const { data, error } = await client
        .from(SCENARIOS_TABLE)
        .update(toColumns(patch))
        .eq("id", id)
        .eq("owner", ownerId)
        .select(ROW_COLUMNS);
      if (error !== null) throw toStoreError(error, "update");
      return parseFirstRow(data, "update");
    },

    remove: async (id, ownerId) => {
      const { data, error } = await client
        .from(SCENARIOS_TABLE)
        .delete()
        .eq("id", id)
        .eq("owner", ownerId)
        .select("slug");
      if (error !== null) throw toStoreError(error, "delete");
      const rows = z.array(z.object({ slug: slugSchema })).safeParse(data);
      if (!rows.success) throw corrupt("delete");
      return rows.data[0]?.slug;
    },
  };
}
