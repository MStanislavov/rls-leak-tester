# Deploying RLS Leak Tester

**Prepared by the build, performed by the owner. Nothing in this document was executed.** The
build never deployed anything, never touched an account, a DNS zone or a real Supabase, Vercel,
Redis, Anthropic or SonarQube Cloud project, and never pushed. Every step below is a manual step
for you, in this order. Provider facts (Vercel DNS, Node versions, request headers, Supabase
redirect URLs, the GitHub provider, Upstash URLs) were read from the providers' documentation on
2026-09-20; dashboards move, so where a menu path differs, trust the dashboard.

What you end up with: the app on Vercel under your domain, optionally with Explain (Anthropic plus
Redis) and with sharing and GitHub sign-in (Supabase). The lab itself needs none of that: a
deployment with zero environment variables is already a complete, working lab.

Placeholders used below: `<your-domain>` (for example `rls.example.com`), `<project-ref>` (the
Supabase project reference), `<team-slug>` (your Vercel team or account slug).

## 1. Push the repository

The remote already exists: `origin` points at the GitHub repository over https, and `main` tracks
`origin/main`. Do not run `git remote add origin ...`; git refuses it because `origin` is taken.
From the repository root:

```sh
git status                      # clean, on main
git remote -v                   # origin  https://github.com/MStanislavov/rls-leak-tester.git
git push -u origin main
```

- What is on GitHub today: one commit, `eed8508` "chore: add .gitignore". It was pushed on
  2026-09-19 at 18:46:11 +0200, two seconds after that commit was made and 74 minutes before the
  first build commit (`2ca1f49`, 20:00:02), so it predates the build. The build pushed nothing:
  `origin/main` is still `eed8508` and every later commit is local only. Check with
  `git log --oneline origin/main..main`, which lists exactly what the push will send. The push is
  a fast-forward; no force is needed.
- Optional, for SSH instead of https:
  `git remote set-url origin git@github.com:MStanislavov/rls-leak-tester.git`.
- Agents never push and never add or change a remote (FA-2); this step is yours.
- The GitHub repository is `MStanislavov/rls-leak-tester` (the app links to it in its header). The
  package, the folder and the SonarQube project key are `postgres-rls-leak-tester`; that difference
  is intended.
- `SYSTEM_PROMPT.md`, `.env`, `.env.*` (so also `.env.local` and `.env.sonar`) are git-ignored.
  Check with `git ls-files | grep -E '^\.env|SYSTEM_PROMPT'`: the only hit may be `.env.example`.
- On GitHub: add the topics from the README, and enable **Settings > Advanced Security > Private
  vulnerability reporting** (public repositories only); `SECURITY.md` points reporters there.
- The CI workflow runs for the first time on this push (the earlier push carried only
  `.gitignore`, no workflow file). It is green without any secret: the Sonar job skips
  itself when `SONAR_TOKEN` is absent.

## 2. Create the Vercel project

1. Vercel dashboard > **Add New... > Project** > import `MStanislavov/rls-leak-tester`.
2. **Framework Preset**: Next.js (detected). **Root Directory**: `./`.
3. **Build and Output Settings**: leave every override off. That means Build Command
   `next build`, Output Directory the Next.js default, Install Command `npm install` (Vercel picks
   npm because of `package-lock.json`). Optional: override the Install Command with `npm ci` for an
   install that fails when the lockfile and `package.json` disagree. There is no `vercel.json` and
   none is needed.
4. **Node.js Version** (Settings > Build and Deployment > Node.js Version): **24.x**, the default
   for new projects. `package.json` declares `engines.node >=22.22.2`, which Vercel resolves to the
   latest 24.x and which overrides the project setting anyway. 22.x also works; 20.x does not
   satisfy the engines range.
5. Do not add environment variables yet if you only want the lab: press **Deploy**. Otherwise go
   through step 3 first.

Facts that matter on Vercel:

- The `prepare` script (`scripts/hooks/install-git-hooks.mjs`) exits 0 in every case, with or
  without a `.git` directory, so it cannot break the install.
- Every route is rendered on demand (the Content-Security-Policy nonce needs a request), so there
  is no static HTML to cache and every page costs a function invocation.
- `/api/explain` declares `maxDuration = 120` seconds. With fluid compute (the default) the Hobby
  plan allows up to 300 seconds, so no plan change is needed for it.
