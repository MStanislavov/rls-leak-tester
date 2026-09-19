/**
 * A tenant scenario in a leaky and a fixed variant, shared by the determinism, unchanged-database
 * and bypass-guard suites. It touches every probe kind: reach, the per-row fallback, both escape
 * shapes, insert classes with a serial key, and a custom scope.
 */
import { OPERATIONS, type Scenario } from "@/lib/scenario";
import { ALICE, BOB, CAROL, CLAIM, scenarioOf } from "./helpers";

const MY_TENANT = `tenant_id = ${CLAIM("tenant_id")}::int`;
const OWN = `user_id = ${CLAIM("sub")}::uuid`;

export function tenantScenario(variant: "leaky" | "fixed"): Scenario {
  const updateCheck = variant === "leaky" ? "with check (true)" : "";
  return scenarioOf({
    id: `tenant-${variant}`,
    title: `Tenant scenario, ${variant}`,
    schemaSql: `
      create role app_user nologin;
      create role app_anon nologin;

      create table projects (id serial primary key, user_id uuid not null, tenant_id int not null, name text);
      alter table projects enable row level security;
      create policy read on projects for select to app_user using (${MY_TENANT});
      create policy add on projects for insert to app_user with check (${MY_TENANT});
      create policy change on projects for update to app_user using (${MY_TENANT}) ${updateCheck};
      create policy remove on projects for delete to app_user using (${MY_TENANT} and ${OWN});
      grant select, insert, update, delete on projects to app_user, app_anon;
      grant usage on sequence projects_id_seq to app_user, app_anon;

      create table tasks (id int primary key, project_id int not null references projects (id) on delete cascade, user_id uuid not null, done boolean not null default false);
      alter table tasks enable row level security;
      create policy own on tasks for all to app_user using (${OWN});
      grant select, insert, update, delete on tasks to app_user, app_anon;
    `,
    seedSql: `
      insert into projects (user_id, tenant_id, name) values
        ('${ALICE}', 1, 'alpha'), ('${BOB}', 1, 'beta'), ('${CAROL}', 2, 'gamma');
      insert into tasks values (1, 1, '${ALICE}'), (2, 2, '${BOB}'), (3, 3, '${CAROL}');
    `,
    personas: [
      { id: "visitor", label: "Visitor", dbRole: "app_anon", claims: {} },
      {
        id: "alice",
        label: "Alice",
        dbRole: "app_user",
        claims: { sub: ALICE, tenant_id: 1 },
        tenantClaimPath: "tenant_id",
      },
      {
        id: "carol",
        label: "Carol",
        dbRole: "app_user",
        claims: { sub: CAROL, tenant_id: 2 },
        tenantClaimPath: "tenant_id",
      },
    ],
    tables: [
      { schema: "public", name: "projects", ownerColumn: "user_id", tenantColumn: "tenant_id" },
      { schema: "public", name: "tasks", ownerColumn: "user_id" },
    ],
    expectations: [
      ...(["alice", "carol"] as const).flatMap((personaId) =>
        (["select", "insert", "update"] as const).map((operation) => ({
          personaId,
          schema: "public",
          table: "projects",
          operation,
          scope: "tenant" as const,
        })),
      ),
      ...OPERATIONS.map((operation) => ({
        personaId: "visitor",
        schema: "public",
        table: "tasks",
        operation,
        scope: "custom" as const,
        expectedRowsSql: "select id from tasks where user_id = :sub::uuid",
      })),
    ],
  });
}
