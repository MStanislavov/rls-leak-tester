/**
 * Regressions for session state and determinism: what the user's SQL leaves behind in the one
 * connection must never reach a probe, the result must not depend on the machine or the clock,
 * and a worn-out PGlite session must be replaced instead of reporting nonsense.
 */
import { describe, expect, it } from "vitest";
import { SetupError } from "@/lib/runner/setup";
import { ALICE, BOB, CLAIM, cellOf, keys, run, scenarioOf } from "./helpers";

const RUN_TIMEOUT_MS = 120_000;

const supabasePersonas = [
  { id: "anon", label: "Anon", dbRole: "anon", claims: {} },
  { id: "alice", label: "Alice", dbRole: "authenticated", claims: { sub: ALICE } },
  { id: "bob", label: "Bob", dbRole: "authenticated", claims: { sub: BOB } },
];

/** The header every pg_dump / `supabase db dump` file starts with. */
const PG_DUMP_HEADER = `--
-- PostgreSQL database dump
--
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
`;

describe("session state left by the user's SQL", () => {
  it(
    "a pg_dump header (SET row_security = off) does not turn a leak into ISOLATED",
    async () => {
      const { result } = await run(
        scenarioOf({
          mode: "supabase",
          schemaSql: `${PG_DUMP_HEADER}
            CREATE TABLE public.notes (id integer NOT NULL, user_id uuid NOT NULL, body text);
            ALTER TABLE ONLY public.notes ADD CONSTRAINT notes_pkey PRIMARY KEY (id);
            ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
            CREATE POLICY leaky ON public.notes TO authenticated USING ((auth.uid() IS NOT NULL));`,
          seedSql: `INSERT INTO public.notes VALUES (1,'${ALICE}','a1'),(2,'${ALICE}','a2'),(3,'${BOB}','b1');`,
          personas: supabasePersonas,
        }),
      );
      expect(result.verdict).toBe("LEAKING");
      expect(cellOf(result, "bob", "notes", "select")).toMatchObject({
        status: "leak",
        leakedKeys: keys(1, 2),
        error: null,
      });
      expect(result.counts.leak).toBe(6);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "a seed that signs in through the legacy request.jwt.claim.sub does not lend its user to the probes",
    async () => {
      const { result } = await run(
        scenarioOf({
          mode: "supabase",
          schemaSql: `
            create table notes (id int primary key, user_id uuid not null default auth.uid(), body text);
            alter table notes enable row level security;
            create policy own on notes for all to authenticated
              using (user_id = auth.uid()) with check (user_id = auth.uid());`,
          seedSql: `
            set request.jwt.claim.sub = '${ALICE}';
            insert into notes (id, body) values (1, 'a');
            set request.jwt.claim.sub = '${BOB}';
            insert into notes (id, body) values (2, 'b');`,
          personas: supabasePersonas.slice(1),
        }),
      );
      expect(result.verdict).toBe("ISOLATED");
      expect(result.counts).toMatchObject({ pass: 8 });
      expect(cellOf(result, "alice", "notes", "select").actualKeys).toEqual(keys(1));
    },
    RUN_TIMEOUT_MS,
  );

  it.each(["schema", "seed"] as const)(
    "a BEGIN without COMMIT in the %s SQL is a setup error, not a silently discarded script",
    async (phase) => {
      const open = "BEGIN;\ninsert into docs values (1, 'a'), (2, 'b');";
      const scenario = scenarioOf({
        schemaSql: `
          create role app_user nologin;
          create table docs (id int primary key, body text);
          alter table docs enable row level security;
          create policy leaky on docs for select to app_user using (true);
          grant select on docs to app_user;
          ${phase === "schema" ? open : ""}`,
        seedSql: phase === "seed" ? open : "",
        personas: [{ id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } }],
      });
      const failure = await run(scenario).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SetupError);
      expect(failure).toMatchObject({ phase, sqlState: "25001" });
      expect((failure as SetupError).message).toContain("COMMIT");
      expect((failure as SetupError).statement).toBe("BEGIN");
    },
    RUN_TIMEOUT_MS,
  );
});