- Preview deployments run with `NODE_ENV=production`. The app tells them apart through Vercel's
  system variable `VERCEL_ENV`, which also namespaces the Redis keys (`rlsleak:production:...`
  versus `rlsleak:preview:...`). Keep **Automatically expose System Environment Variables**
  enabled (the default); `VERCEL_GIT_COMMIT_SHA` becomes the `buildId` of `/api/health`.

## 3. Environment variables

Settings > Environment Variables. All are optional. An empty value counts as unset. A malformed
value (for example a `REDIS_URL` that is not `redis://` or `rediss://`) stops the server at startup
with an error that names the variable, never its value. Variables only apply to **new**
deployments: after every change, redeploy (Deployments > ... > Redeploy). `NEXT_PUBLIC_*` values
are inlined into the browser bundle at build time, so they need that rebuild in any case.

| Variable                                          | Production               | Preview                                 | Secret                        | Where the value comes from                                                                                                                                                 |
| ------------------------------------------------- | ------------------------ | --------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_NAME`                            | leave unset              | leave unset                             | no                            | Defaults to `RLS Leak Tester`. Set it only to rename the product in the UI.                                                                                                |
| `NEXT_PUBLIC_SITE_URL`                            | `https://<your-domain>`  | **leave unset**                         | no                            | Your canonical origin (step 5). Used for metadata, share links and the OAuth return address. In Preview it must stay unset so sign-in returns to the preview's own origin. |
| `ANTHROPIC_API_KEY`                               | set for Explain          | optional (every preview can then spend) | **yes**, mark as Sensitive    | Anthropic Console > API keys. Create a key for this app only and set a spend limit on its workspace.                                                                       |
| `ANTHROPIC_MODEL`                                 | optional                 | optional                                | no                            | Overrides the default model (`claude-opus-5`, defined in `src/lib/ai/model.ts`). Cheaper choices: `claude-sonnet-5`, `claude-haiku-4-5`.                                   |
| `REDIS_URL`                                       | **required for Explain** | required for Explain in previews        | **yes** (contains a password) | The `rediss://` URL from step 7. One database can serve Production and Preview, the keys are namespaced per environment.                                                   |
| `NEXT_PUBLIC_SUPABASE_URL`                        | set for sharing          | same value, if previews should share    | no                            | Supabase > Project Settings > API: the project URL `https://<project-ref>.supabase.co` (step 6).                                                                           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                   | set for sharing          | same value                              | no, it is public by design    | Supabase > Project Settings > API Keys: the publishable key (or the legacy `anon` key). It ships to every browser; row-level security protects the data.                   |
| `SUPABASE_SERVICE_ROLE_KEY`                       | **do not set**           | **do not set**                          | yes                           | The application has no service-role client and the migration grants `service_role` nothing. Keeping the key out of Vercel means it cannot leak from there.                 |
| `RUN_LIVE_AI_TESTS`                               | never                    | never                                   | no                            | Test suite only.                                                                                                                                                           |
| `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, `NODE_ENV` | set by the platform      | set by the platform                     | no                            | Never set these by hand.                                                                                                                                                   |

**The production rule.** Wherever `NODE_ENV=production` (Vercel production, Vercel preview,
`next start`), `/api/explain` stays **disabled** unless `REDIS_URL` is set, even with a valid
`ANTHROPIC_API_KEY`: it answers `503` with code `not_configured` and the lab shows a notice in place
of the explanation. An unmetered model endpoint is a cost risk, and without Redis the
rate limit would be per function instance. If Redis is configured but unreachable, the endpoint
answers `503` with code `unavailable` and `Retry-After: 30`, and no model call is made. The lab is
unaffected in both cases.

Vercel's **Development** environment is not used; local development reads `.env.local` (copy
`.env.example`).

## 4. Confirm the Node.js runtime on the Redis, AI and Supabase routes

`ioredis` needs TCP sockets, so these routes must never run on the Edge runtime. Each declares
`export const runtime = "nodejs"`, and `npm run rules` (rule REDIS-002) fails if one of them loses
it:

```
src/app/api/explain/route.ts
src/app/api/health/route.ts
src/app/api/scenarios/route.ts
src/app/api/scenarios/[id]/route.ts
src/app/api/scenarios/by-slug/[slug]/route.ts
src/app/auth/callback/route.ts
src/app/auth/signout/route.ts
```

How to check it in the build output. The route table that `next build` prints (locally and in the
Vercel build log) marks all of these `ƒ (Dynamic)` and lists `ƒ Proxy (Middleware)`; Next.js 16 does
not print the runtime there, so read the manifests the build writes:

```sh
npm run build
grep -rn 'export const runtime' src/app                       # seven lines, all "nodejs"
node -e 'const m=require("./.next/server/middleware-manifest.json");console.log(Object.keys(m.functions))'
# must print [] : no route was compiled for the Edge runtime
node -e 'console.log(Object.keys(require("./.next/server/functions-config-manifest.json").functions))'
# lists the seven routes above plus /_middleware (the proxy, runtime "nodejs")
```

On Vercel, open the deployment and look at its list of functions: every route above must show a
Node.js runtime and none may show Edge. (Where exactly the dashboard lists this was not verified by
the build.) The functional proof is step 9: `/api/health` answering with `"redis": true` and one
Explain call succeeding means a TCP connection to Redis was made.

## 5. Custom domain, DNS and TLS

1. Project > **Settings > Domains > Add Domain**, enter `<your-domain>`. If you add an apex domain
   (`example.com`), Vercel offers to add `www.example.com` as well; accept, and let one redirect to
   the other. The one you keep is your canonical origin.
2. The domain card now shows the record to create. **Copy the values from the card.** Vercel shows
   project-specific values, and they take precedence over any general-purpose value you find
   elsewhere (`76.76.21.21`, `cname.vercel-dns.com`): verification checks for the exact record your
   project expects.

   | You are adding                               | Record type | Name at your DNS provider | Value                                                                                                          |
   | -------------------------------------------- | ----------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | an apex domain                               | `A`         | `@` (or empty)            | the IPv4 address on the card (`76.76.21.21` for most projects; newer ones show another such as `216.198.79.1`) |
   | a subdomain, also `www`                      | `CNAME`     | the label, e.g. `rls`     | the project's own target on the card, of the form `<hash>.vercel-dns-<nnn>.com`                                |
   | a domain another Vercel account already uses | `TXT`       | as shown on the card      | the verification value on the card; it proves access and does not move the domain                              |

   An apex domain cannot carry a `CNAME`; that is why it gets an `A` record. Alternatively switch
   the whole zone to Vercel's nameservers (the card offers it); copy your existing records, MX
   included, to Vercel first.

3. At your DNS provider, remove records that conflict on the same name (another `A`, an `AAAA`, a
   `CNAME`), then create the record. If the zone has `CAA` records, one of them must allow Let's
   Encrypt (`0 issue "letsencrypt.org"`), or certificate issuance is blocked. If the zone sits
   behind a proxying CDN (Cloudflare's orange cloud), switch the record to DNS only: see step 10.
4. Verify from a terminal:

   ```sh
   dig +short A example.com              # apex: the address from the card
   dig +short CNAME rls.example.com      # subdomain: the target from the card, with a trailing dot
   dig +short CAA example.com            # empty, or a list that includes letsencrypt.org
   dig +short A rls.example.com @1.1.1.1 # the same through a public resolver
   ```

   and in the dashboard: the domain card changes from "Invalid Configuration" to a valid
   configuration once Vercel sees the record. DNS changes can take a while to propagate.

5. TLS: Vercel requests the certificate automatically once the record verifies; there is nothing
   to upload. Check it:

   ```sh
   curl -sSI https://<your-domain>/api/health | head -n 1      # HTTP/2 200
   ```

   The app sends `Strict-Transport-Security: max-age=63072000; includeSubDomains` in production.
   `includeSubDomains` tells browsers to use HTTPS for every subdomain of `<your-domain>`; if the
   app sits on an apex domain whose other subdomains are not all on HTTPS, fix those first.

6. Set `NEXT_PUBLIC_SITE_URL=https://<your-domain>` for **Production** only (no trailing path) and
   redeploy. Later, in step 6, the same origin goes into Supabase's Site URL and into the GitHub
   OAuth app's Homepage URL.

