import { StatusBadge, VerdictBadge } from "@/components/site/status-badge";
import { BLOCKED_SQLSTATE, CONSTRAINT_SQLSTATES } from "@/lib/site/docs";
import { STATUS_META, VERDICT_META } from "@/lib/site/status";
import { Code, DocSection, H3, Note, Ol, P, Sql, Ul } from "./prose";

const PROBE_TRANSACTION = `begin;
select set_config('role', '<persona role>', true);
select set_config('request.jwt.claims', '<claims json>', true);
select set_config('row_security', 'on', true), set_config('TimeZone', 'UTC', true);
select current_user, current_setting('row_security');  -- must be the persona's role, and on
<the probe>
rollback;`;

export function HowItWorksSection() {
  return (
    <DocSection id="how-it-works">
      <P>
        You describe a scenario: the schema SQL with its policies, seed rows, a few personas and
        what each persona is expected to reach. The lab runs every persona against every table and
        every operation in a real Postgres inside your browser tab, compares the rows that were
        actually reached with the rows you expected, and reports each cell of that matrix.
      </P>
      <H3>The scenario</H3>
      <Ul>
        <li>
          <strong>Mode</strong>: <Code>supabase</Code> or <Code>postgres</Code>. Supabase mode adds
          the roles and <Code>auth</Code> functions of the platform, see{" "}
          <a href="#supabase-mode" className="underline underline-offset-4">
            Supabase mode
          </a>
          .
        </li>
        <li>
          <strong>Personas</strong>: a label, a database role (<Code>anon</Code>,{" "}
          <Code>authenticated</Code>, <Code>service_role</Code>, or your own role in postgres mode),
          the JWT claims as JSON (<Code>sub</Code> is the user id) and the path of the tenant claim,
          for example <Code>app_metadata.tenant_id</Code>.
        </li>
        <li>
          <strong>Table configuration</strong>: which column holds the owner and which the tenant.
          Suggested from column names such as <Code>user_id</Code> or <Code>tenant_id</Code>; you
          can override it.
        </li>
        <li>
          <strong>Expectations</strong>: one per persona, table and operation, with a scope of{" "}
          <Code>none</Code>, <Code>own</Code>, <Code>tenant</Code>, <Code>all</Code> or{" "}
          <Code>custom</Code>. A custom scope is a query, run as superuser, that returns the primary
          keys this persona should reach; it takes <Code>:sub</Code> and <Code>:claims</Code>. It
          exists for access through a membership table, which a column comparison cannot express.
        </li>
      </Ul>
      <P>
        A cell you leave unset gets a default by role name: <Code>anon</Code> expects{" "}
        <Code>none</Code>, <Code>service_role</Code> expects <Code>all</Code>, every other role
        expects <Code>own</Code> when the table has an owner column, else <Code>tenant</Code> when
        it has a tenant column, else <Code>none</Code>.
      </P>
      <H3>A run, step by step</H3>
      <Ol>
        <li>
          A fresh in-memory Postgres starts in a Web Worker. No state survives from an earlier run.
        </li>
        <li>
          In Supabase mode the shim and the default grants are applied. Then your schema SQL and
          your seed SQL run as superuser. A statement that fails is shown with its SQLSTATE and
          message next to the statement.
        </li>
        <li>
          The catalogs are read: tables of the exposed schemas, primary keys, whether row level
          security is enabled and forced, policies with their command, roles, <Code>USING</Code> and{" "}
          <Code>WITH CHECK</Code>, views and functions.
        </li>
        <li>
          The ground truth is taken as superuser: every primary key of every table with its owner
          and tenant value. The expected key set of each cell is computed from it. Whether a row is
          a persona&apos;s own is decided by Postgres (<Code>column = claim</Code> with the
          column&apos;s type), not by comparing text.
        </li>
        <li>Every probe runs, each in its own transaction that is rolled back.</li>
        <li>
          The static checks read the same catalog snapshot, and the verdict is computed from the
          cells.
        </li>
      </Ol>
      <P>
        The result is deterministic: the same scenario produces a byte-identical result, with
        tables, personas, operations and keys in a stable order, no clock and no random values.
      </P>
      <H3>Why the role matters</H3>
      <P>
        Row level security silently does not apply to a superuser, to a role with{" "}
        <Code>BYPASSRLS</Code>, and to the owner of a table unless the table has{" "}
        <Code>FORCE ROW LEVEL SECURITY</Code>. The default user of the in-browser Postgres is a
        superuser, so a probe that forgot to switch roles would pass every leaky scenario. Every
        probe therefore has this shape:
      </P>
      <Sql label="The transaction around every probe">{PROBE_TRANSACTION}</Sql>
      <P>
        If <Code>current_user</Code> is not the persona&apos;s role, nothing is probed and the cell
        is inconclusive. A persona that legitimately bypasses row level security, such as{" "}
        <Code>service_role</Code>, is probed like any other and the cell is marked with the reason
        for the bypass. After a run the database is unchanged.
      </P>
    </DocSection>
  );
}

