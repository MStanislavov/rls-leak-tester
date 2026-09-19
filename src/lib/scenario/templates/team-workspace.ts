/**
 * Template 2: team workspace. Access goes through a memberships table, which a column comparison
 * cannot express, so the expectations use the `custom` scope. The leaky variant has a membership
 * subquery that is not correlated to the row's team.
 */
import type { TableConfig } from "../types";
import { buildExpectations, defineTemplate, readOnly, type CellScopes } from "./build";
import {
  ALICE,
  anonPersona,
  authUsersSeedSql,
  BOB,
  CAROL,
  DAVE,
  ERIN,
  EVERYTHING,
  NOTHING,
  servicePersona,
  userPersona,
} from "./shared";
import type { ExpectedFailure, TemplateVariantKind } from "./types";

export const DESIGN_TEAM_ID = "d1000000-0000-4000-8000-000000000001";
export const PLATFORM_TEAM_ID = "d2000000-0000-4000-8000-000000000002";
export const FINANCE_TEAM_ID = "d3000000-0000-4000-8000-000000000003";

export const DESIGN_DOCUMENT_IDS = [
  "d0c00000-0000-4000-8000-000000000011",
  "d0c00000-0000-4000-8000-000000000012",
] as const;
export const PLATFORM_DOCUMENT_IDS = [
  "d0c00000-0000-4000-8000-000000000021",
  "d0c00000-0000-4000-8000-000000000022",
] as const;
export const FINANCE_DOCUMENT_IDS = [
  "d0c00000-0000-4000-8000-000000000031",
  "d0c00000-0000-4000-8000-000000000032",
] as const;

const DOCUMENTS_SELECT_USING: Readonly<Record<TemplateVariantKind, string>> = {
  leaky: `  -- BUG: inside the subquery both names mean memberships.team_id, so this is always true and
  -- the policy only asks "is this user a member of any team at all?".
  using (exists (
    select 1 from public.memberships
    where user_id = auth.uid() and team_id = team_id
  ))`,
  fixed: `  using (exists (
    select 1 from public.memberships
    where user_id = auth.uid() and memberships.team_id = documents.team_id
  ))`,
};

function schemaSql(kind: TemplateVariantKind): string {
  return `-- Team workspace. A user belongs to any number of teams through public.memberships, and a
-- document belongs to one team. No JWT claim can carry that, the policies ask the table.

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

-- A production schema would add unique (team_id, user_id). It is left out so that a cloned row
-- with a fresh id, which is what the insert probe writes, fails on a policy or not at all.
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member'))
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  title text not null,
  body text not null default ''
);

alter table public.teams enable row level security;
alter table public.memberships enable row level security;
alter table public.documents enable row level security;

-- A user reads their own membership rows. This policy looks at no other table, so the
-- membership subqueries below cannot recurse, and they see exactly the caller's memberships.
-- Teams and memberships are written by the backend only.
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid());

create policy teams_select on public.teams for select to authenticated
  using (exists (
    select 1 from public.memberships
    where user_id = auth.uid() and memberships.team_id = teams.id
  ));

-- Documents: members of the team read and edit, create under their own name, and delete only
-- what they created.
create policy documents_select on public.documents for select to authenticated
${DOCUMENTS_SELECT_USING[kind]};

create policy documents_insert on public.documents for insert to authenticated
  with check (created_by = auth.uid() and exists (
    select 1 from public.memberships
    where user_id = auth.uid() and memberships.team_id = documents.team_id
  ));

-- No WITH CHECK: Postgres applies USING to the new row, so a document cannot be moved into a
-- team the user does not belong to.
create policy documents_update on public.documents for update to authenticated
  using (exists (
    select 1 from public.memberships
    where user_id = auth.uid() and memberships.team_id = documents.team_id
  ));

create policy documents_delete on public.documents for delete to authenticated
  using (created_by = auth.uid());
`;
}