describe("determinism", () => {
  it(
    "renders timestamptz keys in UTC, whatever the host or the user's SQL set",
    async () => {
      const { result } = await run(
        scenarioOf({
          schemaSql: `
            create role app_user nologin;
            set timezone = 'Asia/Kolkata';
            create table events (at timestamptz primary key, user_id uuid not null);
            alter table events enable row level security;
            create policy own on events for all to app_user using (user_id = ${CLAIM("sub")}::uuid);
            grant select, insert, update, delete on events to app_user;`,
          seedSql: `insert into events values ('2024-03-10 02:30:00+01', '${ALICE}');`,
          personas: [{ id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } }],
        }),
      );
      const key = JSON.stringify(["2024-03-10 01:30:00+00"]);
      expect(cellOf(result, "alice", "events", "select")).toMatchObject({
        status: "pass",
        expectedKeys: [key],
        actualKeys: [key],
      });
      expect(cellOf(result, "alice", "events", "delete").actualKeys).toEqual([key]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "a `default now()` column does not reach the result",
    async () => {
      const scenario = scenarioOf({
        mode: "supabase",
        schemaSql: `
          create table notes (
            id bigint generated by default as identity primary key,
            user_id uuid not null,
            body text,
            created_at timestamptz not null default now()
          );
          alter table notes enable row level security;
          create policy own on notes for all to authenticated
            using (auth.uid() = user_id) with check (auth.uid() = user_id);`,
        seedSql: `insert into notes (user_id, body) values ('${ALICE}', 'a'), ('${BOB}', 'b');`,
        personas: supabasePersonas,
      });
      const first = await run(scenario);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second = await run(scenario);
      expect(first.result.verdict).toBe("ISOLATED");
      expect(first.result.counts).toMatchObject({ pass: 12 });
      expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
    },
    RUN_TIMEOUT_MS,
  );
});

describe("PGlite wears out after a few thousand SQL errors in one session", () => {
  const readOnlyLog = (rows: number): string => `
    create role app_user nologin;
    create table audit_log (id int primary key, user_id text not null, what text);
    alter table audit_log enable row level security;
    create policy own on audit_log for select to app_user using (user_id = ${CLAIM("sub")});
    grant select on audit_log to app_user;
    insert into audit_log
      select g, case g % 3 when 0 then 'alice' when 1 then 'bob' else 'carol' end, 'x'
        from generate_series(1, ${rows}) g;`;
  const leakyDocs = `
    create table docs (id int primary key, user_id text not null, body text);
    alter table docs enable row level security;
    create policy leaky on docs for select to app_user using (true);
    grant select on docs to app_user;
    insert into docs values (1, 'alice', 'a'), (2, 'bob', 'b'), (3, 'carol', 'c');`;
  const personas = ["alice", "bob", "carol"].map((sub) => ({
    id: sub,
    label: sub,
    dbRole: "app_user",
    claims: { sub },
  }));

  it(
    "a missing table privilege fails once, not once per row",
    async () => {
      const { result, timings } = await run(
        scenarioOf({ schemaSql: readOnlyLog(600) + leakyDocs, personas }),
      );
      const update = cellOf(result, "alice", "audit_log", "update");
      // Alice's own rows are expected and cannot be updated: an overblock, measured in one go.
      expect(update).toMatchObject({
        status: "overblock",
        actualKeys: [],
        perRowFallback: false,
        error: { sqlState: "42501", message: "permission denied for table audit_log" },
      });
      expect(cellOf(result, "alice", "audit_log", "delete").perRowFallback).toBe(false);
      expect(timings.rebuilds).toBe(0);
      expect(result.verdict).toBe("LEAKING");
      expect(result.counts).toMatchObject({ leak: 3, inconclusive: 0 });
    },
    RUN_TIMEOUT_MS,
  );

  // WITH CHECK (false): every visible row raises 42501 on its own, which is what the row-by-row
  // fallback is for. 30 own rows per persona; the budgets are small so that the test is quick
  // (`tests/engine/error-budget.integration.test.ts` holds the default budget against PGlite).
  const failingRows = `
    ${readOnlyLog(90)}
    create policy change on audit_log for update to app_user using (true) with check (false);
    grant update on audit_log to app_user;
    ${leakyDocs}`;

  it(
    "rebuilds the database between two cells before the session wears out",
    async () => {
      const { result, timings } = await run(scenarioOf({ schemaSql: failingRows, personas }), {
        errorBudget: { rebuildAt: 40, abortAt: 1000 },
      });
      expect(timings.rebuilds).toBeGreaterThan(0);
      expect(result.counts.inconclusive).toBe(0);
      expect(cellOf(result, "carol", "audit_log", "update")).toMatchObject({
        status: "overblock",
        perRowFallback: true,
        missingKeys: expect.arrayContaining(keys(2)),
      });
      expect(cellOf(result, "carol", "docs", "select")).toMatchObject({
        status: "leak",
        leakedKeys: keys(1, 2),
      });
      expect(result.verdict).toBe("LEAKING");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "a cell that needs more errors than a session can take is inconclusive, and the run goes on",
    async () => {
      const { result, timings } = await run(scenarioOf({ schemaSql: failingRows, personas }), {
        errorBudget: { rebuildAt: 10, abortAt: 20 },
      });
      const update = cellOf(result, "alice", "audit_log", "update");
      expect(update.status).toBe("inconclusive");
      expect(update.reason).toContain("too many SQL errors");
      expect(update.error?.sqlState).toBeNull();
      expect(timings.rebuilds).toBeGreaterThanOrEqual(3);
      expect(cellOf(result, "alice", "audit_log", "select").status).toBe("pass");
      expect(cellOf(result, "carol", "docs", "select").status).toBe("leak");
      expect(result.verdict).toBe("LEAKING");
    },
    RUN_TIMEOUT_MS,
  );
});