## 6. Supabase (sharing and GitHub sign-in)

Skip this step and Share stays disabled with an explanation; everything else works.

1. **Create the project** at supabase.com (any region; close to your Vercel function region keeps
   latency low). Note the project reference `<project-ref>`. Keep the database password in your
   password manager; the application never needs it.
2. **Apply the migration.** There is one file: `supabase/migrations/20260920000000_scenarios.sql`.
   - SQL editor: paste the whole file into a new query and run it once, as the editor's default
     role `postgres`. That role matters: `get_scenario_by_slug` is `SECURITY DEFINER` and the table
     has `FORCE ROW LEVEL SECURITY`, so the function's owner must have `BYPASSRLS`, which
     `postgres` has on Supabase.
   - Or the Supabase CLI, run by you: `supabase login`, `supabase link --project-ref <project-ref>`,
     `supabase db push`. The repository ships no `supabase/config.toml`; if the CLI asks for one,
     run `supabase init` and keep `supabase/migrations/` as it is.
   - The file is written for Supabase's **explicit-grants regime** (new projects since 2026-05-30,
     every project from 2026-10-30), in which nothing is granted to the API roles implicitly. It
     first revokes everything on the table and the functions from `public`, `anon`,
     `authenticated` and `service_role`, then grants exactly `select` to `anon`, the four privileges
     `select`, `insert`, `update`, `delete` to `authenticated`, and `execute` on
     `get_scenario_by_slug(text)` to both. So it ends in the same place on a legacy project with
     blanket default grants. `service_role` gets nothing on purpose.
   - Verify in the SQL editor:

     ```sql
     select relrowsecurity, relforcerowsecurity
     from pg_class where oid = 'public.scenarios'::regclass;            -- t, t

     select policyname, cmd, roles from pg_policies
     where schemaname = 'public' and tablename = 'scenarios';           -- scenarios_owner_all (ALL, authenticated),
                                                                        -- scenarios_public_read (SELECT, anon + authenticated)
     select grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'scenarios'
       and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
     order by 1, 2;                                                     -- anon SELECT; authenticated DELETE, INSERT,
                                                                        -- SELECT, UPDATE; nothing else
     ```

     The same policies are the app's fourth template: open `/lab`, choose "RLS Leak Tester's
     own scenarios table", fixed variant, and run it to see them proven `ISOLATED`.

