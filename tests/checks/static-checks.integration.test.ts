/**
 * RLS001 to RLS009 against a real Postgres: every fixture is SQL that is loaded into a fresh
 * PGlite through the real setup pipeline and read back by the real introspection, so the checks
 * are proven on what `pg_get_expr`, `relacl` and `reloptions` actually contain. Each rule has at
 * least one positive and one negative fixture.
 */
import { describe, expect, it } from "vitest";
import { runStaticChecks, type CheckId, type Finding, type StaticCheckContext } from "@/lib/checks";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { introspect } from "@/lib/runner/introspect";
import { setupDatabase } from "@/lib/runner/setup";

interface Fixture {
  readonly rule: CheckId;
  readonly name: string;
  readonly context: StaticCheckContext;
  readonly schemaSql: string;
  /** `object.qualifiedName` of every finding of `rule`, in output order. Empty: a negative. */
  readonly expected: readonly string[];
  /** Evidence `label: value` lines that must be present on the first finding of `rule`. */
  readonly evidence?: readonly string[];
}

const SUPABASE: StaticCheckContext = { mode: "supabase", personas: [{ dbRole: "authenticated" }] };
const SUPABASE_EXPLICIT: StaticCheckContext = {
  ...SUPABASE,
  options: { exposedSchemas: ["public"], supabaseGrants: "explicit" },
};
const postgres = (...roles: string[]): StaticCheckContext => ({
  mode: "postgres",
  personas: roles.map((dbRole) => ({ dbRole })),
});

const NOTES = `create table public.notes (id int primary key, user_id uuid, tenant_id int, status text);`;
const NOTES_RLS = `${NOTES}
alter table public.notes enable row level security;`;
const OWN = `(auth.uid() = user_id)`;

