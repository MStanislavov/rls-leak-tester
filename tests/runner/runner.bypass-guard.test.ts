/**
 * Bypass guards of the matrix runner (RUN-001, brief 5.1).
 *
 * Row level security does not apply to a superuser, to a role with BYPASSRLS, or to a table owner
 * without FORCE. The engine's session user is a superuser, so a probe that ran without the role
 * switch would see and write everything. This suite proves, against a real PGlite:
 *
 *   1. every probe statement the runner sends runs with `current_user` = the persona's role; the
 *      superuser only ever reads (ground truth, read-backs, expectedRowsSql),
 *   2. a persona that IS a bypassing role (superuser, BYPASSRLS, owner without FORCE, a member of
 *      the owner) is probed truthfully and FLAGGED, never silently; FORCE removes the owner's flag,
 *   3. the regression this guards against is caught: a probe executor that forgets the role switch
 *      turns every cell inconclusive (NOT PROVEN) through the identity check inside the executor,
 *      and without that check it would report both variants of a scenario wrongly.
 *
 * The engine-level half (the switch itself filters) is tests/engine/engine-role-switch.bypass-guard.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { createProbeExecutor, type MatrixResult } from "@/lib/runner";
import type { SqlEngine } from "@/lib/runner/types";
import { tenantScenario } from "./fixtures";
import { ALICE, BOB, CLAIM, cellOf, keys, run, scenarioOf } from "./helpers";

interface Observed {
  readonly sql: string;
  /** `current_user` at the moment the statement was sent. */
  readonly role: string;
}

/** A real engine that notes, for every statement inside a transaction, who `current_user` is. */
async function observingEngine(log: Observed[]): Promise<SqlEngine> {
  const inner = await createPgliteEngine();
  return {
    ...inner,
    transaction: (callback) =>
      inner.transaction((tx) =>
        callback({
          exec: (sql) => tx.exec(sql),
          rollback: () => tx.rollback(),
          get closed() {
            return tx.closed;
          },
          query: async (sql, params) => {
            const who = await tx
              .query("select current_user::text as role")
              .then((result) => String(result.rows[0]?.role))
              .catch(() => "(transaction aborted)");
            log.push({ sql, role: who });
            return tx.query(sql, params);
          },
        }),
      ),
  };
}

const WRITES = /^(insert|update|delete)\b/i;
const SESSION_USER = "postgres";

