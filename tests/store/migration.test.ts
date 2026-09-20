/**
 * The migration of the optional Supabase store, loaded into PGlite on top of the project's
 * Supabase shim, and every policy proven with role-switched queries (rules.yaml RUN-001 style:
 * `set_config('role', ...)` inside a transaction that is always rolled back).
 *
 * The suite runs under BOTH default-grant regimes. Under `legacy` the platform grants everything
 * to the API roles before the migration runs; the migration must end in the same place.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SUPABASE_SHIM_SQL, supabaseDefaultGrantsSql } from "@/lib/engine/supabase-shim";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

const SEED_SQL = `
insert into auth.users (id, email) values
  ('${ALICE}', 'alice@example.test'),
  ('${BOB}', 'bob@example.test');
insert into public.scenarios (id, slug, owner, title, payload, visibility, updated_at) values
  ('10000000-0000-4000-8000-000000000001', 'alice-public', '${ALICE}', 'Alice public', '{"n":1}', 'public', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000002', 'alice-unlisted', '${ALICE}', 'Alice unlisted', '{"n":2}', 'unlisted', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000003', 'alice-private', '${ALICE}', 'Alice private', '{"n":3}', 'private', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000004', 'bob-public', '${BOB}', 'Bob public', '{"n":4}', 'public', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000005', 'bob-private', '${BOB}', 'Bob private', '{"n":5}', 'private', '2026-01-01T00:00:00Z');
`;

interface Persona {
  readonly role: "anon" | "authenticated" | "service_role";
  readonly sub?: string;
}

const anon: Persona = { role: "anon" };
const alice: Persona = { role: "authenticated", sub: ALICE };
const bob: Persona = { role: "authenticated", sub: BOB };

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : 1));
  return files.map((name) => readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8")).join("\n");
}

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };

describe.each([
  { regime: "explicit", autoExposeNewTables: false },
  { regime: "legacy", autoExposeNewTables: true },
])(
  "supabase/migrations on the Supabase shim, $regime default grants",
  ({ autoExposeNewTables }) => {
    let db: PGlite;

    beforeAll(async () => {
      db = await PGlite.create();
      await db.exec(SUPABASE_SHIM_SQL);
      await db.exec(supabaseDefaultGrantsSql("public", { autoExposeNewTables }));
      await db.exec(migrationSql());
      await db.exec(SEED_SQL);
    });

    afterAll(async () => {
      await db.close();
    });

    /** Runs `work` as the persona inside a transaction that is always rolled back. */
    async function as<T>(
      persona: Persona,
      work: (tx: Transaction) => Promise<T>,
    ): Promise<Outcome<T>> {
      let outcome: Outcome<T> = { ok: false, code: "not-run" };
      await db.transaction(async (tx) => {
        try {
          const claims =
            persona.sub === undefined
              ? { role: persona.role }
              : { role: persona.role, sub: persona.sub };
          await tx.query("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify(claims),
          ]);
          await tx.query("select set_config('role', $1, true)", [persona.role]);
          outcome = { ok: true, value: await work(tx) };
        } catch (error) {
          outcome = { ok: false, code: String((error as { code?: unknown }).code) };
        } finally {
          await tx.rollback();
        }
      });
      return outcome;
    }

    async function slugsVisibleTo(persona: Persona): Promise<Outcome<string[]>> {
      return as(persona, async (tx) => {
        const result = await tx.query<{ slug: string }>(
          "select slug from public.scenarios order by slug",
        );
        return result.rows.map((row) => row.slug);
      });
    }

    async function bySlug(persona: Persona, slug: string): Promise<Outcome<string[]>> {
      return as(persona, async (tx) => {
        const result = await tx.query<{ slug: string }>(
          "select slug from public.get_scenario_by_slug($1)",
          [slug],
        );
        return result.rows.map((row) => row.slug);
      });
    }

    async function affected(persona: Persona, sql: string): Promise<Outcome<number>> {
      return as(persona, async (tx) => (await tx.query(sql)).affectedRows ?? 0);
    }

    describe("reading the table", () => {
      it("shows an owner all of her rows and the public rows of others, nothing else", async () => {
        expect(await slugsVisibleTo(alice)).toEqual({
          ok: true,
          value: ["alice-private", "alice-public", "alice-unlisted", "bob-public"],
        });
        expect(await slugsVisibleTo(bob)).toEqual({
          ok: true,
          value: ["alice-public", "bob-private", "bob-public"],
        });
      });

      it("shows anon the public rows only", async () => {
        expect(await slugsVisibleTo(anon)).toEqual({
          ok: true,
          value: ["alice-public", "bob-public"],
        });
      });

      it("never returns an unlisted row of somebody else, not even by its exact slug", async () => {
        for (const persona of [anon, bob]) {
          const found = await as(persona, async (tx) => {
            const result = await tx.query(
              "select 1 from public.scenarios where slug = 'alice-unlisted' or visibility = 'unlisted'",
            );
            return result.rows.length;
          });
          expect(found).toEqual({ ok: true, value: 0 });
        }
      });

      it("gives service_role no privilege at all", async () => {
        expect(await slugsVisibleTo({ role: "service_role" })).toEqual({
          ok: false,
          code: "42501",
        });
      });
    });

    describe("get_scenario_by_slug", () => {
      it("returns an unlisted scenario for the exact slug, to anon and to another user", async () => {
        expect(await bySlug(anon, "alice-unlisted")).toEqual({
          ok: true,
          value: ["alice-unlisted"],
        });
        expect(await bySlug(bob, "alice-unlisted")).toEqual({
          ok: true,
          value: ["alice-unlisted"],
        });
      });

      it("returns a public scenario", async () => {
        expect(await bySlug(anon, "bob-public")).toEqual({ ok: true, value: ["bob-public"] });
      });

      it("takes the slug literally: no pattern, no prefix, no case folding, no null", async () => {
        for (const probe of ["alice-%", "alice-unliste", "ALICE-UNLISTED", "%", "_lice-unlisted"]) {
          expect(await bySlug(anon, probe)).toEqual({ ok: true, value: [] });
        }
        const withNull = await as(anon, async (tx) => {
          const result = await tx.query("select 1 from public.get_scenario_by_slug(null)");
          return result.rows.length;
        });
        expect(withNull).toEqual({ ok: true, value: 0 });
      });

      it("never returns a private scenario, except to its owner", async () => {
        expect(await bySlug(anon, "alice-private")).toEqual({ ok: true, value: [] });
        expect(await bySlug(bob, "alice-private")).toEqual({ ok: true, value: [] });
        expect(await bySlug(alice, "alice-private")).toEqual({
          ok: true,
          value: ["alice-private"],
        });
      });

      it("is SECURITY DEFINER with a pinned, empty search_path", async () => {
        const result = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
          "select prosecdef, proconfig from pg_proc where oid = 'public.get_scenario_by_slug(text)'::regprocedure",
        );
        expect(result.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
      });

      it("is executable by anon and authenticated only: not by PUBLIC, not by service_role", async () => {
        await db.exec("create role stranger nologin");
        const result = await db.query<{ role: string; allowed: boolean }>(
          `select r.role, has_function_privilege(r.role, 'public.get_scenario_by_slug(text)', 'execute') as allowed
         from unnest(array['anon', 'authenticated', 'service_role', 'stranger']) as r(role)
         order by r.role`,
        );
        expect(result.rows).toEqual([
          { role: "anon", allowed: true },
          { role: "authenticated", allowed: true },
          { role: "service_role", allowed: false },
          { role: "stranger", allowed: false },
        ]);
        await db.exec("drop role stranger");
      });
    });

    describe("writing", () => {
      it("lets an owner insert (owner defaults to auth.uid()), update and delete her rows", async () => {
        const inserted = await as(alice, async (tx) => {
          const result = await tx.query<{ owner: string; visibility: string }>(
            `insert into public.scenarios (slug, title, payload) values ('alice-new', 'New', '{}')
           returning owner, visibility`,
          );
          return result.rows[0];
        });
        expect(inserted).toEqual({ ok: true, value: { owner: ALICE, visibility: "private" } });

        expect(
          await affected(
            alice,
            "update public.scenarios set title = 'Renamed' where slug = 'alice-private'",
          ),
        ).toEqual({ ok: true, value: 1 });
        expect(
          await affected(alice, "delete from public.scenarios where slug = 'alice-private'"),
        ).toEqual({ ok: true, value: 1 });
      });

      it("refuses a row inserted for somebody else (WITH CHECK)", async () => {
        expect(
          await affected(
            alice,
            `insert into public.scenarios (slug, owner, title, payload) values ('alice-for-bob', '${BOB}', 'x', '{}')`,
          ),
        ).toEqual({ ok: false, code: "42501" });
      });

      it("refuses to hand a row to another owner (WITH CHECK), targeted or not", async () => {
        expect(
          await affected(
            alice,
            `update public.scenarios set owner = '${BOB}' where slug = 'alice-public'`,
          ),
        ).toEqual({ ok: false, code: "42501" });
        expect(await affected(alice, `update public.scenarios set owner = '${BOB}'`)).toEqual({
          ok: false,
          code: "42501",
        });
      });

      it("lets nobody but the owner update or delete a row, public or not", async () => {
        for (const slug of ["alice-public", "alice-unlisted", "alice-private"]) {
          expect(
            await affected(
              bob,
              `update public.scenarios set title = 'pwned' where slug = '${slug}'`,
            ),
          ).toEqual({ ok: true, value: 0 });
          expect(
            await affected(bob, `delete from public.scenarios where slug = '${slug}'`),
          ).toEqual({
            ok: true,
            value: 0,
          });
        }
        // Without a WHERE clause Bob reaches his own two rows and nothing of Alice's.
        expect(await affected(bob, "update public.scenarios set title = 'mine'")).toEqual({
          ok: true,
          value: 2,
        });
        expect(await affected(bob, "delete from public.scenarios")).toEqual({ ok: true, value: 2 });
      });

      it("cannot take over a public row by claiming it", async () => {
        expect(
          await affected(
            bob,
            `update public.scenarios set owner = '${BOB}' where slug = 'alice-public'`,
          ),
        ).toEqual({ ok: true, value: 0 });
      });

      it("gives anon no write at all", async () => {
        for (const sql of [
          "insert into public.scenarios (slug, owner, title, payload) values ('anon-row', null, 'x', '{}')",
          "update public.scenarios set title = 'x'",
          "delete from public.scenarios",
          "truncate public.scenarios",
        ]) {
          expect(await affected(anon, sql)).toEqual({ ok: false, code: "42501" });
        }
      });

      it("sets updated_at on the server, whatever the client sends", async () => {
        const updated = await as(alice, async (tx) => {
          const result = await tx.query<{ fresh: boolean }>(
            `update public.scenarios set title = 'Again', updated_at = '2001-01-01T00:00:00Z'
           where slug = 'alice-public'
           returning updated_at > '2026-01-01T00:00:00Z'::timestamptz as fresh`,
          );
          return result.rows[0]?.fresh;
        });
        expect(updated).toEqual({ ok: true, value: true });
      });
    });

    describe("constraints", () => {
      const insertAsAlice = (columns: string, values: string): Promise<Outcome<number>> =>
        affected(alice, `insert into public.scenarios (${columns}) values (${values})`);

      it.each([
        ["an upper-case slug", "'Bad-Slug', 'x', '{}'"],
        ["a slug with a path", "'a/../b', 'x', '{}'"],
        ["a slug that is too short", "'ab', 'x', '{}'"],
        ["a slug that is too long", `'${"a".repeat(65)}', 'x', '{}'`],
        ["a slug with a double hyphen", "'a--b', 'x', '{}'"],
        ["an empty title", "'good-slug', '', '{}'"],
        ["a title that is too long", `'good-slug', '${"t".repeat(121)}', '{}'`],
        ["a payload that is not an object", "'good-slug', 'x', '[1]'"],
        ["an oversized payload", `'good-slug', 'x', jsonb_build_object('s', repeat('x', 1572864))`],
      ])("refuses %s", async (_name, values) => {
        expect(await insertAsAlice("slug, title, payload", values)).toEqual({
          ok: false,
          code: "23514",
        });
      });

      it("refuses an unknown visibility and a duplicate slug", async () => {
        expect(
          await insertAsAlice(
            "slug, title, payload, visibility",
            "'good-slug', 'x', '{}', 'secret'",
          ),
        ).toEqual({ ok: false, code: "23514" });
        expect(await insertAsAlice("slug, title, payload", "'bob-private', 'x', '{}'")).toEqual({
          ok: false,
          code: "23505",
        });
      });

      it("removes the scenarios of a deleted user", async () => {
        await db.transaction(async (tx) => {
          await tx.query("delete from auth.users where id = $1", [BOB]);
          const left = await tx.query<{ slug: string }>(
            "select slug from public.scenarios where owner = $1",
            [BOB],
          );
          expect(left.rows).toEqual([]);
          await tx.rollback();
        });
      });

      it("has row level security enabled and forced", async () => {
        const result = await db.query(
          "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.scenarios'::regclass",
        );
        expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      });
    });
  },
);
