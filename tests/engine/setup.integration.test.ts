import { describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { SetupError, setupDatabase, type SetupSummary } from "@/lib/runner/setup";
import type { SqlEngine } from "@/lib/runner/types";
import type { ScenarioSetupInput } from "@/lib/scenario";

const ALICE = "11111111-1111-4111-8111-111111111111";

async function withEngine<T>(work: (engine: SqlEngine) => Promise<T>): Promise<T> {
  const engine = await createPgliteEngine();
  try {
    return await work(engine);
  } finally {
    await engine.close();
  }
}

/** Reads as a role inside a rolled-back transaction: the ids, or the SQLSTATE that stopped it. */
async function readAs(engine: SqlEngine, role: string, sql: string): Promise<unknown[] | string> {
  return engine.transaction(async (tx) => {
    try {
      await tx.query("select set_config('role', $1, true)", [role]);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: ALICE, role }),
      ]);
      const { rows } = await tx.query(sql);
      return rows.map((row) => row.id);
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        return error.code;
      }
      throw error;
    } finally {
      await tx.rollback();
    }
  });
}

const SCHEMA = `
create table public.notes (
  id int primary key,
  user_id uuid not null
);
alter table public.notes enable row level security;
create policy own on public.notes for select to authenticated using (auth.uid() = user_id);

-- The real-world failure: a table nobody enabled RLS on.
create table public.audit_log (id int primary key, line text);
`;

const SEED = `
insert into public.notes values (1, '${ALICE}'), (2, '22222222-2222-4222-8222-222222222222');
insert into public.audit_log values (1, 'a'), (2, 'b');
`;

function supabase(overrides: Partial<ScenarioSetupInput> = {}): ScenarioSetupInput {
  return { mode: "supabase", schemaSql: SCHEMA, seedSql: SEED, ...overrides };
}

describe("setupDatabase, supabase mode", () => {
  it("legacy grants: RLS is the only barrier, so the RLS-disabled table is readable by anon", async () => {
    await withEngine(async (engine) => {
      const summary = await setupDatabase(engine, supabase(), SUPABASE_SETUP_SQL);
      expect(summary).toEqual<SetupSummary>({
        mode: "supabase",
        exposedSchemas: ["public"],
        supabaseGrants: "legacy",
        schemaStatements: 4,
        seedStatements: 2,
      });
      expect(await readAs(engine, "anon", "select id from audit_log order by id")).toEqual([1, 2]);
      // The policy still filters: the shim's auth.uid() reads the claims.
      expect(await readAs(engine, "authenticated", "select id from notes order by id")).toEqual([
        1,
      ]);
      expect(await readAs(engine, "anon", "select id from notes order by id")).toEqual([]);
      expect(await readAs(engine, "service_role", "select id from notes order by id")).toEqual([
        1, 2,
      ]);
    });
  }, 60_000);

  it("explicit grants: the same table answers 42501 until the user's SQL grants it", async () => {
    await withEngine(async (engine) => {
      const summary = await setupDatabase(
        engine,
        supabase({ options: { exposedSchemas: ["public"], supabaseGrants: "explicit" } }),
        SUPABASE_SETUP_SQL,
      );
      expect(summary.supabaseGrants).toBe("explicit");
      expect(await readAs(engine, "anon", "select id from audit_log order by id")).toBe("42501");
      expect(await readAs(engine, "authenticated", "select id from notes order by id")).toBe(
        "42501",
      );
    });
    await withEngine(async (engine) => {
      await setupDatabase(
        engine,
        supabase({
          schemaSql: `${SCHEMA}\ngrant select on public.audit_log to anon;\ngrant select on public.notes to authenticated;`,
          options: { exposedSchemas: ["public"], supabaseGrants: "explicit" },
        }),
        SUPABASE_SETUP_SQL,
      );
      expect(await readAs(engine, "anon", "select id from audit_log order by id")).toEqual([1, 2]);
      expect(await readAs(engine, "authenticated", "select id from notes order by id")).toEqual([
        1,
      ]);
      // Not granted to anon: a missing privilege, whatever the policy says.
      expect(await readAs(engine, "anon", "select id from notes order by id")).toBe("42501");
    });
  }, 60_000);

  it("applies the default grants BEFORE the user's schema, so a REVOKE in it survives", async () => {
    await withEngine(async (engine) => {
      await setupDatabase(
        engine,
        supabase({ schemaSql: `${SCHEMA}\nrevoke all on public.audit_log from anon;` }),
        SUPABASE_SETUP_SQL,
      );
      expect(await readAs(engine, "anon", "select id from audit_log order by id")).toBe("42501");
      expect(await readAs(engine, "authenticated", "select id from audit_log order by id")).toEqual(
        [1, 2],
      );
    });
  }, 60_000);

  it("creates and grants an exposed schema other than public, with a name that needs quoting", async () => {
    await withEngine(async (engine) => {
      const summary = await setupDatabase(
        engine,
        {
          mode: "supabase",
          schemaSql: 'create table "Api V2"."Items" (id int primary key);',
          seedSql: 'insert into "Api V2"."Items" values (7);',
          options: { exposedSchemas: ["Api V2", "public", "Api V2"], supabaseGrants: "legacy" },
        },
        SUPABASE_SETUP_SQL,
      );
      expect(summary.exposedSchemas).toEqual(["Api V2", "public"]);
      expect(await readAs(engine, "anon", 'select id from "Api V2"."Items"')).toEqual([7]);
    });
  }, 60_000);
});

