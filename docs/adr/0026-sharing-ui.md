# Sharing UI, sign-in controls and the shared-scenario page

Status: draft (Phase 7, client side; builds on `0020-store-and-sharing.md`)

## Context

Brief 3.3 (`/s/[slug]`), 3.10, 4.7 (running someone else's SQL) and 4.8 (graceful degradation).
The store, the API routes, the auth client and `loadSharedScenario` already existed. This slice
adds what a person sees: the Share button and dialog in the lab, sign-in and sign-out in the site
header, and the read-only page of a shared scenario with "Fork to my lab".

## Decisions

### Whether sharing is available comes from `/api/health`

`useSharingAvailability()` (`src/components/lab/share/use-sharing-availability.ts`) asks
`GET /api/health` once per page load and parses the one boolean it needs with zod
(`parseSharingEnabled` in `src/lib/lab/share.ts`). Until the answer is there, and whenever it
cannot be read, sharing is off. The build-time `NEXT_PUBLIC_*` values decide only whether the
header ships the sign-in controls and whether the browser auth client exists. Reason: the server is
the authority on its own configuration, and a run-time answer can be intercepted in Playwright, so
a configured deployment is testable without environment variables.

### Share without Supabase: `aria-disabled`, not `disabled`

The button stays visible, is styled and announced as unavailable (`aria-disabled="true"`, an
`aria-describedby` hint), shows the explanation in a tooltip on hover AND on keyboard focus, and
still opens a dialog with the same text: "Sharing needs a Supabase project: see docs/DEPLOY.md;
local save works." A natively disabled button cannot take focus, so a keyboard or screen-reader
user would never reach the explanation the brief asks for. No request goes to `/api/scenarios`.

### Share with Supabase

- The dialog's code (`share-dialog.tsx`, the remote store, the auth client) is a chunk of its own,
  loaded on first open.
- Who is signed in is decided by the server: `loadShareSession` asks `GET /api/scenarios`; `401`
  is "signed out". When the browser auth client exists and knows no user, the API is not asked at
  all (no `401` noise in the console of a signed-out visitor).
- A new share defaults to `unlisted` (reachable by link, not listed). The server still defaults to
  `private` when no visibility is sent.
- The first remote save omits the id (`POST`); further saves of the same working scenario in the
  same lab session send `PATCH` with the row id. The link between the working scenario and its row
  lives in component state only and is keyed by `scenario.id`: after a reload a new share creates a
  new row, and the old one is in "My shared scenarios" to delete. Persisting that link would need a
  schema change of the local store and was left out.
- "My shared scenarios": visibility change is `get(id)` then `save({ id, scenario, visibility })`
  because the `ScenarioStore` port replaces whole entries (`changeVisibility`); delete needs a
  second click ("Delete for everybody").
- Sign-in from the dialog leaves the page for GitHub. `signInReturnPath` reopens what was on
  screen: an unchanged template or saved entry by its own address, anything else through a copy in
  the local store (`/lab?saved=<id>`).
- Errors shown to the user are one sentence per `StoreErrorCode` (`shareErrorMessage`); the
  server's text is only used for the local store's own messages.

### Header

`SiteHeader` renders `AuthControls` only when `getPublicConfig().supabaseEnabled`; without Supabase
the header is what it was and ships no auth code. `AuthControls` loads `@/lib/lab/zod-csp` and
then `@/lib/store/auth-client` with `import()` after hydration, so the landing page stays light
and zod is jitless before the client's schemas are built (strict CSP). It shows the display name
as text (no avatar: `img-src`), signs in with the current path as `next`, signs out through the
browser client and calls `router.refresh()`. A failed callback (`?auth_error=<code>`) is parsed
with the callback's own zod enum (`authErrorMessage`) and shown as a toast.

### `/s/[slug]`

- Server Component. `params` goes through `parseScenarioSlugParams` (zod, SEC-002); a malformed
  slug is a 404 before anything is looked up. The scenario comes from `loadSharedScenario` (the
  visitor's session, RLS behind it, read-through cache), once per request (`React.cache`) for the
  page and its metadata. A miss and somebody else's private scenario are the same 404.
- **Without Supabase the page is a 200** that says "Sharing is not enabled on this deployment" and
  links to the lab, with `robots: noindex`. Reason: P4 asks for a calm notice for an optional
  capability that is off, and a 404 would tell the visitor the link is wrong when it is the
  deployment that cannot serve it. `unavailable` is a 200 with "Try again"; `corrupt` a 200 with
  its reason.
- **Metadata**: only a `public` scenario lends its title to `<title>`; `unlisted`, `private`, a
  miss and every failure get the same generic title and `noindex, nofollow`. An unlisted link
  pasted into a chat does not unfurl with its title.
- **Read-only lab**: `LabWorkbench` got an optional `shared={{ scenario, notice }}` prop. With it
  the scenario is the initial state (origin `imported`), the title input is `readOnly`, the
  template picker and the Scenario/Save menu are not rendered, mode and grants are disabled,
  the SQL editors get CodeMirror's `EditorState.readOnly` plus `aria-readonly` (still focusable,
  selectable, copyable; Ctrl+Enter runs), the personas panel sits in a disabled `<fieldset>`, and
  the tables panel disables its controls itself and makes its scroll region focusable (axe counts
  everything inside a disabled fieldset as unfocusable, so a fieldset there fails
  `scrollable-region-focusable`). Run, Cancel, the matrix, the drawer and the findings work as in
  the lab, on a worker in the visitor's tab with the same timeouts.
- The toolbar of the shared page has "Fork to my lab" only. Explain and Export CI check are not
  offered there: both belong to a scenario one can edit; fork first.
- The notice under the toolbar is the brief's sentence; the owner sees "You shared this scenario"
  instead of "shared by someone else".
- **Fork** copies the scenario under a new scenario id into the local store (`forkToLab`) and
  navigates to `/lab?saved=<store id>`.
- **Browser fallback load.** The page's browser half loads the scenario through
  `GET /api/scenarios/by-slug/[slug]` in two cases only: "Try again" after `unavailable`, and when
  the server said `not_configured` while `/api/health` says sharing is on. In production the second
  case cannot happen (both read the same configuration); it exists so that Playwright can show the
  read-only lab and the fork on a build without Supabase variables. It grants nothing: the API
  applies the same session and RLS rules, and the answer is parsed with zod and `parseScenario`.

## Tests

- `src/lib/lab/share.test.ts`, `share-page.test.ts`, `share-auth.test.ts`: health parsing, links,
  error sentences, session detection, visibility change, fork, sign-in return path, metadata
  rules, the browser load state machine.
- `tests/share/shared-page.test.ts`: the real page module with mocked configuration, cookies and
  `@supabase/ssr` and the in-memory Supabase fake: 404 for malformed, missing and foreign-private
  slugs, the owner sees a private scenario, the owner id never crosses, metadata never names a
  non-public scenario, an outage is a page.
- `e2e/share.spec.ts`: default deployment against the real server (Share explanation, no sign-in,
  `/s/<slug>` 200 and hydrated under the CSP in both themes, malformed slug 404, axe); simulated
  deployment by intercepting `/api/health` and `/api/scenarios*` (read-only lab, run of the shared
  SQL, fork into localStorage and the lab, Share dialog signed in and signed out, axe).

## Deviations and limits

- Small edits outside this slice's directories: `lab-workbench.tsx` (`shared` prop),
  `scenario-panel.tsx`, `sql-editor.tsx` and `tables-panel.tsx` (`readOnly`), `lab-extensions.tsx`
  (registers `ShareScenario`), `site-header.tsx` (auth slot).
- Not covered by an automated test: the GitHub round trip and the header controls with a real
  session (needs a Supabase project, FA-1). The auth client itself is unit-tested in `tests/store`.
- When the server has the Supabase variables but the client bundle was built without them, the
  Share dialog says that this build has no sign-in instead of offering a dead button.