3. **Enable the GitHub provider.**
   1. Supabase > Authentication > Sign In / Providers > GitHub: copy the **Callback URL**. Its
      exact pattern is `https://<project-ref>.supabase.co/auth/v1/callback`.
   2. GitHub > Settings > Developer settings > OAuth Apps > **New OAuth App**. Application name
      `RLS Leak Tester`; Homepage URL `https://<your-domain>`; **Authorization callback URL**: the
      Supabase callback URL from the line above, exactly (it is Supabase's URL, not the app's);
      leave Device Flow off. Register, then **Generate a new client secret**.
   3. Back in Supabase: switch GitHub on, paste the Client ID and the Client Secret, save. The
      client secret lives only in Supabase: it is not a Vercel variable and never enters the
      repository.
4. **URL configuration** (Supabase > Authentication > URL Configuration). The browser asks Supabase
   to return to `<origin>/auth/callback?next=<path>`, where `<origin>` is `NEXT_PUBLIC_SITE_URL` or,
   when that is unset, the page's own origin. `**` in a pattern matches any characters, so it also
   covers the query string; `*` stops at `.` and `/`.
   - **Site URL**: `https://<your-domain>`
   - **Redirect URLs**, one entry each:
     - `https://<your-domain>/auth/callback**` (production)
     - `https://*-<team-slug>.vercel.app/auth/callback**` (Vercel previews; this is Supabase's
       documented preview pattern, narrowed to the callback path)
     - `http://localhost:3000/auth/callback**` (local development)

   If a sign-in ends on the Site URL's start page instead of where it began, the return address did
   not match the list: compare it with the entries above (scheme, host, path).

5. **Copy the two public values** into Vercel (step 3): the project URL into
   `NEXT_PUBLIC_SUPABASE_URL`, the publishable (or legacy `anon`) key into
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Redeploy. The app then adds `https://<project-ref>.supabase.co`
   to the `connect-src` of its Content-Security-Policy by itself; without the variables the header
   stays `connect-src 'self'`. Do not copy the service role key anywhere.

Not verified by the build: anything against a real Supabase project. The SQL is proven in PGlite on
the project's Supabase shim and against real Postgres 18 in Docker; PostgREST and Auth behaviour
was taken from the installed client libraries and the documentation.

