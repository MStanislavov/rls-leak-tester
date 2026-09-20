/**
 * Shared by the store suites: a valid scenario, a fake `Storage`, and a MOCKED Supabase client
 * (rules.yaml TEST-001: no test talks to a real project). The fake keeps rows in memory and
 * applies the same visibility rules as `supabase/migrations` (whose real proof is
 * `migration.test.ts`), so the handlers can be tested for what a second user sees.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";

import { createRedisServices, type RedisServices } from "@/lib/redis";
import { parseScenario, type Scenario } from "@/lib/scenario";
import type { ScenarioApiDeps, ScenarioLogEvent } from "@/lib/store/server";

export const ALICE = "00000000-0000-4000-8000-00000000000a";
export const BOB = "00000000-0000-4000-8000-00000000000b";

export function sampleScenario(overrides: Partial<Scenario> = {}): Scenario {
  const parsed = parseScenario({
    id: "sample-scenario",
    version: 1,
    title: "Sample scenario",
    description: "A table with an owner column.",
    mode: "supabase",
    schemaSql: "create table public.notes (id int primary key, user_id uuid not null);",
    seedSql: `insert into public.notes values (1, '${ALICE}');`,
    personas: [
      { id: "alice", label: "Alice", dbRole: "authenticated", claims: { sub: ALICE } },
      { id: "visitor", label: "Visitor", dbRole: "anon", claims: {} },
    ],
    tables: [{ schema: "public", name: "notes", ownerColumn: "user_id" }],
    expectations: [],
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`The fixture scenario is invalid: ${parsed.message}`);
  return parsed.scenario;
}

// --- Storage ---------------------------------------------------------------------------------

export interface FakeStorage extends Storage {
  readonly data: Map<string, string>;
  /** The next `setItem` throws this once. */
  failNextWrite(error: unknown): void;
}

export function createFakeStorage(): FakeStorage {
  const data = new Map<string, string>();
  let pending: { error: unknown } | undefined;
  return {
    data,
    failNextWrite: (error) => {
      pending = { error };
    },
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (pending !== undefined) {
        const { error } = pending;
        pending = undefined;
        throw error;
      }
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
  };
}

// --- Supabase --------------------------------------------------------------------------------

export interface FakeRow {
  id: string;
  slug: string;
  owner: string;
  title: string;
  payload: unknown;
  visibility: string;
  created_at: string;
  updated_at: string;
}

interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

type Operation =
  | { kind: "select" }
  | { kind: "rpc"; name: string; args: Record<string, unknown> }
  | { kind: "insert"; values: Record<string, unknown> }
  | { kind: "update"; values: Record<string, unknown> }
  | { kind: "delete" };

export interface FakeSupabase {
  readonly client: SupabaseClient;
  readonly rows: FakeRow[];
  /** Every statement that reached the "database", in order, e.g. `rpc:get_scenario_by_slug`. */
  readonly statements: string[];
  /** The signed-in user; `null` is anon. */
  user: string | null;
  /** When set, `auth.getUser()` fails like an outage of Supabase Auth. */
  authOutage: boolean;
  /** When set, every statement fails with this PostgREST error. */
  failWith: { code: string; message: string } | null;
  /** Unique violations to simulate on the next inserts, whatever the slug. */
  slugCollisions: number;
  readonly exchangeCodeForSession: ReturnType<typeof vi.fn>;
  readonly signOut: ReturnType<typeof vi.fn>;
  seed(row: Partial<FakeRow> & Pick<FakeRow, "slug" | "owner" | "visibility">): FakeRow;
}

