/**
 * Template 4: RLS Leak Tester verifies itself (brief 3.9, 3.10). The schema is the app's own
 * `scenarios` table, byte for byte the SQL of `supabase/migrations`: owners have full access to
 * their rows, everybody reads `public` rows, and an `unlisted` row is reached only through
 * `get_scenario_by_slug(text)` with the exact slug, never through the table.
 *
 * Unlike the other templates, the FIXED variant is the reality and the leaky one is derived from
 * it: the public read policy also lets `unlisted` rows through, the plausible mistake of writing
 * "whoever has the link may read it" into a policy. Every unlisted scenario can then be listed.
 *
 * The migration writes its own grants, so both variants run under the `explicit` regime, and
 * `service_role` holds no privilege on the table: its cells expect `none`.
 */
import type { TableConfig } from "../types";
import { buildExpectations, defineTemplate, type CellScopes } from "./build";
import { OWN_SCENARIOS_MIGRATIONS_SQL } from "./own-scenarios-migrations";
import {
  ALICE,
  anonPersona,
  authUsersSeedSql,
  BOB,
  CAROL,
  NOTHING,
  servicePersona,
  userPersona,
} from "./shared";
import type { ExpectedFailure } from "./types";

/** Alice and Bob each own one scenario of every visibility. Carol owns nothing. */
export const PUBLIC_SCENARIO_IDS = [
  "5ce00000-0000-4000-8000-0000000000a1",
  "5ce00000-0000-4000-8000-0000000000b1",
] as const;
export const UNLISTED_SCENARIO_IDS = [
  "5ce00000-0000-4000-8000-0000000000a2",
  "5ce00000-0000-4000-8000-0000000000b2",
] as const;
export const PRIVATE_SCENARIO_IDS = [
  "5ce00000-0000-4000-8000-0000000000a3",
  "5ce00000-0000-4000-8000-0000000000b3",
] as const;

/** The slugs of the seeded rows, by visibility: what `get_scenario_by_slug` is called with. */
export const ALICE_SLUGS = {
  public: "alice-tenant-demo",
  unlisted: "alice-review-draft",
  private: "alice-private-notes",
} as const;
export const BOB_SLUGS = {
  public: "bob-todos-demo",
  unlisted: "bob-client-preview",
  private: "bob-private-audit",
} as const;

/** The one expression of the migration that the leaky variant changes. */
export const FIXED_PUBLIC_READ_USING = `using (visibility = 'public');`;
export const LEAKY_PUBLIC_READ_USING = `-- BUG: "whoever has the link may read it" does not belong in a policy. A policy cannot ask for
-- the slug, so this lets every unlisted scenario be listed by anyone.
using (visibility in ('public', 'unlisted'));`;

/**
 * The migration with the public read policy widened. Throws when the expression is not there
 * exactly once: a changed migration must not turn the leaky variant into a copy of the fixed one.
 */
export function leakySchemaSql(fixedSql: string): string {
  const parts = fixedSql.split(FIXED_PUBLIC_READ_USING);
  if (parts.length !== 2) {
    throw new RangeError(
      `The migration must contain "${FIXED_PUBLIC_READ_USING}" exactly once, found ${parts.length - 1}.`,
    );
  }
  return parts.join(LEAKY_PUBLIC_READ_USING);
}

const STAMP = "2026-01-15T09:00:00Z";

function scenarioRow(id: string, slug: string, owner: string, title: string, visibility: string) {
  const payload = JSON.stringify({ version: 1, title });
  return `  ('${id}', '${slug}', '${owner}', '${title}', '${payload}', '${visibility}', '${STAMP}', '${STAMP}')`;
}

/** Users and scenarios: what the application's tables would hold. */
export const SEED_ROWS_SQL = `${authUsersSeedSql([ALICE, BOB, CAROL])}

insert into public.scenarios (id, slug, owner, title, payload, visibility, created_at, updated_at) values
${[
  scenarioRow(PUBLIC_SCENARIO_IDS[0], ALICE_SLUGS.public, ALICE.id, "Tenant demo", "public"),
  scenarioRow(UNLISTED_SCENARIO_IDS[0], ALICE_SLUGS.unlisted, ALICE.id, "Review draft", "unlisted"),
  scenarioRow(PRIVATE_SCENARIO_IDS[0], ALICE_SLUGS.private, ALICE.id, "Private notes", "private"),
  scenarioRow(PUBLIC_SCENARIO_IDS[1], BOB_SLUGS.public, BOB.id, "Todos demo", "public"),
  scenarioRow(UNLISTED_SCENARIO_IDS[1], BOB_SLUGS.unlisted, BOB.id, "Client preview", "unlisted"),
  scenarioRow(PRIVATE_SCENARIO_IDS[1], BOB_SLUGS.private, BOB.id, "Private audit", "private"),
].join(",\n")};
`;