## 7. Redis

Any managed Redis with a standard TLS endpoint works; the app speaks the Redis protocol over TCP
through `ioredis`. Upstash works and has a free tier.

1. Upstash console > Redis > **Create Database**. Pick the region closest to your Vercel function
   region. TLS is always on at Upstash.
2. From the database page take the endpoint, the port and the password (Upstash calls it the
   token) and build the URL, or copy the ready-made `rediss://` URL the page offers for TCP
   clients:

   ```
   rediss://default:<password>@<endpoint>:<port>
   ```

   Upstash's documentation writes the same URL without the user name
   (`rediss://:<password>@<endpoint>:<port>`); both address the default user.

   `rediss://` (two s) switches TLS on inside `ioredis`; no other option is needed. Do **not** use
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: that is Upstash's HTTP API, which this
   app does not use.

3. Put the URL into `REDIS_URL` on Vercel (Sensitive; Production, and Preview if previews should
   offer Explain). Redeploy.
4. Nothing needs to be persisted: every key is a rate-limit counter, a cache entry or a lock under
   `rlsleak:{env}:{purpose}:{id}`, and every key has a TTL. Addresses and user ids are stored only
   as hashes.

**`TIME` inside Lua (ADR 0017).** The sliding-window limiter is one Lua script that reads the clock
with `redis.call('TIME')`, so all app instances share one clock. Redis 7 allows that; whether your
provider does was not verified by the build. Test it before you rely on it:

```sh
redis-cli -u "$REDIS_URL" EVAL "return redis.call('TIME')" 0     # two integers: seconds, microseconds
```

If the provider refuses it, the limiter fails closed: every `/api/explain` call and every scenario
write answers `503`. The fix is a code change, not a setting: in
`src/lib/redis/adapters/redis/rate-limiter.ts` pass the caller's clock (`Date.now()`) as an `ARGV`
value instead of calling `TIME`, keep the contract suite green
(`REDIS_URL=... npx vitest run tests/redis`), and record it in an ADR. The price is clock skew
between instances, which is small against a 60 second window.

## 8. Optional: SonarQube Cloud in CI

The local gate (`npm run quality`) needs none of this. The CI job `sonar` runs only when the
secret `SONAR_TOKEN` exists.

1. <https://sonarcloud.io> > sign in with GitHub > import `MStanislavov/rls-leak-tester` into your
   organization.
2. In the new project: **Administration > Analysis Method**: switch **Automatic Analysis off**. The
   scan comes from CI (it carries the coverage report), and the two methods exclude each other.
3. My Account > Security > generate a token.
4. GitHub repository > Settings > Secrets and variables > Actions:
   - secret `SONAR_TOKEN`: the token
   - secret `SONAR_HOST_URL`: `https://sonarcloud.io` (or the URL of a self-hosted server; when the
     secret is absent the job uses `https://sonarcloud.io`)
   - variable `SONAR_ORGANIZATION`: your organization key (SonarQube Cloud requires it)
   - variable `SONAR_PROJECT_KEY`: the key SonarQube Cloud gave the project (usually
     `MStanislavov_rls-leak-tester`), because `sonar-project.properties` names the local key
     `postgres-rls-leak-tester`
5. The job waits for the quality gate and fails when it fails. The gate **RLS Leak Tester** with
   its conditions on overall and new code exists only on the local server, created by
   `npm run sonar:bootstrap`. On SonarQube Cloud either recreate those conditions in a custom gate
   (whether your plan allows custom gates is for you to check) or accept the built-in gate, which
   looks at new code only and is therefore weaker than the local one. Pull requests from forks and
   from Dependabot get no secrets, so the job skips there.

## 9. Smoke checks after the deployment

```sh
SITE=https://<your-domain>

curl -s "$SITE/api/health"
# {"status":"ok","buildId":"<commit sha>","features":{"explain":true,"redis":true,"supabase":true}}
# Booleans only. "explain" is true only with ANTHROPIC_API_KEY AND REDIS_URL. A false tells you
# which step above is incomplete (after a redeploy).

curl -sI "$SITE/lab" | grep -iE '^(content-security-policy|x-content-type-options|referrer-policy|permissions-policy|x-frame-options|strict-transport-security):'
```