describe("setupDatabase, postgres mode", () => {
  it("applies no shim and no automatic grant: the user's SQL owns roles and privileges", async () => {
    await withEngine(async (engine) => {
      const summary = await setupDatabase(
        engine,
        {
          mode: "postgres",
          schemaSql: `
            create role app_user nologin;
            create table t (id int primary key);
            create table granted (id int primary key);
            grant select on granted to app_user;
          `,
          seedSql: "insert into t values (1); insert into granted values (2);",
        },
        SUPABASE_SETUP_SQL,
      );
      expect(summary).toMatchObject({ mode: "postgres", supabaseGrants: null });

      const { rows } = await engine.query(
        `select (select count(*)::int from pg_roles where rolname in ('anon','authenticated','service_role')) as api_roles,
                to_regnamespace('auth')::text as auth_schema`,
      );
      expect(rows).toEqual([{ api_roles: 0, auth_schema: null }]);
      expect(await readAs(engine, "app_user", "select id from t")).toBe("42501");
      expect(await readAs(engine, "app_user", "select id from granted")).toEqual([2]);
    });
  }, 60_000);
});

describe("setupDatabase, failures in the user's SQL", () => {
  it("reports a schema error with phase, statement index, text, line and SQLSTATE", async () => {
    await withEngine(async (engine) => {
      const schemaSql = [
        "-- a comment line",
        "create table a (id int primary key);",
        "",
        "create table b (",
        "  id int primary key,",
        "  a_id int references missing_table (id)",
        ");",
        "create table c (id int primary key);",
      ].join("\n");
      const error = await setupDatabase(
        engine,
        { mode: "postgres", schemaSql, seedSql: "" },
        SUPABASE_SETUP_SQL,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject({
        name: "SetupError",
        phase: "schema",
        statementIndex: 1,
        line: 4,
        column: 1,
        sqlState: "42P01",
        message: 'relation "missing_table" does not exist',
      });
      expect((error as SetupError).statement).toBe(
        "create table b (\n  id int primary key,\n  a_id int references missing_table (id)\n)",
      );

      // Statement by statement, as psql does: what ran before the failure stays, the rest never ran.
      const { rows } = await engine.query(
        "select to_regclass('a')::text as a, to_regclass('b')::text as b, to_regclass('c')::text as c",
      );
      expect(rows).toEqual([{ a: "a", b: null, c: null }]);
    });
  }, 60_000);

  it("reports a seed error with the failing statement, its detail and the position inside it", async () => {
    await withEngine(async (engine) => {
      const seedSql =
        "insert into a values (1);\ninsert into a values (2);\n  insert into a values (1);";
      const error = await setupDatabase(
        engine,
        { mode: "postgres", schemaSql: "create table a (id int primary key);", seedSql },
        SUPABASE_SETUP_SQL,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        phase: "seed",
        statementIndex: 2,
        statement: "insert into a values (1)",
        line: 3,
        column: 3,
        sqlState: "23505",
        detail: "Key (id)=(1) already exists.",
      });

      const syntax = await setupDatabase(
        engine,
        { mode: "postgres", schemaSql: "", seedSql: "insert into a valeus (9);" },
        SUPABASE_SETUP_SQL,
      ).catch((caught: unknown) => caught);
      // Postgres points at the misspelt keyword: 1-based offset into the statement.
      expect(syntax).toMatchObject({ phase: "seed", sqlState: "42601", position: 15 });
    });
  }, 60_000);

  it("lets a script open its own transaction across statements", async () => {
    await withEngine(async (engine) => {
      await setupDatabase(
        engine,
        {
          mode: "postgres",
          schemaSql: "create table a (id int primary key);",
          seedSql: "begin; insert into a values (1); insert into a values (2); rollback;",
        },
        SUPABASE_SETUP_SQL,
      );
      const { rows } = await engine.query("select count(*)::int as n from a");
      expect(rows).toEqual([{ n: 0 }]);
    });
  }, 60_000);
});
