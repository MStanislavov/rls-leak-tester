import { SeverityBadge } from "@/components/site/severity-badge";
import { DOCS, STATIC_CHECK_RULES } from "@/lib/checks";
import {
  EXPLAIN_PAYLOAD_MAX_KIB,
  PROBE_TIMEOUT_SECONDS,
  RUN_CEILING_SECONDS,
  SUPABASE_EXPLICIT_GRANTS_DATES,
  staticCheckAnchor,
} from "@/lib/site/docs";
import { Code, DocLink, DocSection, H3, Note, P, Ul } from "./prose";

/** Rendered from the rule catalogue of `src/lib/checks`, so this list cannot drift from the code. */
export function StaticChecksSection() {
  return (
    <DocSection id="static-checks">
      <P>
        The checks below read the catalog snapshot of the run and are shown next to the matrix. They
        are deterministic and involve no AI. A finding is a fact about the catalog, never a verdict:
        the verdict comes from the matrix alone. Each finding names the object it concerns and links
        to the page of the official documentation its semantics were confirmed against.
      </P>
      <ul className="flex flex-col gap-3">
        {STATIC_CHECK_RULES.map((rule) => (
          <li
            key={rule.id}
            id={staticCheckAnchor(rule.id)}
            data-testid="static-check"
            className="flex flex-col gap-2 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold">{rule.id}</span>
              <SeverityBadge severity={rule.severity} />
              {rule.modes === "supabase" ? (
                <span className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
                  Supabase mode only
                </span>
              ) : null}
            </div>
            <h3 className="font-semibold">{rule.title}</h3>
            <p className="text-sm leading-relaxed text-foreground/90">{rule.summary}</p>
            <p className="text-sm">
              <DocLink href={rule.docsUrl}>
                Documentation<span className="sr-only"> for {rule.id}</span>
              </DocLink>
            </p>
          </li>
        ))}
      </ul>
    </DocSection>
  );
}

export function SupabaseModeSection() {
  return (
    <DocSection id="supabase-mode">
      <P>
        There is no Supabase platform in your browser, so Supabase mode applies a shim before your
        schema: the part of a Supabase database that row level security policies depend on.
      </P>
      <H3>The shim</H3>
      <Ul>
        <li>
          Roles <Code>anon</Code> and <Code>authenticated</Code> (<Code>NOLOGIN</Code>, no{" "}
          <Code>BYPASSRLS</Code>) and <Code>service_role</Code> (<Code>BYPASSRLS</Code>).
        </li>
        <li>
          Schema <Code>auth</Code> with <Code>auth.uid()</Code>, <Code>auth.role()</Code>,{" "}
          <Code>auth.jwt()</Code> and <Code>auth.email()</Code>. The function bodies are
          Supabase&apos;s own and read the <Code>request.jwt.claims</Code> setting, which the runner
          sets from the persona&apos;s claims. The <Code>role</Code> claim is added when a persona
          leaves it out, because a Supabase JWT always carries it.
        </li>
        <li>
          A table <Code>auth.users</Code> with the original columns, so that{" "}
          <Code>references auth.users (id)</Code> loads. The API roles get no privilege on it.
        </li>
        <li>
          Not included: PostgREST, Storage, Realtime, GoTrue, the platform&apos;s other roles and
          its extensions.
        </li>
      </Ul>
      <H3>Default grants: legacy or explicit</H3>
      <P>
        Whether a table is reachable at all depends on grants, and Supabase is changing its
        defaults. A scenario therefore states which regime it stands for.
      </P>
      <Ul>
        <li>
          <strong>Legacy</strong> (the default of a scenario): blanket privileges on all present and
          future tables, sequences and functions of the exposed schemas for <Code>anon</Code>,{" "}
          <Code>authenticated</Code> and <Code>service_role</Code>. Row level security is the only
          barrier. This is what makes a table with row level security disabled readable by{" "}
          <Code>anon</Code>, the classic real-world leak.
        </li>
        <li>
          <strong>Explicit</strong>: new tables in <Code>public</Code> get no <Code>select</Code>,{" "}
          <Code>insert</Code>, <Code>update</Code> or <Code>delete</Code> for the API roles until
          your SQL grants them. Supabase applies this to new projects since{" "}
          <Code>{SUPABASE_EXPLICIT_GRANTS_DATES.newProjects}</Code> and to every existing project
          from <Code>{SUPABASE_EXPLICIT_GRANTS_DATES.allProjects}</Code>; objects that already exist
          keep their grants.
        </li>
      </Ul>
      <P>
        The same schema can therefore leak under one regime and not under the other. Under explicit
        grants a table without a grant answers <Code>42501 permission denied for table</Code>, which
        the runner reads as blocked; the message in the cell tells a missing grant from a policy.
        The default grants are applied before your schema, as default privileges are on the
        platform, so a <Code>REVOKE</Code> in your schema stays in effect. Pick the regime of the
        project you are testing, and re-check the dates in{" "}
        <DocLink href={DOCS.supabaseApi}>Supabase&apos;s guide to securing the API</DocLink>.
      </P>
      <P>
        In postgres mode no shim and no grant is applied. Your schema SQL creates its roles and
        grants, and personas use those role names.
      </P>
    </DocSection>
  );
}