Expected headers, on every path:

- `content-security-policy`: `default-src 'self'`; a `script-src` of exactly `'self'`, a
  `'nonce-<random>'` and `'wasm-unsafe-eval'`, with **no** `'unsafe-eval'` and no `'unsafe-inline'`;
  `worker-src 'self' blob:`; `object-src 'none'`; `frame-ancestors 'none'`;
  `connect-src 'self'` plus your Supabase origin when configured; `upgrade-insecure-requests`. The
  nonce differs on every request (run the command twice).
- `x-content-type-options: nosniff`
- `referrer-policy: strict-origin-when-cross-origin`
- `permissions-policy: accelerometer=(), camera=(), geolocation=(), ...`
- `x-frame-options: DENY`
- `strict-transport-security: max-age=63072000; includeSubDomains`

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SITE/api/explain" -H 'content-type: application/json' -d '{}'
# 400 when Explain is enabled (the body is invalid; no model call, no rate-limit unit spent)
# 503 when Explain is not configured
```

Then in a browser, with the developer console open (it must stay free of CSP violations):

1. **Run a template.** `/lab` > Multi-tenant SaaS > leaky > Run: `LEAKING`, 3 escapes on
   `public.projects`. Switch to fixed > Run: `ISOLATED`. Export CI check downloads the files.
2. **Explain once.** Open one of the Escape cells, read the "What leaves your browser" preview and
   press **Explain this failure**. The answer streams; the fix is re-run and ends as "Verified fix" or as
   "Proposed fix did not pass", never as an untested claim. Press Explain on the same cell again:
   the response carries `X-Explain-Cache: hit` (network tab) and costs no second model call. More
   than 5 Explain requests per minute from one address answer `429` with `Retry-After`.
3. **Share once.** Sign in with GitHub (the round trip must end back on `/lab`). Share the
   scenario as unlisted, open the link in a private window: the read-only page `/s/<slug>` with
   **Fork to my lab**. Then prove that unlisted rows cannot be listed with the public key:

   ```sh
   curl -s "https://<project-ref>.supabase.co/rest/v1/scenarios?select=slug,visibility" -H "apikey: <publishable or anon key>"
   # only rows with visibility "public"; your unlisted scenario must not appear
   ```

4. Sign out, and delete the test scenario if you do not want to keep it.

## 10. The trusted-proxy assumption and rate-limit identity

Rate limits (`/api/explain`: 5 per minute per address, 10 per signed-in user; scenario writes: 20
per address, 30 per user) identify an anonymous caller by address. The app takes the **last** hop
of `X-Forwarded-For`, the one written by the proxy directly in front of it, and never the first
hop, which is text the caller controls (`src/lib/security/client-address.ts`, ADR 0024). That is
correct under one assumption:

**Exactly one trusted proxy stands in front of the app, and it sets or appends
`X-Forwarded-For`.**

- **Vercel** satisfies it. Vercel overwrites `X-Forwarded-For` with the client's public address
  and does not forward outside hops, so the header cannot be spoofed there.
- **Do not put a second proxy or CDN in front of Vercel** (for example Cloudflare in proxying
  mode). The last hop would then be that CDN's edge, and every user behind the same edge would
  share one bucket. That is strict, never a bypass, but it makes `429` answers arrive early. With
  Cloudflare DNS use "DNS only".
- **Self-hosting**: run `next start` bound to loopback or a private network behind exactly one
  reverse proxy or load balancer that sets or appends `X-Forwarded-For` (nginx
  `$proxy_add_x_forwarded_for`, an ALB, Caddy). **`next start` exposed directly to the internet is
  not a supported public deployment**: without a proxy the header is whatever the caller sends, so
  the per-address limit can be dodged, and a route handler has no socket to ask instead.
- Known limit: one IPv6 caller usually controls a whole /64 and can rotate inside it; addresses
  are not grouped by /64, so the per-address limit is weaker for IPv6 than for IPv4. The per-user
  limit and your Anthropic spend limit are the backstops.

## Afterwards

- Rotating a secret: replace the value in Vercel, redeploy, then revoke the old key at the
  provider.
- Turning a capability off again: remove its variables and redeploy. The app degrades to the
  notice for that feature; nothing else changes.
- Dependabot opens weekly pull requests for npm and for the pinned GitHub Actions; CI proves them.