export function ProbesSection() {
  return (
    <DocSection id="probes">
      <P>
        A probe answers one question: which rows can this persona reach with this operation? Rows
        are identified by primary key. The exact SQL of every probe is recorded in the cell.
      </P>
      <H3>SELECT reach</H3>
      <P>
        Selects the primary keys the persona can see and compares them with the expected set. When a
        column-level grant hides the key column, the probe counts rows instead; if that cannot
        identify the rows the cell is inconclusive.
      </P>
      <H3>UPDATE reach</H3>
      <P>
        A no-op update, <Code>SET col = col</Code> with <Code>RETURNING</Code> of the primary key,
        shows which rows the persona can update. That statement reads a column, so the SELECT
        policies apply to it as well. Two more steps cover what it cannot see: a blind update
        without <Code>WHERE</Code> and without <Code>RETURNING</Code>, after which the superuser
        reads back which rows were rewritten, and a takeover attempt (setting the owner or tenant
        column to the persona&apos;s own value) on a row that <Code>USING</Code> admitted but whose
        no-op was rejected by <Code>WITH CHECK</Code>.
      </P>
      <H3>UPDATE scope escape</H3>
      <P>
        Takes one row inside the persona&apos;s scope that the persona can reach and tries to move
        it outside, by setting the tenant or owner column to a value that belongs to someone else in
        the ground truth. The expected result is always blocked. A success is an{" "}
        <strong>escape</strong>, the most serious finding after a read leak.
      </P>
      <Ul>
        <li>
          Two shapes are tried: a targeted <Code>UPDATE ... WHERE pk = x</Code>, then one without{" "}
          <Code>WHERE</Code> and without <Code>RETURNING</Code>. With <Code>WITH CHECK (true)</Code>{" "}
          the targeted shape can still look blocked, because the SELECT policy is applied to the new
          row; the second shape is not.
        </li>
        <li>
          Scope <Code>own</Code> moves the owner column, and the tenant column too when the persona
          has a tenant claim. Scope <Code>tenant</Code> moves the tenant column. Scope{" "}
          <Code>custom</Code> moves the tenant column if there is one, else the owner column.
        </li>
        <li>
          Scopes <Code>all</Code> and <Code>none</Code> have nothing to escape from: the sub-probe
          is skipped with that reason.
        </li>
      </Ul>
      <H3>DELETE reach</H3>
      <P>
        <Code>DELETE ... RETURNING pk</Code> inside the rolled-back transaction. Because{" "}
        <Code>RETURNING</Code> puts the statement under the SELECT policies too, a plain{" "}
        <Code>DELETE FROM t</Code> runs as a second shape. Rows that only the second shape reached
        are read back as superuser and count as reached.
      </P>
      <H3>INSERT classes</H3>
      <P>
        For every scope class present in the ground truth, a representative seeded row is cloned
        under a fresh primary key and inserted as the persona, without <Code>RETURNING</Code>. The
        classes are <Code>own</Code>, <Code>same-tenant</Code> (same tenant, another owner) and{" "}
        <Code>other</Code> (another tenant); with a custom scope they are <Code>in-scope</Code> and{" "}
        <Code>out-of-scope</Code>. An insert is expected to be allowed exactly when the cloned row
        lies inside the persona&apos;s expected insert scope. Out of scope and allowed is an escape;
        in scope and blocked is an overblock.
      </P>
      <P>
        Fresh keys are deterministic: a fixed literal for a <Code>uuid</Code> key, a value far above
        the current maximum for an integer key, the column default for another type that has one.
        Otherwise the class is skipped with the reason. The values of the cloned row are read from a
        temporary copy inside the transaction, never written into the statement.
      </P>
    </DocSection>
  );
}