export function ThreatModelSection() {
  return (
    <DocSection id="threat-model">
      <Note title="Where your SQL runs">
        Your schema, seed and probe SQL execute only in your own browser tab, in a Postgres compiled
        to WebAssembly. The server never executes user SQL.
      </Note>
      <H3>What leaves your browser</H3>
      <P>Nothing is sent while you edit or run. Data leaves the tab only when you ask for it:</P>
      <Ul>
        <li>
          <strong>Explain</strong>, offered on failing cells only, sends the minimum for that cell:
          the table&apos;s DDL, the policies on that table, the persona&apos;s role and claims, the
          operation, the expected and the actual keys, and the related static findings. Never the
          full seed data. The payload is capped at {EXPLAIN_PAYLOAD_MAX_KIB} KiB and validated on
          the server. It is forwarded to the language model; server logs record hashes and sizes,
          never SQL or claims.
        </li>
        <li>
          <strong>Share</strong>, available only when the deployment has sign-in configured, stores
          the scenario, which contains your schema and seed SQL, so that others can open it. Without
          it, scenarios are saved in this browser&apos;s local storage only.
        </li>
      </Ul>
      <P>
        Use invented seed data and invented claims. A persona&apos;s claims are plain JSON; never
        paste a real token or a production row.
      </P>
      <H3>Opening someone else&apos;s scenario</H3>
      <P>
        A shared scenario runs its author&apos;s SQL in your browser. It runs inside sandboxed
        WebAssembly in a Web Worker, with no network access and no access to your files or to the
        page. What it can do is burn CPU. Every probe therefore has a timeout of{" "}
        {PROBE_TIMEOUT_SECONDS} seconds and a whole run a ceiling of {RUN_CEILING_SECONDS} seconds;
        on a timeout the worker is terminated, a new one is started and the probe is marked
        inconclusive. The page stays responsive throughout.
      </P>
      <H3>What the application itself does</H3>
      <Ul>
        <li>
          Scenario text, query results and error messages are rendered as text, never as HTML.
        </li>
        <li>
          Every response carries a Content-Security-Policy with a per-request nonce, plus{" "}
          <Code>X-Content-Type-Options</Code>, <Code>Referrer-Policy</Code>,{" "}
          <Code>Permissions-Policy</Code> and frame protection. The policy allows WebAssembly and
          same-origin workers and nothing broader. No third-party script, font or tracker is loaded.
        </li>
        <li>
          The explain endpoint is rate limited and caches identical questions. SQL inside the prompt
          is treated as untrusted data: text inside it is never an instruction.
        </li>
        <li>
          The model never decides a verdict. A fix it proposes is applied to a copy of the scenario
          and the matrix is re-run; it is labelled verified only if the failing cells pass and
          nothing else regressed.
        </li>
      </Ul>
    </DocSection>
  );
}

export function LimitsSection() {
  return (
    <DocSection id="limits">
      <Ul>
        <li>
          <strong>No primary key, no tracking.</strong> Rows are identified by primary key. A table
          without one is skipped with that reason; there is no fallback to <Code>ctid</Code>.
        </li>
        <li>
          <strong>PGlite is PostgreSQL 18 without extensions unless loaded.</strong> The lab loads
          none. A schema that needs <Code>create extension</Code> (uuid-ossp, pgcrypto, PostGIS,
          pgvector and so on) fails at that statement and has to be reduced to the tables and
          policies under test. <Code>gen_random_uuid()</Code> is built in.
        </li>
        <li>
          <strong>
            <Code>statement_timeout</Code> is not enforced.
          </strong>{" "}
          PGlite runs a query to the end on its single thread and has no cancel. The only timeout is
          terminating the worker. The replacement worker is an empty database: schema and seed are
          replayed, which costs another cold start.
        </li>
        <li>
          <strong>English messages.</strong> Telling a blocked probe from one that could not run
          reads the text of a few <Code>42501</Code> messages, in English. PGlite has no other
          message locale, so this holds inside the lab.
        </li>
        <li>
          <strong>It tests what you describe.</strong> The verdict covers the personas, seeded rows
          and expectations of the scenario. Seed at least two users and two tenants, or there is
          nothing to leak to.
        </li>
        <li>
          <strong>Static checks read the catalog, not intent.</strong> A helper function that reads{" "}
          <Code>user_metadata</Code> in its body is not seen by RLS005, and a tautology such as{" "}
          <Code>(1 = 1)</Code> is not evaluated by RLS003. The matrix finds what they cannot.
        </li>
        <li>
          <strong>Determinism depends on the seed.</strong> A seed that uses{" "}
          <Code>gen_random_uuid()</Code> or <Code>now()</Code> for keys or for owner and tenant
          columns gives different keys in every run.
        </li>
        <li>
          <strong>Sequences.</strong> A key that is <Code>GENERATED ALWAYS AS IDENTITY</Code>, or a
          key of another type with a sequence default, advances its sequence during a run although
          the rows are rolled back.
        </li>
        <li>
          <strong>Download size.</strong> The first visit to the lab downloads about 17 MB of
          WebAssembly and data before compression. The start page and this page load none of it.
        </li>
        <li>
          <strong>Not the platform.</strong> Supabase mode models roles, grants and the{" "}
          <Code>auth</Code> functions. It does not model PostgREST, Storage policies or Realtime.
        </li>
      </Ul>
    </DocSection>
  );
}
