# ADR (draft): app shell, landing page and /docs

- Status: proposed (draft, numbered by the orchestrator)
- Date: 2026-09-20
- Phase: 5 (task U1)
- Builds on: ADR 0003 (nonce CSP, every route dynamic), 0013 (static checks), 0014 (templates)

## Context

Task U1 builds the root layout, `/`, `/docs`, the 404 and the error page. Three points differ from
the literal wording of the brief or settle something it leaves open.

## Decisions

### 1. /docs names Share as a second way SQL leaves the browser (deviation from brief 4.7)

Brief 4.7 says "SQL leaves the browser only when the user presses Explain". Brief 3.10 also
specifies Share, which stores the scenario JSON, schema and seed SQL included, in the optional
Supabase store. Both cannot be literally true on a deployment with sharing configured, and /docs
is where a security reviewer reads the privacy claim. The page therefore says: nothing is sent
while you edit or run; data leaves the tab only when you ask for it, through Explain (the slice of
brief 3.7, capped and validated) or through Share (only when sign-in is configured; otherwise
scenarios stay in local storage). The footer keeps the short form, "Your SQL runs in your browser.
The server never executes it.", which is true in every configuration.

If the owner wants the literal sentence of 4.7, Share has to stop uploading SQL or the sentence
has to be qualified; the docs should not claim more than the product does.

### 2. Links to /lab are never prefetched

`<Link>` prefetches in production. All routes are dynamic (ADR 0003), so the default prefetch is
small, but whether it stays small depends on what the lab segment contains (a `loading.tsx`
changes it). `prefetch={false}` on every link to `/lab` (`NAV_ITEMS[].prefetch`, the hero button,
the template buttons, the 404 page) makes "the landing page requests nothing of the lab" a
property of this code instead of a property of the lab's files. Cost: the first navigation to the
lab is not warmed up. `e2e/site.spec.ts` asserts no request under `/lab`, in production mode, where
prefetching is active.

### 3. The landing page's `<h1>` is the product name

`e2e/lab-pglite-csp.spec.ts` asserts `h1` equals "RLS Leak Tester" on `/` and "404" on the 404
page. Both contracts were kept instead of editing a spec this task does not own. The visual
headline of the landing page is a large paragraph below the `h1`.

### 4. Pages render their own `<main>`; the layout provides the skip-link target

The root layout wraps `children` in `<div id="content" tabIndex={-1}>`, the target of the skip
link. It does not render `<main>`, because the existing lab page renders its own and a nested
`<main>` is invalid. Every page must render exactly one `<main>`.

### 5. Docs numbers and lists are derived, not retyped

The static checks on /docs are rendered from `STATIC_CHECK_RULES`; statuses and verdict rules from
`src/lib/site/status.ts`, typed as `Record<CellStatus, ...>` and `Record<Verdict, ...>` so a new
status fails the type check. The probe timeout, the run ceiling and the explain payload cap are
constants in `src/lib/site/docs.ts`; `site.test.ts` reads `rules.yaml` and fails when they drift.
`SITE_DESCRIPTION` is compared with `package.json`.

## Known gaps

- **The Supabase dates are not re-verified.** /docs shows 2026-05-30 and 2026-10-30 from ADR 0002,
  which itself says they were read through a summarising fetch tool and "should be re-read at the
  source before they are shown to users". That re-read did not happen in this task. The page links
  to Supabase's guide and tells the reader to re-check the dates.
- **`error.tsx` has no automated test.** No production route throws, so there is nothing to point
  Playwright at. It was checked once by hand with a temporary throwing page under `next dev`:
  status 500, the heading and the "Try again" button hydrated, no CSP violation, no page error.
  That run used the development policy, which allows `'unsafe-eval'`; the strict production policy
  was not exercised for this page.
- **`REPO_URL` was a placeholder** until the orchestrator set it to the owner's repository `https://github.com/MStanislavov/rls-leak-tester` (originally `https://github.com/OWNER/postgres-rls-leak-tester`). The GitHub
  link in the header and the LICENSE link in the footer do not resolve until the owner sets it.

## Trap for later agents

Creating a route, running `next dev`, then deleting the route leaves entries for it in
`.next/dev/types/validator.ts` and `.next/dev/types/routes.d.ts`. `tsconfig.json` includes
`.next/dev/types/**`, and `next typegen` only rewrites `.next/types`, so `npm run typecheck` fails
with `Cannot find module '../../../src/app/<route>/page.js'` for everybody in the checkout. This
happened in this task (the temporary page of the `error.tsx` check). A short `next dev` start
regenerates both files. Make sure no other dev server is running before touching `.next/dev`.
