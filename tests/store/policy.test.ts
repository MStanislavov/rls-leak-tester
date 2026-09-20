/**
 * The numbers of the store live in three places that must agree: `thresholds.store` in
 * rules.yaml (the source), `src/lib/store/server/policy.ts` (the code) and the check constraints
 * of `supabase/migrations` (the database). This test reads the files, which is why it lives in
 * tests/, and fails when they drift apart.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { MAX_TITLE_LENGTH } from "@/lib/scenario";
import { MAX_SLUG_LENGTH, MIN_SLUG_LENGTH, SLUG_PATTERN, VISIBILITIES } from "@/lib/store";
import {
  LIST_MAX_ROWS,
  SCENARIO_BODY_MAX_BYTES,
  SCENARIO_PAYLOAD_DB_MAX_BYTES,
  SLUG_MAX_ATTEMPTS,
  SLUG_SUFFIX_LENGTH,
  newSlug,
} from "@/lib/store/server";

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const { thresholds } = z
  .object({
    thresholds: z.object({
      store: z.object({
        scenario_body_max_bytes: z.number(),
        scenario_payload_db_max_bytes: z.number(),
        list_max_rows: z.number(),
        slug_suffix_length: z.number(),
        slug_max_attempts: z.number(),
      }),
    }),
  })
  .parse(parse(readFileSync(root("rules.yaml"), "utf8")));

const migration = readdirSync(root("supabase/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => (a < b ? -1 : 1))
  .map((name) => readFileSync(root(`supabase/migrations/${name}`), "utf8"))
  .join("\n");

describe("src/lib/store/server/policy.ts and rules.yaml thresholds.store", () => {
  it("agree", () => {
    expect({
      scenario_body_max_bytes: SCENARIO_BODY_MAX_BYTES,
      scenario_payload_db_max_bytes: SCENARIO_PAYLOAD_DB_MAX_BYTES,
      list_max_rows: LIST_MAX_ROWS,
      slug_suffix_length: SLUG_SUFFIX_LENGTH,
      slug_max_attempts: SLUG_MAX_ATTEMPTS,
    }).toEqual(thresholds.store);
  });

  it("leave room in the database for the text form of the largest accepted body", () => {
    expect(SCENARIO_PAYLOAD_DB_MAX_BYTES).toBeGreaterThan(SCENARIO_BODY_MAX_BYTES);
  });
});

describe("the check constraints of supabase/migrations", () => {
  it("use the same numbers and the same slug rule as the code", () => {
    expect(migration).toContain(`octet_length(payload::text) <= ${SCENARIO_PAYLOAD_DB_MAX_BYTES}`);
    expect(migration).toContain(`char_length(title) between 1 and ${MAX_TITLE_LENGTH}`);
    expect(migration).toContain(
      `char_length(slug) between ${MIN_SLUG_LENGTH} and ${MAX_SLUG_LENGTH}`,
    );
    expect(migration).toContain("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'");
    expect(SLUG_PATTERN.source).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(migration).toContain(
      `visibility in (${VISIBILITIES.map((value) => `'${value}'`).join(", ")})`,
    );
  });

  it("are SQL-first, timestamped migrations", () => {
    const names = readdirSync(root("supabase/migrations"));
    expect(names).toContain("20260920000000_scenarios.sql");
    for (const name of names) expect(name).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});

describe("newSlug", () => {
  it("always passes the slug rule, whatever the title", () => {
    const titles = [
      "Multi-tenant SaaS",
      "  ",
      "Ünïcödé — title!",
      "x".repeat(120),
      "a",
      "-- ; drop",
    ];
    for (const title of titles) {
      const slug = newSlug(title);
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.length).toBeGreaterThanOrEqual(MIN_SLUG_LENGTH);
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
      expect(slug).toMatch(new RegExp(`-[a-z2-7]{${SLUG_SUFFIX_LENGTH}}$`));
    }
  });

  it("is deterministic for a given random source and different otherwise", () => {
    const zeros = (bytes: Uint8Array): Uint8Array => bytes.fill(0);
    expect(newSlug("My title", zeros)).toBe("my-title-aaaaaaaaaaaaaaaa");
    expect(newSlug("My title")).not.toBe(newSlug("My title"));
  });
});
