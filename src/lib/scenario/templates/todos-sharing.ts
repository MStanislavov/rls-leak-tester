/**
 * Template 3: todos with sharing. A todo is private unless its owner marks it public; public
 * todos are readable by everyone, signed in or not. The leaky variant writes the "everyone may
 * read shared todos" policy as `USING (true)`, so `anon` reads every todo.
 */
import type { TableConfig } from "../types";
import { buildExpectations, defineTemplate, type CellScopes } from "./build";
import {
  ALICE,
  anonPersona,
  authUsersSeedSql,
  BOB,
  CAROL,
  EVERYTHING,
  servicePersona,
  userPersona,
} from "./shared";
import type { ExpectedFailure, TemplateVariantKind } from "./types";

/** Alice and Bob each share one todo. Carol shares nothing. */
export const PUBLIC_TODO_IDS = [
  "70d00000-0000-4000-8000-0000000000a3",
  "70d00000-0000-4000-8000-0000000000b2",
] as const;
export const PRIVATE_TODO_IDS = [
  "70d00000-0000-4000-8000-0000000000a1",
  "70d00000-0000-4000-8000-0000000000a2",
  "70d00000-0000-4000-8000-0000000000b1",
  "70d00000-0000-4000-8000-0000000000c1",
  "70d00000-0000-4000-8000-0000000000c2",
] as const;

const SELECT_PUBLIC_USING: Readonly<Record<TemplateVariantKind, string>> = {
  leaky: `  -- BUG: "everyone may read shared todos" was written as "everyone may read todos".
  using (true)`,
  fixed: `  using (is_public)`,
};

function schemaSql(kind: TemplateVariantKind): string {
  return `-- Todos with sharing. A todo belongs to one user and is private unless is_public is set.
-- Public todos are readable by everyone, including visitors without a session (anon).

create table public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  is_public boolean not null default false
);

alter table public.todos enable row level security;

create policy todos_select_own on public.todos for select to authenticated
  using (user_id = auth.uid());

create policy todos_select_public on public.todos for select to anon, authenticated
${SELECT_PUBLIC_USING[kind]};

create policy todos_insert on public.todos for insert to authenticated
  with check (user_id = auth.uid());

-- No WITH CHECK: Postgres applies USING to the new row, so a todo cannot be given away.
create policy todos_update on public.todos for update to authenticated
  using (user_id = auth.uid());

create policy todos_delete on public.todos for delete to authenticated
  using (user_id = auth.uid());
`;
}

const SEED_SQL = `${authUsersSeedSql([ALICE, BOB, CAROL])}

insert into public.todos (id, user_id, title, done, is_public) values
  ('${PRIVATE_TODO_IDS[0]}', '${ALICE.id}', 'Book the dentist', false, false),
  ('${PRIVATE_TODO_IDS[1]}', '${ALICE.id}', 'Renew passport', true, false),
  ('${PUBLIC_TODO_IDS[0]}', '${ALICE.id}', 'Reading list for the book club', false, true),
  ('${PRIVATE_TODO_IDS[2]}', '${BOB.id}', 'Ask for a raise', false, false),
  ('${PUBLIC_TODO_IDS[1]}', '${BOB.id}', 'Packing list for the hike', false, true),
  ('${PRIVATE_TODO_IDS[3]}', '${CAROL.id}', 'Cancel the gym', false, false),
  ('${PRIVATE_TODO_IDS[4]}', '${CAROL.id}', 'Gift for Alice', false, false);
`;

/** What a visitor without a session may read: the public todos, whoever owns them. */
export const PUBLIC_TODOS_SQL = `select id from public.todos where is_public`;

/** What a signed-in user may read: their own todos and the public ones. `:sub` is the user id. */
export const VISIBLE_TODOS_SQL = `select id from public.todos where is_public or user_id = :sub::uuid`;

const PERSONAS = [
  anonPersona(),
  userPersona(ALICE, "Alice (shares one todo)"),
  userPersona(BOB, "Bob (shares one todo)"),
  userPersona(CAROL, "Carol (shares nothing)"),
  servicePersona(),
];

const TABLES: TableConfig[] = [{ schema: "public", name: "todos", ownerColumn: "user_id" }];

const VISITOR: CellScopes = {
  select: { customSql: PUBLIC_TODOS_SQL },
  insert: "none",
  update: "none",
  delete: "none",
};

/** Sharing is read-only: a public todo is still written by its owner alone. */
const USER: CellScopes = {
  select: { customSql: VISIBLE_TODOS_SQL },
  insert: "own",
  update: "own",
  delete: "own",
};

const EXPECTATIONS = buildExpectations(PERSONAS, [
  {
    schema: "public",
    table: "todos",
    byPersona: { anon: VISITOR, alice: USER, bob: USER, carol: USER, service: EVERYTHING },
  },
]);

/**
 * Only reads leak: every persona under RLS sees the private todos of others. Writes stay
 * correct, because UPDATE and DELETE have their own USING and INSERT its own WITH CHECK.
 */
const EXPECTED_FAILURES: ExpectedFailure[] = ["anon", "alice", "bob", "carol"].map((personaId) => ({
  personaId,
  schema: "public",
  table: "todos",
  operation: "select",
  status: "leak",
}));

export const TODOS_SHARING = defineTemplate({
  id: "todos-sharing",
  title: "Todos with sharing",
  description:
    "A personal todo list. Every todo belongs to one user and is private, unless its owner sets is_public: then everyone may read it, including visitors without a session. Sharing is read-only. Because the public todos belong to nobody's own scope, the read expectations use the custom scope: a visitor reaches the public todos, a user reaches the public todos plus their own.",
  leak: "the policy that lets everyone read shared todos says USING (true) instead of USING (is_public). Policies are combined with OR, so this one policy opens the whole table: anon and every signed-in user read every private todo.",
  fix: "the public read policy says USING (is_public). Private todos are reached only through the owner policy.",
  schemaSql: { leaky: schemaSql("leaky"), fixed: schemaSql("fixed") },
  seedSql: SEED_SQL,
  personas: PERSONAS,
  tables: TABLES,
  expectations: EXPECTATIONS,
  expectedFailures: EXPECTED_FAILURES,
  expectedStaticChecks: [
    { id: "RLS003", schema: "public", table: "todos", policy: "todos_select_public" },
  ],
});