const FIXTURES: readonly Fixture[] = [
  {
    rule: "RLS001",
    name: "positive: a table without row level security, reachable through the legacy grants",
    context: SUPABASE,
    schemaSql: NOTES,
    expected: ['"public"."notes"'],
    evidence: [
      "row level security: not enabled",
      "granted to anon: SELECT, INSERT, UPDATE, DELETE, TRUNCATE",
      "granted to authenticated: SELECT, INSERT, UPDATE, DELETE, TRUNCATE",
    ],
  },
  {
    rule: "RLS001",
    name: "negative: row level security enabled",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create policy own on public.notes for select to authenticated using ${OWN};`,
    expected: [],
  },
  {
    rule: "RLS002",
    name: "positive: enabled, no policy",
    context: SUPABASE,
    schemaSql: NOTES_RLS,
    expected: ['"public"."notes"'],
    evidence: ["policies: 0", "force row level security: no"],
  },
  {
    rule: "RLS002",
    name: "negative: enabled with a policy",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create policy own on public.notes for select to authenticated using ${OWN};`,
    expected: [],
  },
  {
    rule: "RLS003",
    name: "positive: true in any spelling, for PUBLIC and for a named role",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create policy a_read_all on public.notes for select using ((TRUE));
create policy b_insert_all on public.notes for insert to authenticated with check ('t'::boolean);`,
    expected: ['"a_read_all" ON "public"."notes"', '"b_insert_all" ON "public"."notes"'],
    evidence: ["literally true: USING", "roles: PUBLIC", "using: true"],
  },
  {
    rule: "RLS003",
    name: "negative: service_role only, a restrictive true, and a tautology that is not a literal",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create policy svc on public.notes for all to service_role using (true) with check (true);
create policy narrow on public.notes as restrictive for select using (true);
create policy tautology on public.notes for select to authenticated using (1 = 1);`,
    expected: [],
  },
  {
    rule: "RLS004",
    name: "positive: WITH CHECK (true), a dropped condition, and a check-only policy",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create policy a_check_true on public.notes for update to authenticated
  using ${OWN} with check (true);
create policy b_drops_tenant on public.notes for all to authenticated
  using (auth.uid() = user_id and tenant_id = 1) with check (auth.uid() = user_id);
create policy c_check_only on public.notes for update to authenticated with check (true);
create policy d_restrictive on public.notes as restrictive for all to authenticated
  using (tenant_id = 1) with check (true);`,
    expected: [
      '"a_check_true" ON "public"."notes"',
      '"b_drops_tenant" ON "public"."notes"',
      '"c_check_only" ON "public"."notes"',
      '"d_restrictive" ON "public"."notes"',
    ],
    evidence: ["using: (auth.uid() = user_id)", "with check: true"],
  },
  {
    rule: "RLS004",
    name: "negative: a missing WITH CHECK, an identical one, a stricter one, and INSERT (true)",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create policy missing_update on public.notes for update to authenticated using ${OWN};
create policy missing_all on public.notes for all to authenticated using ${OWN};
create policy identical on public.notes for update to authenticated using ${OWN} with check ${OWN};
create policy stricter on public.notes for update to authenticated
  using ${OWN} with check (auth.uid() = user_id and status = 'draft');
create policy other_condition on public.notes for update to authenticated
  using (tenant_id = 1) with check (tenant_id > 0);
create policy insert_any on public.notes for insert to authenticated with check (true);`,
    expected: [],
  },
  {
    rule: "RLS005",
    name: "positive: user_metadata through ->, #>> and the raw claims setting",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create policy a_arrow on public.notes for select to authenticated
  using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
create policy b_path on public.notes for update to authenticated
  using ${OWN} with check ((auth.jwt() #>> '{user_metadata,tenant_id}')::int = tenant_id);
create policy c_setting on public.notes for delete to authenticated
  using ((current_setting('request.jwt.claims', true)::jsonb -> 'user_metadata' ->> 'role') = 'admin');
create policy d_users on public.notes for select to authenticated
  using (exists (select 1 from auth.users u where u.id = auth.uid() and u.raw_user_meta_data ->> 'role' = 'admin'));`,
    expected: [
      '"a_arrow" ON "public"."notes"',
      '"b_path" ON "public"."notes"',
      '"c_setting" ON "public"."notes"',
      '"d_users" ON "public"."notes"',
    ],
    evidence: ["reads user_metadata in: USING"],
  },
  {
    rule: "RLS005",
    name: "negative: app_metadata, and a column of the user's own table",
    context: SUPABASE,
    schemaSql: `create table public.notes (id int primary key, user_id uuid, user_metadata jsonb);
alter table public.notes enable row level security;
create policy app on public.notes for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy own_column on public.notes for select to authenticated
  using ((user_metadata ->> 'visible') = 'yes');`,
    expected: [],
  },
  {
    rule: "RLS006",
    name: "positive (legacy grants): a grant to PUBLIC, while the tool's own anon grants stay quiet",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
grant insert, update on public.notes to public;`,
    expected: ['"public"."notes"'],
    evidence: ["granted to PUBLIC: INSERT, UPDATE", "row level security: yes"],
  },
  {
    rule: "RLS006",
    name: "positive (explicit grants): the user's own grant to anon, without the TRUNCATE residue",
    context: SUPABASE_EXPLICIT,
    schemaSql: `${NOTES_RLS}
grant select, insert, delete on public.notes to anon;`,
    expected: ['"public"."notes"'],
    evidence: ["granted to anon: INSERT, DELETE"],
  },
  {
    rule: "RLS006",
    name: "positive (postgres mode): TRUNCATE for a role called anon",
    context: postgres("app_user"),
    schemaSql: `create role anon nologin; create role app_user nologin;
${NOTES_RLS}
grant select, truncate on public.notes to anon;`,
    expected: ['"public"."notes"'],
    evidence: ["granted to anon: TRUNCATE"],
  },
  {
    rule: "RLS006",
    name: "negative (legacy grants): nothing but the blanket grants of the platform",
    context: SUPABASE,
    schemaSql: NOTES_RLS,
    expected: [],
  },
  {
    rule: "RLS006",
    name: "negative (explicit grants): anon reads, authenticated writes",
    context: SUPABASE_EXPLICIT,
    schemaSql: `${NOTES_RLS}
grant select on public.notes to anon;
grant select, insert, update, delete on public.notes to authenticated;`,
    expected: [],
  },
  {
    rule: "RLS007",
    name: "positive: SECURITY DEFINER without SET search_path, one of two overloads",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create function public.is_owner(note int) returns boolean language sql stable security definer
  as $$ select exists (select 1 from public.notes where id = note and user_id = auth.uid()) $$;
create function public.is_owner(note int, who uuid) returns boolean language sql stable
  security definer set search_path = ''
  as $$ select exists (select 1 from public.notes where id = note and user_id = who) $$;`,
    expected: ['"public"."is_owner"(note integer)'],
    evidence: ["search_path: not set", "owner: postgres"],
  },
  {
    rule: "RLS007",
    name: "negative: a pinned search_path, and a SECURITY INVOKER function without one",
    context: SUPABASE,
    schemaSql: `create function public.pinned() returns int language sql security definer
  set search_path = pg_catalog, pg_temp as 'select 1';
create function public.invoker() returns int language sql as 'select 1';`,
    expected: [],
  },
  {
    rule: "RLS008",
    name: "positive: a plain view and a materialized view over a protected table",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create view public.a_notes_view as select id, status from public.notes;
create materialized view public.b_notes_cache as select id, status from public.notes;`,
    expected: ['"public"."a_notes_view"', '"public"."b_notes_cache"'],
    evidence: [
      "security_invoker: not set",
      'row level security of: "public"."notes": skipped entirely, the view owner is a superuser or has BYPASSRLS',
    ],
  },
  {
    rule: "RLS008",
    name: "negative: a security invoker view, a view over it, and a view over an unprotected table",
    context: SUPABASE,
    schemaSql: `${NOTES_RLS}
create table public.countries (code text primary key);
create view public.notes_safe with (security_invoker = true) as select id from public.notes;
create view public.notes_safe_again as select id from public.notes_safe;
create view public.country_codes as select code from public.countries;`,
    expected: [],
  },
  {
    rule: "RLS008",
    name: "positive: explicit grants, the view is granted to an API role",
    context: SUPABASE_EXPLICIT,
    schemaSql: `${NOTES_RLS}
create view public.notes_view as select id, status from public.notes;
grant select on public.notes_view to anon;`,
    expected: ['"public"."notes_view"'],
    evidence: ["reachable by: anon"],
  },
  {
    rule: "RLS008",
    name: "negative: explicit grants, no application role was granted the view",
    context: SUPABASE_EXPLICIT,
    schemaSql: `${NOTES_RLS}
create view public.notes_view as select id, status from public.notes;
create materialized view public.notes_cache as select id, status from public.notes;`,
    expected: [],
  },
  {
    rule: "RLS009",
    name: "positive: owned by a persona's role, and by a role a persona is a member of",
    context: postgres("app_user", "alice"),
    schemaSql: `create role app_user nologin; create role team nologin; create role alice nologin;
grant team to alice;
create table public.a_direct (id int primary key);
alter table public.a_direct owner to app_user;
alter table public.a_direct enable row level security;
create table public.b_member (id int primary key);
alter table public.b_member owner to team;
alter table public.b_member enable row level security;`,
    expected: ['"public"."a_direct"', '"public"."b_member"'],
    evidence: ["owner: app_user", "application roles with the owner's rights: app_user"],
  },
  {
    rule: "RLS009",
    name: "negative: FORCE is set, the owner is no application role, or the member does not inherit",
    context: postgres("app_user", "bob"),
    schemaSql: `create role app_user nologin; create role migrator nologin;
create role team nologin; create role bob nologin noinherit;
grant team to bob;
create table public.forced (id int primary key);
alter table public.forced owner to app_user;
alter table public.forced enable row level security;
alter table public.forced force row level security;
create table public.migrated (id int primary key);
alter table public.migrated owner to migrator;
alter table public.migrated enable row level security;
create table public.team_owned (id int primary key);
alter table public.team_owned owner to team;
alter table public.team_owned enable row level security;`,
    expected: [],
  },
];

async function findingsFor(fixture: Fixture): Promise<Finding[]> {
  const engine = await createPgliteEngine();
  try {
    await setupDatabase(
      engine,
      {
        mode: fixture.context.mode,
        schemaSql: fixture.schemaSql,
        seedSql: "",
        options: fixture.context.options,
      },
      SUPABASE_SETUP_SQL,
    );
    const catalog = await introspect(engine, ["public"]);
    return runStaticChecks(catalog, fixture.context);
  } finally {
    await engine.close();
  }
}

describe("static checks on SQL loaded into PGlite", () => {
  it.each(FIXTURES)(
    "$rule $name",
    async (fixture) => {
      const findings = await findingsFor(fixture);
      const ofRule = findings.filter((finding) => finding.id === fixture.rule);

      expect(ofRule.map((finding) => finding.object.qualifiedName)).toEqual(fixture.expected);
      const lines = (ofRule[0]?.evidence ?? []).map((entry) => `${entry.label}: ${entry.value}`);
      for (const line of fixture.evidence ?? []) {
        expect(lines).toContain(line);
      }
      for (const finding of findings) {
        expect(finding.docsUrl).toMatch(/^https:\/\/(www\.postgresql\.org|supabase\.com)\/docs\//);
        expect(finding.explanation).not.toContain("\n");
        expect(finding.evidence.length).toBeGreaterThan(0);
      }
    },
    60_000,
  );

  it("covers every rule with a positive and a negative fixture", () => {
    for (const rule of new Set(FIXTURES.map((fixture) => fixture.rule))) {
      const ofRule = FIXTURES.filter((fixture) => fixture.rule === rule);
      expect(ofRule.some((fixture) => fixture.expected.length > 0)).toBe(true);
      expect(ofRule.some((fixture) => fixture.expected.length === 0)).toBe(true);
    }
    expect(new Set(FIXTURES.map((fixture) => fixture.rule)).size).toBe(9);
  });

  it("gives byte-identical, ordered output for one leaky schema in both runs (P6)", async () => {
    const fixture: Fixture = {
      rule: "RLS001",
      name: "mixed",
      context: SUPABASE,
      schemaSql: `${NOTES_RLS}
create policy open on public.notes for all using (true) with check (true);
create table public.zeta (id int primary key);
create table public.alpha (id int primary key);
alter table public.alpha enable row level security;
grant delete on public.alpha to public;
create view public.notes_view as select * from public.notes;
create function public.f() returns int language sql security definer as 'select 1';`,
      expected: [],
    };
    const first = await findingsFor(fixture);
    const second = await findingsFor(fixture);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(
      first.map((finding) => `${finding.severity} ${finding.id} ${finding.object.name}`),
    ).toEqual([
      "critical RLS001 zeta",
      "high RLS003 open",
      "high RLS008 notes_view",
      "medium RLS006 alpha",
      "medium RLS007 f",
      "info RLS002 alpha",
    ]);
  }, 60_000);
});
