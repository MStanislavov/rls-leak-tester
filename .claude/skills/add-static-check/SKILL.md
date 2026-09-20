---
name: add-static-check
description: Use when adding a new RLSxxx static check to the catalogue, or changing what an existing one flags, its severity or its wording, including when a finding looks wrong, is missing, or fires on a built-in template.
---

# Add a static check

A finding is a fact read from the catalog snapshot, deterministic, never a verdict and never the
model's opinion (P1, AI-002). It reports only what it can show as evidence; the matrix stays the
proof. Conventions and limits: `docs/adr/0013-static-checks.md`.

## Order of work

1. **Semantics before code.** Read the official Postgres or Supabase page and copy the sentence
   that makes the rule true into an ADR in `docs/adr/` (DOCS-001). That URL becomes `docsUrl`.
   Not memory, not a blog. Then measure in PGlite what the catalog really holds (`pg_get_expr`
   reprints expressions).
2. **Fixtures, watched failing.** In `tests/checks/static-checks.integration.test.ts` add at least
   one positive and one negative SQL fixture, plus the near miss most likely to be a false
   positive (a bypassing role, a restrictive policy, the tool's own Supabase grants).
3. **Implement.** The id in `CHECK_IDS` (`src/lib/checks/types.ts`) and `TemplateCheckId`
   (`src/lib/scenario/templates/types.ts`); the entry with severity, title, summary, `docsUrl` and
   modes in `src/lib/checks/rules.ts`; the function in `table-checks.ts`, `policy-checks.ts` or
   `object-checks.ts`; the call in `src/lib/checks/run.ts`. Pure code (ARCH-001): no database,
   only `Catalog` and context. Missing catalog data goes into `src/lib/runner/introspect.ts`.
   Unit cases on hand-built catalogs: `src/lib/checks/checks.test.ts`.
4. **Catalogue and docs entry.** `/docs` and the lab render `STATIC_CHECK_RULES`; write the
   summary for a user and state what the rule does not see. `src/lib/site/site.test.ts` pins the
   anchors.

```sh
npx vitest run src/lib/checks tests/checks src/lib/site
npx vitest run tests/templates tests/golden
```

## It fires on a template

Decide whether the finding is true. True: declare it in that variant's `expectedStaticChecks` and
explain the changed findings snapshot in the ADR. False: fix the rule. A fixed variant keeps zero
high or critical findings. Never update a snapshot unread (QUAL-002, FA-6).
