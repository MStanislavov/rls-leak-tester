/**
 * Template 1: multi-tenant SaaS. The tenant of a request is the JWT claim
 * `app_metadata.tenant_id`. The leaky variant has an UPDATE policy with a correct USING and an
 * explicit `WITH CHECK (true)`: a user can move a row into another tenant.
 */
import type { TableConfig } from "../types";
import { buildExpectations, defineTemplate, readOnly, type CellScopes } from "./build";
import {
  ALICE,
  anonPersona,
  authUsersSeedSql,
  BOB,
  CAROL,
  EVERYTHING,
  NOTHING,
  servicePersona,
  userPersona,
} from "./shared";
import type { ExpectedFailure, TemplateVariantKind } from "./types";

export const ACME_TENANT_ID = "10000000-0000-4000-8000-00000000000a";
export const GLOBEX_TENANT_ID = "20000000-0000-4000-8000-00000000000b";

export const ACME_PROJECT_IDS = [
  "11111111-0000-4000-8000-000000000001",
  "11111111-0000-4000-8000-000000000002",
  "11111111-0000-4000-8000-000000000003",
] as const;
export const GLOBEX_PROJECT_IDS = [
  "22222222-0000-4000-8000-000000000001",
  "22222222-0000-4000-8000-000000000002",
] as const;

const UPDATE_CHECK: Readonly<Record<TemplateVariantKind, string>> = {
  leaky: `  -- BUG: the new row is not checked, so tenant_id may be set to any tenant.
  with check (true)`,
  fixed: `  with check (tenant_id = public.current_tenant_id())`,
};

function schemaSql(kind: TemplateVariantKind): string {
  return `-- Multi-tenant SaaS. The tenant of a request comes from the JWT claim
-- app_metadata.tenant_id. app_metadata is written by the server only; user_metadata is
-- editable by the user and must never decide access.

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  name text not null
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'open'
);

create function public.current_tenant_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
$$;

alter table public.tenants enable row level security;
alter table public.projects enable row level security;
alter table public.invoices enable row level security;

-- Members read their own tenant. Tenants and invoices are written by the backend only.
create policy tenants_select on public.tenants for select to authenticated
  using (id = public.current_tenant_id());

create policy invoices_select on public.invoices for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- Projects: every member reads and edits the projects of the tenant, creates projects under
-- their own name, and deletes only what they created.
create policy projects_select on public.projects for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy projects_insert on public.projects for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and created_by = auth.uid());

create policy projects_update on public.projects for update to authenticated
  using (tenant_id = public.current_tenant_id())
${UPDATE_CHECK[kind]};

create policy projects_delete on public.projects for delete to authenticated
  using (tenant_id = public.current_tenant_id() and created_by = auth.uid());
`;
}

const SEED_SQL = `${authUsersSeedSql([ALICE, BOB, CAROL])}

insert into public.tenants (id, name) values
  ('${ACME_TENANT_ID}', 'Acme Corp'),
  ('${GLOBEX_TENANT_ID}', 'Globex');

insert into public.projects (id, tenant_id, created_by, name) values
  ('${ACME_PROJECT_IDS[0]}', '${ACME_TENANT_ID}', '${ALICE.id}', 'Website relaunch'),
  ('${ACME_PROJECT_IDS[1]}', '${ACME_TENANT_ID}', '${ALICE.id}', 'Mobile app'),
  ('${ACME_PROJECT_IDS[2]}', '${ACME_TENANT_ID}', '${BOB.id}', 'Data warehouse'),
  ('${GLOBEX_PROJECT_IDS[0]}', '${GLOBEX_TENANT_ID}', '${CAROL.id}', 'Payroll migration'),
  ('${GLOBEX_PROJECT_IDS[1]}', '${GLOBEX_TENANT_ID}', '${CAROL.id}', 'Office move');

insert into public.invoices (id, tenant_id, amount_cents, status) values
  ('1a000000-0000-4000-8000-000000000001', '${ACME_TENANT_ID}', 129900, 'paid'),
  ('1a000000-0000-4000-8000-000000000002', '${ACME_TENANT_ID}', 45000, 'open'),
  ('2a000000-0000-4000-8000-000000000001', '${GLOBEX_TENANT_ID}', 990000, 'open'),
  ('2a000000-0000-4000-8000-000000000002', '${GLOBEX_TENANT_ID}', 12500, 'paid');
`;