const SEED_SQL = `${authUsersSeedSql([ALICE, BOB, CAROL, DAVE, ERIN])}

insert into public.teams (id, name) values
  ('${DESIGN_TEAM_ID}', 'Design'),
  ('${PLATFORM_TEAM_ID}', 'Platform'),
  ('${FINANCE_TEAM_ID}', 'Finance');

-- Bob is in two teams, Dave is in none, Erin (Finance) is not a persona.
insert into public.memberships (id, team_id, user_id, role) values
  ('3e000000-0000-4000-8000-000000000001', '${DESIGN_TEAM_ID}', '${ALICE.id}', 'owner'),
  ('3e000000-0000-4000-8000-000000000002', '${DESIGN_TEAM_ID}', '${BOB.id}', 'member'),
  ('3e000000-0000-4000-8000-000000000003', '${PLATFORM_TEAM_ID}', '${BOB.id}', 'member'),
  ('3e000000-0000-4000-8000-000000000004', '${PLATFORM_TEAM_ID}', '${CAROL.id}', 'owner'),
  ('3e000000-0000-4000-8000-000000000005', '${FINANCE_TEAM_ID}', '${ERIN.id}', 'owner');

insert into public.documents (id, team_id, created_by, title, body) values
  ('${DESIGN_DOCUMENT_IDS[0]}', '${DESIGN_TEAM_ID}', '${ALICE.id}', 'Brand guidelines', 'Logo, colours, type.'),
  ('${DESIGN_DOCUMENT_IDS[1]}', '${DESIGN_TEAM_ID}', '${BOB.id}', 'Icon review', 'Notes from the review.'),
  ('${PLATFORM_DOCUMENT_IDS[0]}', '${PLATFORM_TEAM_ID}', '${BOB.id}', 'Incident runbook', 'Who to call, what to check.'),
  ('${PLATFORM_DOCUMENT_IDS[1]}', '${PLATFORM_TEAM_ID}', '${CAROL.id}', 'Database upgrade plan', 'Steps and rollback.'),
  ('${FINANCE_DOCUMENT_IDS[0]}', '${FINANCE_TEAM_ID}', '${ERIN.id}', 'Salary bands', 'Confidential.'),
  ('${FINANCE_DOCUMENT_IDS[1]}', '${FINANCE_TEAM_ID}', '${ERIN.id}', 'Budget draft', 'Confidential.');
`;

/** The documents of the teams the persona belongs to. Run as superuser; `:sub` is the user id. */
export const MEMBER_DOCUMENTS_SQL = `select d.id
from public.documents d
where exists (
  select 1 from public.memberships m
  where m.team_id = d.team_id and m.user_id = :sub::uuid
)`;

/** The teams the persona belongs to. */
export const MEMBER_TEAMS_SQL = `select t.id
from public.teams t
where exists (
  select 1 from public.memberships m
  where m.team_id = t.id and m.user_id = :sub::uuid
)`;

const PERSONAS = [
  anonPersona(),
  userPersona(ALICE, "Alice (Design)"),
  userPersona(BOB, "Bob (Design and Platform)"),
  userPersona(CAROL, "Carol (Platform)"),
  userPersona(DAVE, "Dave (signed in, no team)"),
  servicePersona(),
];

const TABLES: TableConfig[] = [
  { schema: "public", name: "documents", ownerColumn: "created_by", tenantColumn: "team_id" },
  { schema: "public", name: "memberships", ownerColumn: "user_id", tenantColumn: "team_id" },
  // No tenant column: the team of a teams row is its key. The expectation asks memberships.
  { schema: "public", name: "teams" },
];

const USER_DOCUMENTS: CellScopes = {
  select: { customSql: MEMBER_DOCUMENTS_SQL },
  insert: "own",
  update: { customSql: MEMBER_DOCUMENTS_SQL },
  delete: "own",
};

function forEveryone(users: CellScopes): Record<string, CellScopes> {
  return {
    anon: NOTHING,
    alice: users,
    bob: users,
    carol: users,
    dave: users,
    service: EVERYTHING,
  };
}

const EXPECTATIONS = buildExpectations(PERSONAS, [
  { schema: "public", table: "documents", byPersona: forEveryone(USER_DOCUMENTS) },
  { schema: "public", table: "memberships", byPersona: forEveryone(readOnly("own")) },
  {
    schema: "public",
    table: "teams",
    byPersona: forEveryone(readOnly({ customSql: MEMBER_TEAMS_SQL })),
  },
]);

/**
 * Only the SELECT policy is wrong. Alice, Bob and Carol are each a member of some team, so each
 * reads the documents of teams they do not belong to. Dave is a member of no team: the broken
 * subquery finds nothing for him and his cell passes. UPDATE and DELETE cells pass as well: their
 * own policies are correct and a row must satisfy both.
 */
const EXPECTED_FAILURES: ExpectedFailure[] = ["alice", "bob", "carol"].map((personaId) => ({
  personaId,
  schema: "public",
  table: "documents",
  operation: "select",
  status: "leak",
}));

export const TEAM_WORKSPACE = defineTemplate({
  id: "team-workspace",
  title: "Team workspace",
  description:
    "A document workspace with three teams: Design, Platform and Finance. Users join teams through a memberships table, Bob is in two of them and Dave in none, so no single JWT claim can describe who sees what. The expectations therefore use the custom scope: a query, run as superuser, that lists the documents and teams a user's memberships reach.",
  leak: "the SELECT policy on documents checks membership with team_id = team_id inside the subquery. Both names resolve to memberships.team_id, so the comparison is always true and the policy only asks whether the user is a member of any team. Every member of any team reads the documents of every team, including Finance. No static check sees this; only running the query as each user does.",
  fix: "the subquery is correlated to the row: memberships.team_id = documents.team_id. A user reads a document only through a membership in that document's team.",
  schemaSql: { leaky: schemaSql("leaky"), fixed: schemaSql("fixed") },
  seedSql: SEED_SQL,
  personas: PERSONAS,
  tables: TABLES,
  expectations: EXPECTATIONS,
  expectedFailures: EXPECTED_FAILURES,
  expectedStaticChecks: [],
});