export function createFakeSupabase(): FakeSupabase {
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const tick = (): string => {
    clock += 1000;
    // PostgREST prints timestamptz with an offset and microseconds.
    return new Date(clock).toISOString().replace("Z", "000+00:00");
  };

  const fake: FakeSupabase = {
    client: undefined as unknown as SupabaseClient,
    rows: [],
    statements: [],
    user: null,
    authOutage: false,
    failWith: null,
    slugCollisions: 0,
    exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    seed: (row) => {
      const full: FakeRow = {
        id: randomUUID(),
        title: `Title of ${row.slug}`,
        payload: sampleScenario({ title: `Title of ${row.slug}` }),
        created_at: tick(),
        updated_at: tick(),
        ...row,
      };
      fake.rows.push(full);
      return full;
    },
  };

  /** The SELECT policies: own rows and public rows. */
  const visible = (row: FakeRow): boolean => row.owner === fake.user || row.visibility === "public";

  const project = (row: FakeRow, columns: string): Record<string, unknown> =>
    Object.fromEntries(
      columns
        .split(",")
        .map((column) => column.trim())
        .map((column) => [column, (row as unknown as Record<string, unknown>)[column]]),
    );

  const run = (
    operation: Operation,
    filters: ReadonlyArray<readonly [string, unknown]>,
    columns: string | undefined,
    max: number | undefined,
  ): QueryResult => {
    fake.statements.push(
      operation.kind === "rpc" ? `rpc:${operation.name}` : `${operation.kind}:scenarios`,
    );
    if (fake.failWith !== null) return { data: null, error: fake.failWith };
    const matches = (row: FakeRow): boolean =>
      filters.every(
        ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value,
      );
    let result: FakeRow[];

    switch (operation.kind) {
      case "select":
        result = fake.rows.filter((row) => visible(row) && matches(row));
        result.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        break;
      case "rpc":
        result = fake.rows.filter(
          (row) =>
            row.slug === operation.args["p_slug"] &&
            (row.visibility !== "private" || row.owner === fake.user),
        );
        break;
      case "insert": {
        if (fake.user === null) {
          return { data: null, error: { code: "42501", message: "permission denied" } };
        }
        const slug = String(operation.values["slug"]);
        if (fake.slugCollisions > 0 || fake.rows.some((row) => row.slug === slug)) {
          fake.slugCollisions = Math.max(0, fake.slugCollisions - 1);
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const row: FakeRow = {
          id: randomUUID(),
          slug,
          owner: fake.user,
          title: String(operation.values["title"]),
          payload: operation.values["payload"],
          visibility: String(operation.values["visibility"] ?? "private"),
          created_at: tick(),
          updated_at: tick(),
        };
        fake.rows.push(row);
        result = [row];
        break;
      }
      case "update":
        // USING of the owner policy: only the caller's own rows can be reached.
        result = fake.rows.filter((row) => row.owner === fake.user && matches(row));
        for (const row of result) Object.assign(row, operation.values, { updated_at: tick() });
        break;
      case "delete":
        result = fake.rows.filter((row) => row.owner === fake.user && matches(row));
        for (const row of result) fake.rows.splice(fake.rows.indexOf(row), 1);
        break;
    }

    const limited = max === undefined ? result : result.slice(0, max);
    return { data: limited.map((row) => project(row, columns ?? "id")), error: null };
  };

  const query = (operation: Operation) => {
    const filters: Array<readonly [string, unknown]> = [];
    let columns: string | undefined;
    let max: number | undefined;
    const builder = {
      select: (list: string) => {
        columns = list;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: () => builder,
      limit: (count: number) => {
        max = count;
        return builder;
      },
      then: <A, B>(
        resolve: (value: QueryResult) => A | PromiseLike<A>,
        reject?: (reason: unknown) => B | PromiseLike<B>,
      ) => Promise.resolve(run(operation, filters, columns, max)).then(resolve, reject),
    };
    return builder;
  };

  const client = {
    from: (table: string) => ({
      table,
      select: (list: string) => query({ kind: "select" }).select(list),
      insert: (values: Record<string, unknown>) => query({ kind: "insert", values }),
      update: (values: Record<string, unknown>) => query({ kind: "update", values }),
      delete: () => query({ kind: "delete" }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => query({ kind: "rpc", name, args }),
    auth: {
      getUser: async () => {
        if (fake.authOutage) {
          return { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } };
        }
        return fake.user === null
          ? { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } }
          : { data: { user: { id: fake.user } }, error: null };
      },
      exchangeCodeForSession: fake.exchangeCodeForSession,
      signOut: fake.signOut,
    },
  };
  (fake as { client: SupabaseClient }).client = client as unknown as SupabaseClient;
  return fake;
}

// --- handler dependencies --------------------------------------------------------------------

export interface ApiHarness {
  readonly supabase: FakeSupabase;
  readonly services: RedisServices;
  readonly events: ScenarioLogEvent[];
  readonly deps: ScenarioApiDeps;
}

/** In-memory Redis services under a unique env, the fake Supabase, a collecting logger. */
export function createApiHarness(options: { configured?: boolean } = {}): ApiHarness {
  const supabase = createFakeSupabase();
  const services = createRedisServices({
    envName: `test-${randomUUID().slice(0, 12)}`,
    redisUrl: undefined,
  });
  const events: ScenarioLogEvent[] = [];
  return {
    supabase,
    services,
    events,
    deps: {
      supabase: options.configured === false ? undefined : supabase.client,
      keys: services.keys,
      limiter: services.rateLimiter,
      cache: services.cache,
      logger: (event) => events.push(event),
    },
  };
}

export function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": "203.0.113.7",
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