export function OutcomesSection() {
  return (
    <DocSection id="outcomes">
      <P>
        For every cell the runner computes <Code>leaked = actual - expected</Code> and{" "}
        <Code>missing = expected - actual</Code>, as sets of primary keys. The status follows from
        those two sets and from the errors the probe met. Every status has its own icon and its own
        word; colour is never the only signal.
      </P>
      <div role="region" aria-label="Cell statuses" tabIndex={0} className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                What was observed
              </th>
              <th scope="col" className="py-2 font-medium">
                Verdict
              </th>
            </tr>
          </thead>
          <tbody>
            {STATUS_META.map((meta) => (
              <tr key={meta.status} data-testid="status-row" className="border-b align-top">
                <td className="py-3 pr-4">
                  <StatusBadge status={meta.status} size="sm" />
                </td>
                <td className="py-3 pr-4 leading-relaxed">{meta.meaning}</td>
                <td className="py-3 whitespace-nowrap text-muted-foreground">
                  {meta.verdictEffect === "fails" ? "makes it LEAKING" : null}
                  {meta.verdictEffect === "proves" ? "counts as measured" : null}
                  {meta.verdictEffect === "none" ? "no effect" : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <H3>Blocked or inconclusive: the SQLSTATE decides</H3>
      <Ul>
        <li>
          <Code>{BLOCKED_SQLSTATE}</Code> (insufficient privilege) means <strong>blocked</strong>.
          It covers a missing grant as well as{" "}
          <Code>new row violates row-level security policy</Code>. The message tells the two apart
          and is shown with the cell.
        </li>
        <li>
          One carve-out: a <Code>{BLOCKED_SQLSTATE}</Code> that is not about the probed rows (
          <Code>permission denied for schema</Code>, <Code>type</Code>, <Code>sequence</Code> and
          the like, or <Code>query would be affected by row-level security policy</Code>) means the
          probe itself could not run. That is inconclusive, not blocked.
        </li>
        <li>
          Constraint errors (
          {CONSTRAINT_SQLSTATES.map((state, index) => (
            <span key={state}>
              {index > 0 ? ", " : null}
              <Code>{state}</Code>
            </span>
          ))}
          ) and every other error, a timeout included, are <strong>inconclusive</strong>. The error
          is shown and never counted as a pass or as a leak.
        </li>
      </Ul>
      <P>
        When several things are true of one cell the most serious wins: leak, then escape, then
        inconclusive, then overblock, then pass. A proven leak stays a leak even if another row of
        the same cell was inconclusive. A reach cell of a table without seeded rows is skipped, not
        passed: nothing was measured.
      </P>
      <P>
        Each cell records its status, the expected keys, the actual keys, the leaked and the missing
        keys, the exact probe SQL, the SQLSTATE and message if there was one, and the policies that
        applied to that table and command.
      </P>
    </DocSection>
  );
}

export function VerdictSection() {
  return (
    <DocSection id="verdict">
      <P>
        The verdict is computed from the cells by a fixed rule. No model and no heuristic takes part
        in it.
      </P>
      <dl className="flex flex-col gap-3">
        {VERDICT_META.map((meta) => (
          <div
            key={meta.verdict}
            data-testid="verdict-row"
            className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:gap-4"
          >
            <dt className="sm:w-40 sm:shrink-0">
              <VerdictBadge verdict={meta.verdict} />
            </dt>
            <dd className="text-sm leading-relaxed">{meta.rule}</dd>
          </div>
        ))}
      </dl>
      <P>
        Overblocked, inconclusive and skipped cells are counted and shown beside the verdict. They
        do not change it, with the one exception above: when nothing at all was measured the verdict
        is NOT PROVEN.
      </P>
      <Note title="What ISOLATED does and does not say">
        ISOLATED is a statement about the personas, the seeded rows and the expectations of this
        scenario. A role you did not add as a persona, or a kind of row you did not seed, was not
        tested.
      </Note>
    </DocSection>
  );
}