const TENANT_CLAIM_PATH = "app_metadata.tenant_id";

function member(user: typeof ALICE, tenantName: string, tenantId: string) {
  return userPersona(user, `${user.name} (${tenantName})`, {
    tenantClaimPath: TENANT_CLAIM_PATH,
    claims: { app_metadata: { tenant_id: tenantId } },
  });
}

const PERSONAS = [
  anonPersona(),
  member(ALICE, "Acme", ACME_TENANT_ID),
  member(BOB, "Acme", ACME_TENANT_ID),
  member(CAROL, "Globex", GLOBEX_TENANT_ID),
  servicePersona(),
];

const TABLES: TableConfig[] = [
  { schema: "public", name: "invoices", tenantColumn: "tenant_id" },
  { schema: "public", name: "projects", ownerColumn: "created_by", tenantColumn: "tenant_id" },
  // No tenant column: the tenant of a tenants row is its key, and a key cannot define a scope
  // class for the insert probe. The read expectation asks the claim instead, see below.
  { schema: "public", name: "tenants" },
];

/** The member's own tenant row. Run as superuser; `:claims` is the persona's claims as jsonb. */
export const OWN_TENANT_SQL = `select id from public.tenants
where id = (:claims -> 'app_metadata' ->> 'tenant_id')::uuid`;

const MEMBER_PROJECTS: CellScopes = {
  select: "tenant",
  insert: "own",
  update: "tenant",
  delete: "own",
};

function forEveryone(members: CellScopes): Record<string, CellScopes> {
  return { anon: NOTHING, alice: members, bob: members, carol: members, service: EVERYTHING };
}

const EXPECTATIONS = buildExpectations(PERSONAS, [
  { schema: "public", table: "invoices", byPersona: forEveryone(readOnly("tenant")) },
  { schema: "public", table: "projects", byPersona: forEveryone(MEMBER_PROJECTS) },
  {
    schema: "public",
    table: "tenants",
    byPersona: forEveryone(readOnly({ customSql: OWN_TENANT_SQL })),
  },
]);

/**
 * Only the UPDATE policy is wrong, so only the UPDATE cells of `projects` fail, for every member.
 * The no-op update reach still passes (USING is correct); the scope-escape update succeeds. It
 * succeeds in the WHERE-less shape only: a targeted `WHERE id = ...` reads a column, so the
 * SELECT policy is applied to the new row and blocks the move (ADR 0002).
 */
const EXPECTED_FAILURES: ExpectedFailure[] = ["alice", "bob", "carol"].map((personaId) => ({
  personaId,
  schema: "public",
  table: "projects",
  operation: "update",
  status: "escape",
}));

export const MULTI_TENANT_SAAS = defineTemplate({
  id: "multi-tenant-saas",
  title: "Multi-tenant SaaS",
  description:
    "A B2B application with two customers, Acme and Globex. Every signed-in user carries the tenant in the JWT claim app_metadata.tenant_id, and every policy compares a row's tenant_id with that claim. Members read their tenant's projects and invoices, edit its projects, create projects under their own name and delete only the projects they created.",
  leak: "the UPDATE policy on projects has a correct USING but an explicit WITH CHECK (true). Postgres therefore accepts any new row, and a member can set tenant_id to another tenant: the project lands in a customer account that never asked for it, and leaves the tenant it belonged to.",
  fix: "the UPDATE policy's WITH CHECK repeats its USING expression, so the new row must stay in the member's tenant. Leaving WITH CHECK out would do the same, because Postgres then applies USING to the new row.",
  schemaSql: { leaky: schemaSql("leaky"), fixed: schemaSql("fixed") },
  seedSql: SEED_SQL,
  personas: PERSONAS,
  tables: TABLES,
  expectations: EXPECTATIONS,
  expectedFailures: EXPECTED_FAILURES,
  expectedStaticChecks: [
    // WITH CHECK is literally true for `authenticated` ...
    { id: "RLS003", schema: "public", table: "projects", policy: "projects_update" },
    // ... and it is looser than the policy's USING.
    { id: "RLS004", schema: "public", table: "projects", policy: "projects_update" },
  ],
});
