/**
 * SELECT, UPDATE and DELETE reach against a real PGlite: a correct and a leaky policy each, the
 * WHERE-less DELETE shape, the defaults, and the cells that cannot be measured.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EMPTY_TABLE_REMARK, type MatrixResult, type MatrixRun } from "@/lib/runner";
import { NO_PRIMARY_KEY_REASON } from "@/lib/runner/ground-truth";
import { ALICE, BOB, CLAIM, cellOf, keys, run, scenarioOf } from "./helpers";

const OWN = `user_id = ${CLAIM("sub")}::uuid`;

const notes = (name: string, policies: string): string => `
  create table ${name} (id int primary key, user_id uuid not null, body text);
  alter table ${name} enable row level security;
  ${policies}
  grant select, insert, update, delete on ${name} to app_user;
`;

const SCHEMA = `
  create role app_user nologin;
  ${notes("notes_ok", `create policy own on notes_ok for all using (${OWN});`)}
  ${notes("notes_leaky", `create policy anyone on notes_leaky for all using (true) with check (${OWN});`)}
  ${notes(
    "notes_blind",
    `create policy read_own on notes_blind for select using (${OWN});
     create policy delete_any on notes_blind for delete using (true);`,
  )}
  ${notes("notes_empty", `create policy own on notes_empty for all using (${OWN});`)}
  ${notes("notes_locked", "")}
  create table nopk (user_id uuid, body text);
  grant select on nopk to app_user;
`;

const SEED = ["notes_ok", "notes_leaky", "notes_blind", "notes_locked"]
  .map(
    (name) =>
      `insert into ${name} values (1, '${ALICE}', 'a1'), (2, '${ALICE}', 'a2'), (3, '${BOB}', 'b1');`,
  )
  .join("\n");

const scenario = scenarioOf({
  schemaSql: SCHEMA,
  seedSql: SEED,
  personas: [
    { id: "alice", label: "Alice", dbRole: "app_user", claims: { sub: ALICE } },
    { id: "bob", label: "Bob", dbRole: "app_user", claims: { sub: BOB } },
    { id: "ghost", label: "Ghost", dbRole: "no_such_role", claims: { sub: ALICE } },
  ],
});

describe("reach probes (postgres mode, default expectations)", () => {
  let matrix: MatrixRun;
  let result: MatrixResult;

  beforeAll(async () => {
    matrix = await run(scenario);
    result = matrix.result;
  }, 60_000);

  it("suggests the owner column and defaults a custom role to scope own", () => {
    expect(matrix.tableConfigs.find((table) => table.name === "notes_ok")).toEqual({
      schema: "public",
      name: "notes_ok",
      ownerColumn: "user_id",
    });
    const cell = cellOf(result, "alice", "notes_ok", "select");
    expect(cell).toMatchObject({ scope: "own", expectationSource: "default" });
  });

  it.each(["select", "update", "delete"] as const)(
    "a correct policy passes %s for both users",
    (operation) => {
      expect(cellOf(result, "alice", "notes_ok", operation)).toMatchObject({
        status: "pass",
        expectedKeys: keys(1, 2),
        actualKeys: keys(1, 2),
        leakedKeys: [],
        missingKeys: [],
        error: null,
        rlsBypass: null,
      });
      expect(cellOf(result, "bob", "notes_ok", operation)).toMatchObject({
        status: "pass",
        actualKeys: keys(3),
      });
    },
  );

  it.each(["select", "delete"] as const)(
    "USING (true) leaks the other user's rows on %s",
    (operation) => {
      expect(cellOf(result, "alice", "notes_leaky", operation)).toMatchObject({
        status: "leak",
        expectedKeys: keys(1, 2),
        actualKeys: keys(1, 2, 3),
        leakedKeys: keys(3),
      });
      expect(cellOf(result, "bob", "notes_leaky", operation).leakedKeys).toEqual(keys(1, 2));
    },
  );

  it("records the exact script of the probe", () => {
    expect(cellOf(result, "bob", "notes_leaky", "select").sql.split("\n")).toEqual([
      "begin;",
      "select set_config('role', 'app_user', true);",
      `select set_config('request.jwt.claims', '{"sub":"${BOB}"}', true);`,
      "select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true), set_config('request.jwt.claim.email', '', true), set_config('request.jwt.claim', '', true), set_config('row_security', 'on', true), set_config('TimeZone', 'UTC', true);",
      "select current_user::text as role, session_user::text as session_role, current_setting('row_security') as row_security;",
      'select "id"::text as k0 from "public"."notes_leaky";',
      "rollback;",
    ]);
  });

  it("records the bare statement for the export", () => {
    expect(cellOf(result, "bob", "notes_leaky", "select").statement).toBe(
      'select "id"::text as k0 from "public"."notes_leaky"',
    );
    expect(cellOf(result, "bob", "notes_leaky", "delete").statement).toBe(
      'delete from "public"."notes_leaky" returning "id"::text as k0',
    );
    expect(cellOf(result, "ghost", "notes_leaky", "select").statement).toBe("");
  });

  it("lists the policies that applied", () => {
    expect(cellOf(result, "alice", "notes_blind", "delete").policies).toMatchObject([
      { name: "delete_any", command: "delete", appliesAs: "command", using: "true" },
      { name: "read_own", command: "select", appliesAs: "visibility" },
    ]);
    expect(cellOf(result, "alice", "notes_locked", "select").policies).toEqual([]);
  });

  it("the WHERE-less DELETE finds what the RETURNING shape cannot see", () => {
    const cell = cellOf(result, "alice", "notes_blind", "delete");
    expect(cell).toMatchObject({
      status: "leak",
      actualKeys: keys(1, 2, 3),
      blindKeys: keys(3),
      leakedKeys: keys(3),
    });
    expect(cell.sql).toContain('delete from "public"."notes_blind" returning "id"::text as k0;');
    expect(cell.sql).toContain('delete from "public"."notes_blind";\nreset role;');
    // The same table read with SELECT is fine: the leak is in DELETE only.
    expect(cellOf(result, "alice", "notes_blind", "select").status).toBe("pass");
  });

  it("RLS without a policy is default deny: every own row is missing, an overblock", () => {
    expect(cellOf(result, "alice", "notes_locked", "select")).toMatchObject({
      status: "overblock",
      actualKeys: [],
      missingKeys: keys(1, 2),
    });
  });

  it("an empty table proves nothing: its cells are skipped, never a pass", () => {
    for (const operation of ["select", "update", "delete"] as const) {
      expect(cellOf(result, "alice", "notes_empty", operation)).toMatchObject({
        status: "skipped",
        reason: EMPTY_TABLE_REMARK,
        sql: "",
      });
    }
    expect(cellOf(result, "alice", "notes_empty", "insert")).toMatchObject({
      status: "skipped",
      reason: "The table has no seeded row to clone.",
    });
    expect(result.tables.find((table) => table.name === "notes_empty")?.rowCount).toBe(0);
  });

  it("a table without a primary key is skipped, never tracked by ctid", () => {
    for (const operation of ["select", "insert", "update", "delete"] as const) {
      expect(cellOf(result, "alice", "nopk", operation)).toMatchObject({
        status: "skipped",
        reason: NO_PRIMARY_KEY_REASON,
        sql: "",
      });
    }
    expect(result.tables.find((table) => table.name === "nopk")).toMatchObject({
      rowCount: null,
      skippedReason: NO_PRIMARY_KEY_REASON,
    });
  });

  it("a persona whose role does not exist is skipped, never run as someone else", () => {
    expect(result.personas.find((persona) => persona.id === "ghost")).toMatchObject({
      roleExists: false,
      rlsBypass: null,
    });
    const ghost = result.cells.filter((cell) => cell.personaId === "ghost");
    expect(ghost.length).toBeGreaterThan(0);
    for (const cell of ghost.filter((entry) => entry.table !== "nopk")) {
      expect(cell).toMatchObject({
        status: "skipped",
        reason: 'The role "no_such_role" does not exist in the database.',
        sql: "",
      });
    }
  });

  it("orders cells by table, persona and operation, and counts them", () => {
    expect(result.cells.slice(0, 5).map((cell) => cell.id)).toEqual([
      "alice|public.nopk|select",
      "alice|public.nopk|insert",
      "alice|public.nopk|update",
      "alice|public.nopk|delete",
      "bob|public.nopk|select",
    ]);
    expect(result.totalCells).toBe(6 * 3 * 4);
    expect(Object.values(result.counts).reduce((sum, count) => sum + count, 0)).toBe(
      result.totalCells,
    );
    expect(result.verdict).toBe("LEAKING");
    expect(result.counts.leak).toBeGreaterThan(0);
  });
});

describe("supabase mode", () => {
  const supabaseScenario = (supabaseGrants: "legacy" | "explicit") =>
    scenarioOf({
      mode: "supabase",
      options: { exposedSchemas: ["public"], supabaseGrants },
      schemaSql: `
        create table todos (id int primary key, user_id uuid not null, title text);
        alter table todos enable row level security;
        create policy own on todos for all to authenticated using (auth.uid() = user_id);
        create table audit_log (id int primary key, user_id uuid not null, line text);
      `,
      seedSql: `
        insert into todos values (1, '${ALICE}', 'a'), (2, '${BOB}', 'b');
        insert into audit_log values (1, '${ALICE}', 'a'), (2, '${BOB}', 'b');
      `,
      personas: [
        { id: "anon", label: "Visitor", dbRole: "anon", claims: {} },
        { id: "alice", label: "Alice", dbRole: "authenticated", claims: { sub: ALICE } },
        { id: "service", label: "Backend", dbRole: "service_role", claims: {} },
      ],
    });

  it("legacy grants: a table without RLS is readable and writable by anon", async () => {
    const { result } = await run(supabaseScenario("legacy"));
    expect(cellOf(result, "anon", "audit_log", "select")).toMatchObject({
      status: "leak",
      scope: "none",
      leakedKeys: keys(1, 2),
      rlsBypass: "rls-disabled",
    });
    expect(cellOf(result, "anon", "audit_log", "delete").status).toBe("leak");
    expect(cellOf(result, "anon", "audit_log", "insert").status).toBe("escape");
    expect(cellOf(result, "anon", "todos", "select")).toMatchObject({
      status: "pass",
      actualKeys: [],
    });
    expect(cellOf(result, "alice", "todos", "select")).toMatchObject({
      status: "pass",
      actualKeys: keys(1),
    });
    expect(result.verdict).toBe("LEAKING");
  }, 60_000);

  it("service_role bypasses RLS legitimately: expected all, flagged, not a leak", async () => {
    const { result } = await run(supabaseScenario("legacy"));
    expect(result.personas.find((persona) => persona.id === "service")).toMatchObject({
      rlsBypass: "bypassrls",
      claimsJson: '{"role":"service_role"}',
    });
    for (const operation of ["select", "update", "delete"] as const) {
      expect(cellOf(result, "service", "todos", operation)).toMatchObject({
        status: "pass",
        scope: "all",
        actualKeys: keys(1, 2),
        rlsBypass: "bypassrls",
      });
    }
    expect(cellOf(result, "service", "todos", "insert").status).toBe("pass");
  }, 60_000);

  it("explicit grants: the same table answers 42501, which is blocked, not inconclusive", async () => {
    const { result } = await run(supabaseScenario("explicit"));
    expect(cellOf(result, "anon", "audit_log", "select")).toMatchObject({
      status: "pass",
      actualKeys: [],
      error: { sqlState: "42501", message: "permission denied for table audit_log" },
    });
    // BYPASSRLS does not bypass the privilege check: service_role expects all and gets nothing.
    expect(cellOf(result, "service", "todos", "select")).toMatchObject({
      status: "overblock",
      missingKeys: keys(1, 2),
    });
  }, 60_000);
});