/**
 * The probe harness: part of the seed, never of the migrations. The matrix proves INSERT by
 * cloning a seeded row under a fresh id, and a clone collides with its source on the unique slug
 * (23505: inconclusive, neither allowed nor blocked; a test pins that). Every row inserted after
 * the seed therefore gets a slug made from its id. No policy reads the slug, and a BEFORE ROW
 * trigger runs before WITH CHECK, so the policies still judge the owner and the visibility the
 * persona sent.
 */
export const PROBE_SLUG_HARNESS_SQL = `-- Test harness, not part of the application and not in the migrations. The matrix proves INSERT
-- by cloning a seeded row under a fresh id, and a clone would collide with its source on the
-- unique slug (23505: inconclusive, neither allowed nor blocked). Every row inserted after the
-- seed therefore gets a slug made from its id. No policy reads the slug, and a BEFORE ROW trigger
-- runs before WITH CHECK, so the policies still judge the owner and visibility the persona sent.
create function public.scenarios_probe_slug()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.slug := 'probe-' || pg_catalog.replace(new.id::text, '-', '');
  return new;
end;
$$;

revoke all on function public.scenarios_probe_slug() from public, anon, authenticated, service_role;

create trigger scenarios_probe_slug
before insert on public.scenarios
for each row
execute function public.scenarios_probe_slug();
`;

const SEED_SQL = `${SEED_ROWS_SQL}
${PROBE_SLUG_HARNESS_SQL}`;

/** What a visitor without a session may list: the public scenarios, whoever owns them. */
export const LISTED_SCENARIOS_SQL = `select id from public.scenarios where visibility = 'public'`;

/**
 * What a signed-in user may list: the public scenarios plus their own. Somebody else's unlisted
 * scenario is NOT in it: the exact slug opens it through the function, a query never does.
 */
export const VISIBLE_SCENARIOS_SQL = `select id from public.scenarios where visibility = 'public' or owner = :sub::uuid`;

const PERSONAS = [
  anonPersona(),
  userPersona(ALICE, "Alice (owns three scenarios)"),
  userPersona(BOB, "Bob (owns three scenarios)"),
  userPersona(CAROL, "Carol (signed in, owns nothing)"),
  servicePersona(),
];

const TABLES: TableConfig[] = [{ schema: "public", name: "scenarios", ownerColumn: "owner" }];

const VISITOR: CellScopes = {
  select: { customSql: LISTED_SCENARIOS_SQL },
  insert: "none",
  update: "none",
  delete: "none",
};

/** Publishing is read-only for everybody else: a scenario is written by its owner alone. */
const USER: CellScopes = {
  select: { customSql: VISIBLE_SCENARIOS_SQL },
  insert: "own",
  update: "own",
  delete: "own",
};

const EXPECTATIONS = buildExpectations(PERSONAS, [
  {
    schema: "public",
    table: "scenarios",
    // The app never uses the service key, so the migration grants service_role nothing.
    byPersona: { anon: VISITOR, alice: USER, bob: USER, carol: USER, service: NOTHING },
  },
]);

/**
 * Only reads leak. UPDATE and DELETE need the owner policy as well, and INSERT its WITH CHECK, so
 * nobody writes a row they merely see.
 */
const EXPECTED_FAILURES: ExpectedFailure[] = ["anon", "alice", "bob", "carol"].map((personaId) => ({
  personaId,
  schema: "public",
  table: "scenarios",
  operation: "select",
  status: "leak",
}));

export const OWN_SCENARIOS_TABLE = defineTemplate({
  id: "own-scenarios-table",
  title: "RLS Leak Tester's own scenarios table",
  description:
    "The table this application stores shared scenarios in, exactly as its migrations create it. A scenario belongs to one user and is private, public or unlisted. Owners have full access to their rows, everybody reads public rows, and an unlisted row is opened only by its exact slug through the SECURITY DEFINER function get_scenario_by_slug, so unlisted rows cannot be listed. The schema writes its own grants (the explicit regime), and service_role gets none.",
  leak: "the public read policy says USING (visibility in ('public', 'unlisted')). A policy cannot ask for the slug, so anon and every signed-in user can list every unlisted scenario.",
  fix: "the public read policy says USING (visibility = 'public'), and no policy mentions unlisted rows. They are reached through get_scenario_by_slug(text) alone, with the exact slug. This variant is the SQL of supabase/migrations, unchanged.",
  schemaSql: {
    leaky: leakySchemaSql(OWN_SCENARIOS_MIGRATIONS_SQL),
    fixed: OWN_SCENARIOS_MIGRATIONS_SQL,
  },
  seedSql: SEED_SQL,
  supabaseGrants: "explicit",
  personas: PERSONAS,
  tables: TABLES,
  expectations: EXPECTATIONS,
  expectedFailures: EXPECTED_FAILURES,
  expectedStaticChecks: [],
});
