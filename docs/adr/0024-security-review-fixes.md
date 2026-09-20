# Security review fixes: the rate-limit bucket and the fix allow-list

Status: draft (review of area "security+store"; changes ADR 0017, ADR 0018 and the draft
"Explain in the lab and the verified-fix loop")

## 1. The address a caller is limited by

### Context

`/api/explain` and the scenario writes limit per address (rules.yaml `thresholds.rate_limits`).
An anonymous caller has the address bucket only. Both handlers read the FIRST hop of
`X-Forwarded-For`, in two copies of the same helper. That hop is text the caller sends: every
proxy that appends (nginx `$proxy_add_x_forwarded_for`, an ALB, Cloudflare) forwards
`<what the caller sent>, <the caller's address>`, and `next start` keeps a header that is
already there (`node_modules/next/dist/server/base-server.js`:
`req.headers['x-forwarded-for'] ??= socket.remoteAddress`). Measured before the fix: 12 of 12
explanations with a rotating first hop were answered by the model, limit 5 per minute; 30 of 30
anonymous scenario writes reached `auth.getUser()`.

### Decision

One helper, `src/lib/security/client-address.ts` `clientAddress(headers)`; the copies in
`src/lib/ai/explain.ts` and `src/lib/store/server/http.ts` (`parseClientAddress`) are gone.

- The bucket is the LAST hop of `X-Forwarded-For`: the one the proxy in front of the app wrote.
  The first hop is never read. When the last hop is no address the caller lands in the shared
  bucket `unknown`; there is no fallback to an earlier hop.
- `X-Real-IP` is read only when there is no `X-Forwarded-For` at all. `X-Vercel-Forwarded-For` is
  not read: outside Vercel it is text from the caller, on Vercel `X-Forwarded-For` holds the same
  address (Vercel overwrites the header and forwards no outside hops).
- A port is dropped (`203.0.113.7:51234`, `[2001:db8::1]:51234`; some gateways append it and the
  caller chooses it), the address is lower-cased.

### The trust assumption (must be repeated in docs/DEPLOY.md and SECURITY.md, Phase 9)

Exactly ONE trusted proxy stands in front of the app, and it sets or appends `X-Forwarded-For`:
Vercel, or a reverse proxy / load balancer of the owner's.

- More proxies in front (a CDN before Vercel or nginx): the last hop is the inner proxy's peer, so
  the users behind one CDN edge share a bucket. Strict, never a bypass. A configurable hop count
  (`TRUSTED_PROXY_HOPS` in `src/lib/config`) would lift that; it was not added because no
  supported deployment needs it.
- No proxy (`next start` open to the internet): the header is the caller's and the per-address
  limit can be dodged. Not a supported deployment; a route handler has no socket to ask.
- Not covered: one IPv6 caller usually owns a whole /64 and can rotate inside it, so where the
  proxy accepts IPv6 the limit per address is weaker than for IPv4 (no /64 grouping was added).

## 2. "Verified fix" needs the statement allow-list

### Context

The re-run compares cells, and the proposal is appended to the schema, which runs BEFORE the
seed. A proposal that leaves the leaky policy alone and adds a trigger (`new.is_public := true`)
rewrites the seed until "everyone reads everything" is the expected result: measured on the
todos template, `verifyProposedFix` answered `verified`, verdict `ISOLATED`, with
`using (true)` still in the schema. The text the model reads is untrusted (a shared scenario can
carry instructions in a comment, the explanation cache keeps a successful injection for 7 days),
and `unexpectedStatements` was a hint in the UI only.

### Decision

- `applyProposedFix` refuses (`reason: "unexpected"`) every proposal `unexpectedStatements` names
  a statement of, so `verifyProposedFix` answers `incomplete / not-applied` WITHOUT a run: such a
  proposal is never re-run, never "Verified fix", never applied (Apply needs a verified outcome).
- The allow-list is what `src/lib/ai/prompt.ts` asks for: `CREATE | DROP | ALTER POLICY`, `GRANT`,
  `REVOKE`, and `ALTER TABLE [IF EXISTS] [ONLY] name [*] ENABLE | FORCE ROW LEVEL SECURITY
[, ...]` matched as a whole statement. Every other `ALTER TABLE` (DISABLE ROW LEVEL SECURITY,
  DISABLE TRIGGER, a column default, DROP COLUMN, RENAME, OWNER TO) is refused. A comment inside
  an ALTER TABLE statement makes it refused too: fail closed.
- Why a head check is enough for the other kinds: Postgres parses a whole text before it runs any
  of it, and its grammar has no `;` inside parentheses except in `CREATE RULE`, which the head
  check refuses; strings, comments and dollar quotes are lexed by `splitSqlStatements` the way
  Postgres does. A text that hides a second statement is a syntax error, and a setup error is
  `did-not-pass`.
- UI (`src/components/lab/explain/explain-cell.tsx`): the hint under the SQL now says the proposal
  is never re-run, verified or applied, and the "Re-run the matrix with this SQL" button is not
  offered after `not-applied` (the refusal is deterministic).
- The schema description of `proposedPolicySql` and the system prompt name the same list and say
  that anything else is refused untested; `PROMPT_VERSION` is `2`.

### Not done

The server still caches an answer whose SQL the client will refuse (the client-side gate makes it
harmless: "not tested" instead of a false "verified"). Refusing to cache it would need
`unexpectedStatements` in a module `src/lib/ai` may import (`src/lib/scenario`), a move across
ownership that was left for a later slice.