describe("bypass guard: who runs the probes", () => {
  it("no INSERT, UPDATE or DELETE and no reach SELECT ever runs as the session superuser", async () => {
    const log: Observed[] = [];
    const { result } = await run(tenantScenario("leaky"), {
      createEngine: () => observingEngine(log),
    });
    expect(result.totalCells).toBe(24);

    const writes = log.filter((entry) => WRITES.test(entry.sql));
    expect(writes.length).toBeGreaterThan(30);
    expect(writes.filter((entry) => entry.role === SESSION_USER)).toEqual([]);
    expect(new Set(writes.map((entry) => entry.role))).toEqual(new Set(["app_user", "app_anon"]));

    // Whatever the superuser ran inside a transaction is a role switch or a read. The reach SELECT
    // has no WHERE; as the superuser that text appears only as the read-back after RESET ROLE.
    const asSuperuser = log.filter((entry) => entry.role === SESSION_USER);
    for (const [index, entry] of log.entries()) {
      if (
        entry.role !== SESSION_USER ||
        !/^select "id"::text as k0 from "public"\."\w+"$/.test(entry.sql)
      ) {
        continue;
      }
      expect(log[index - 1]?.sql).toBe("reset role");
    }
    // Besides reads the superuser does one thing: it copies a seeded row into the temporary
    // source table and lets the persona read it (insert clones, the blind UPDATE).
    const SUPERUSER_STATEMENTS =
      /^(select\b|create temporary table "rls_leak_tester_source" on commit drop as select \* from "public"\."\w+" where |grant select on pg_temp\."rls_leak_tester_source" to "app_\w+"$)/;
    expect(asSuperuser.filter((entry) => !SUPERUSER_STATEMENTS.test(entry.sql))).toEqual([]);
    expect(asSuperuser.some((entry) => entry.sql.startsWith("create temporary table"))).toBe(true);
  }, 60_000);

  it("every probe transaction pins the session and checks current_user before the probe", async () => {
    const { result } = await run(tenantScenario("fixed"));
    const scripts = result.cells.flatMap((cell) => [
      cell.sql,
      ...cell.subProbes.map((probe) => probe.sql),
    ]);
    const ran = scripts.filter((sql) => sql !== "");
    expect(ran.length).toBeGreaterThan(result.totalCells);
    for (const sql of ran) {
      for (const transaction of sql.split("begin;").slice(1)) {
        const lines = transaction
          .trim()
          .split("\n")
          .filter((line) => line !== "" && !line.startsWith("--"));
        expect(lines[0]).toMatch(/^select set_config\('role', '(app_user|app_anon)', true\);$/);
        expect(lines[1]).toMatch(/^select set_config\('request\.jwt\.claims', /);
        expect(lines[2]).toMatch(
          /^select set_config\('request\.jwt\.claim\.sub', '', true\), .*set_config\('row_security', 'on', true\), set_config\('TimeZone', 'UTC', true\);$/,
        );
        expect(lines[3]).toBe(
          "select current_user::text as role, session_user::text as session_role, current_setting('row_security') as row_security;",
        );
        expect(lines.at(-1)).toBe("rollback;");
      }
    }
  }, 60_000);
});

describe("bypass guard: personas that bypass RLS are flagged, never silent", () => {
  const own = `owner = ${CLAIM("sub")}`;
  const scenario = scenarioOf({
    schemaSql: `
      create role app_user nologin;
      create role app_owner nologin;
      create role app_deputy nologin in role app_owner;
      create role app_admin nologin bypassrls;
      create table docs (id int primary key, owner text not null);
      create table docs_forced (id int primary key, owner text not null);
      alter table docs owner to app_owner;
      alter table docs_forced owner to app_owner;
      alter table docs enable row level security;
      alter table docs_forced enable row level security;
      alter table docs_forced force row level security;
      create policy own on docs using (${own});
      create policy own on docs_forced using (${own});
      grant select on docs, docs_forced to app_user, app_admin, app_deputy;
    `,
    seedSql: `
      insert into docs values (1, '${ALICE}'), (2, '${ALICE}'), (3, '${BOB}');
      insert into docs_forced values (1, '${ALICE}'), (2, '${ALICE}'), (3, '${BOB}');
    `,
    personas: [
      { id: "user", label: "User", dbRole: "app_user", claims: { sub: BOB } },
      { id: "owner", label: "Owner", dbRole: "app_owner", claims: { sub: BOB } },
      { id: "deputy", label: "Deputy", dbRole: "app_deputy", claims: { sub: BOB } },
      { id: "admin", label: "Admin", dbRole: "app_admin", claims: { sub: BOB } },
      { id: "root", label: "Root", dbRole: "postgres", claims: { sub: BOB } },
    ],
    tables: [
      { schema: "public", name: "docs", ownerColumn: "owner" },
      { schema: "public", name: "docs_forced", ownerColumn: "owner" },
    ],
  });

  let result: MatrixResult;
  const select = (persona: string, table: string) => cellOf(result, persona, table, "select");

  it("runs", async () => {
    result = (await run(scenario)).result;
    expect(result.verdict).toBe("LEAKING");
  }, 60_000);

  it("a plain role is filtered and carries no flag", () => {
    for (const table of ["docs", "docs_forced"]) {
      expect(select("user", table)).toMatchObject({
        status: "pass",
        actualKeys: keys(3),
        rlsBypass: null,
      });
    }
  });

  it("owner, member of the owner, BYPASSRLS role and superuser see everything AND say why", () => {
    expect(select("owner", "docs")).toMatchObject({ status: "leak", rlsBypass: "table-owner" });
    expect(select("deputy", "docs")).toMatchObject({ status: "leak", rlsBypass: "table-owner" });
    expect(select("admin", "docs")).toMatchObject({ status: "leak", rlsBypass: "bypassrls" });
    expect(select("root", "docs")).toMatchObject({ status: "leak", rlsBypass: "superuser" });
    for (const persona of ["owner", "deputy", "admin", "root"]) {
      expect(select(persona, "docs").leakedKeys).toEqual(keys(1, 2));
    }
  });

  it("FORCE puts the owner and its member under the policy; the flag goes away with the bypass", () => {
    expect(select("owner", "docs_forced")).toMatchObject({
      status: "pass",
      actualKeys: keys(3),
      rlsBypass: null,
    });
    expect(select("deputy", "docs_forced")).toMatchObject({ status: "pass", rlsBypass: null });
    expect(select("admin", "docs_forced")).toMatchObject({
      status: "leak",
      rlsBypass: "bypassrls",
    });
    expect(select("root", "docs_forced")).toMatchObject({ status: "leak", rlsBypass: "superuser" });
  });

  it("no cell reaches more than its policy allows without a flag", () => {
    const unflaggedLeaks = result.cells.filter(
      (cell) => cell.leakedKeys.length > 0 && cell.rlsBypass === null,
    );
    expect(unflaggedLeaks).toEqual([]);
    expect(result.personas.map((persona) => [persona.id, persona.rlsBypass])).toEqual([
      ["user", null],
      ["owner", null],
      ["deputy", null],
      ["admin", "bypassrls"],
      ["root", "superuser"],
    ]);
  });
});

describe("bypass guard: a probe executor that forgets the role switch", () => {
  const forgetful = { switchIdentity: () => [] };

  it("is caught by the identity check: every cell inconclusive, verdict NOT PROVEN", async () => {
    for (const variant of ["leaky", "fixed"] as const) {
      const { result } = await run(tenantScenario(variant), {
        executor: createProbeExecutor(forgetful),
      });
      expect(result.verdict).toBe("NOT PROVEN");
      expect(result.counts).toMatchObject({ pass: 0, leak: 0, escape: 0, overblock: 0 });
      expect(result.counts.inconclusive).toBe(result.totalCells);
      for (const cell of result.cells) {
        expect(cell.reason).toContain('would have run as "postgres" instead of "app_');
        expect(cell.actualKeys).toEqual([]);
      }
    }
  }, 60_000);

  it("without the check it would lie: the fixed scenario reads as LEAKING, the leaky one differently", async () => {
    const blind = createProbeExecutor({ ...forgetful, verifyIdentity: false });
    const honestFixed = (await run(tenantScenario("fixed"))).result;
    const honestLeaky = (await run(tenantScenario("leaky"))).result;
    const brokenFixed = (await run(tenantScenario("fixed"), { executor: blind })).result;
    const brokenLeaky = (await run(tenantScenario("leaky"), { executor: blind })).result;

    expect(honestFixed.verdict).toBe("ISOLATED");
    expect(brokenFixed.verdict).toBe("LEAKING");
    // As the superuser the visitor reads every project; honestly it reads none.
    expect(cellOf(honestFixed, "visitor", "projects", "select")).toMatchObject({
      status: "pass",
      actualKeys: [],
    });
    expect(cellOf(brokenFixed, "visitor", "projects", "select")).toMatchObject({
      status: "leak",
      leakedKeys: keys(1, 2, 3),
    });

    // The leaky scenario's real finding is two escapes; the broken executor buries them.
    const statuses = (matrix: MatrixResult): string[] => matrix.cells.map((cell) => cell.status);
    expect(honestLeaky.counts).toMatchObject({ leak: 0, escape: 2 });
    expect(statuses(brokenLeaky)).not.toEqual(statuses(honestLeaky));
    expect(brokenLeaky.counts.leak).toBeGreaterThan(10);
    // Both broken runs look the same: the policies no longer matter, which is the whole danger.
    expect(statuses(brokenLeaky)).toEqual(statuses(brokenFixed));
  }, 120_000);
});
