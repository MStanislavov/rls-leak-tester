-- RLS Leak Tester: shared scenarios (brief 3.10).
--
-- One table, three visibilities:
--   private   only the owner
--   public    everybody may read it and it may be listed
--   unlisted  whoever knows the exact slug may read it; it can never be listed
--
-- Written for Supabase's explicit-grants regime (new projects since 2026-05-30, every project
-- from 2026-10-30): nothing is granted implicitly, so this file grants exactly what each API
-- role needs and takes away whatever a legacy project would have granted by default.
-- The app checks the session on the server first; these policies are the second line of defence
-- and hold on their own, because the anon key is public and PostgREST can be called directly.
--
-- Self-contained and deterministic: no extension, no seed, no dependency on another migration.
-- It loads unchanged in PGlite on top of the project's Supabase shim (tests/store/).

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  payload jsonb not null,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scenarios_slug_key unique (slug),
  -- Lower-case words joined by single hyphens: safe in a URL path and in a cache key.
  constraint scenarios_slug_format check (
    char_length(slug) between 3 and 64 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint scenarios_title_length check (char_length(title) between 1 and 120),
  constraint scenarios_visibility_valid check (visibility in ('public', 'unlisted', 'private')),
  constraint scenarios_payload_is_object check (jsonb_typeof(payload) = 'object'),
  -- The API refuses a body above 1 MiB; jsonb text adds a space after every ':' and ','.
  constraint scenarios_payload_size check (octet_length(payload::text) <= 1572864)
);

comment on table public.scenarios is
  'Scenarios saved by signed-in users. RLS: owner full access, public rows readable, unlisted rows only through get_scenario_by_slug(text).';

create index scenarios_owner_updated_at_idx on public.scenarios (owner, updated_at desc);

-- updated_at is the server's clock, whatever the client sends.
create function public.scenarios_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create trigger scenarios_touch_updated_at
before update on public.scenarios
for each row
execute function public.scenarios_touch_updated_at();

-- ENABLE switches the policies on; FORCE applies them to the table owner as well. Only a
-- superuser or a role with BYPASSRLS (on Supabase: postgres, service_role) still gets past them.
alter table public.scenarios enable row level security;
alter table public.scenarios force row level security;

-- Grants. Start from nothing, whatever the project's default privileges were.
revoke all on table public.scenarios from public, anon, authenticated, service_role;
grant select on table public.scenarios to anon;
grant select, insert, update, delete on table public.scenarios to authenticated;
-- service_role bypasses RLS and this application never uses it: it gets no privilege at all,
-- so a leaked service key cannot read private scenarios through the API.

-- Policies are permissive and OR-ed per command. An UPDATE or DELETE also needs the row to be
-- visible through a SELECT policy, which the owner policy provides.

create policy scenarios_owner_all
on public.scenarios
for all
to authenticated
using (owner = (select auth.uid()))
with check (owner = (select auth.uid()));

create policy scenarios_public_read
on public.scenarios
for select
to anon, authenticated
using (visibility = 'public');

-- There is deliberately NO policy for visibility = 'unlisted': a query on the table can never
-- return somebody else's unlisted row, so unlisted rows cannot be enumerated. The only way in
-- is this function, and only with the exact slug.
--
-- SECURITY DEFINER: it runs as its owner, which must get past RLS (the role that applies
-- migrations on Supabase, postgres, has BYPASSRLS; a superuser does too). The checks RLS would
-- have made are therefore written out in the WHERE clause. search_path is pinned to the empty
-- string and every name is schema-qualified, so no caller can put an object in front of ours.
-- auth.uid() reads the request's JWT claims, which the switch to the definer does not change.
create function public.get_scenario_by_slug(p_slug text)
returns setof public.scenarios
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
  from public.scenarios as s
  where s.slug = p_slug
    and (
      s.visibility in ('public', 'unlisted')
      or s.owner = (select auth.uid())
    )
$$;

comment on function public.get_scenario_by_slug(text) is
  'Returns the scenario with exactly this slug when it is public or unlisted, or when the caller owns it.';

-- Postgres grants EXECUTE to PUBLIC on every new function, and a legacy Supabase project grants
-- it to the API roles by default privileges. Take both away, then grant what is needed.
revoke all on function public.get_scenario_by_slug(text) from public, anon, authenticated, service_role;
grant execute on function public.get_scenario_by_slug(text) to anon, authenticated;

revoke all on function public.scenarios_touch_updated_at() from public, anon, authenticated, service_role;
