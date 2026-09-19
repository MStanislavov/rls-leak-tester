/**
 * Spike B proof: a real Postgres with row-level security answers from the
 * worker. One table, one policy, one non-superuser role. The superuser sees
 * every row; the role, inside a transaction with `SET LOCAL ROLE` and a
 * transaction-local setting, sees only the rows the policy lets through.
 *
 * Phase 5 replaces this with the real workbench; the worker client stays.
 */
import type { PgliteWorkerClient } from "@/lib/engine/worker/client";
import type { SqlCell, SqlResultSet } from "@/lib/engine/worker/protocol";

export const SETUP_SQL = `
drop table if exists spike_notes;
drop role if exists spike_app_user;
create role spike_app_user nologin;
create table spike_notes (
  id integer primary key,
  owner text not null,
  body text not null
);
insert into spike_notes (id, owner, body) values
  (1, 'alice', 'alice note one'),
  (2, 'bob', 'bob note'),
  (3, 'alice', 'alice note two');
alter table spike_notes enable row level security;
create policy spike_notes_owner on spike_notes
  for select to spike_app_user
  using (owner = current_setting('app.current_user', true));
grant select on spike_notes to spike_app_user;
`;

export const SUPERUSER_COUNT_SQL = "select count(*)::int as total from spike_notes;";

export const PROBE_SQL = `
begin;
set local role spike_app_user;
select set_config('app.current_user', 'alice', true);
select current_user::text as acting_role, id, owner, body from spike_notes order by id;
commit;
`;

/** `pg_sleep` blocks the single WASM thread, which is exactly the runaway case. */
export const SLOW_SQL = "select pg_sleep(10);";

/**
 * A table that `SETUP_SQL` never touches. `SETUP_SQL` starts with `drop ... if exists`, so the proof
 * looks the same on a fresh database and on one that survived. The marker does not: it is still
 * there when the proof runs again on the same worker, and it is gone only when the database
 * itself is gone, which is how the e2e suite tells a replaced worker from a surviving one.
 */
export const MARKER_TABLE = "spike_survivor_marker";
export const MARKER_CREATE_SQL = `create table ${MARKER_TABLE} (created_by text not null);`;
export const MARKER_PRESENT_SQL = `select to_regclass('public.${MARKER_TABLE}') is not null as marker_present;`;

export interface VisibleRow {
  readonly id: number;
  readonly owner: string;
  readonly body: string;
}

export interface RlsProof {
  readonly totalRowsAsSuperuser: number;
  readonly actingRole: string;
  readonly visibleRows: readonly VisibleRow[];
}

function resultWithField(results: readonly SqlResultSet[], field: string): SqlResultSet {
  const found = results.find((result) => result.fields.some((f) => f.name === field));
  if (!found) {
    throw new Error(`The worker returned no result set with a "${field}" column`);
  }
  return found;
}

function cell(row: readonly SqlCell[], result: SqlResultSet, field: string): SqlCell {
  const index = result.fields.findIndex((f) => f.name === field);
  return row[index] ?? null;
}

/** Asks Postgres, not the page's memory, whether the marker table exists. */
export async function markerTablePresent(client: PgliteWorkerClient): Promise<boolean> {
  const result = resultWithField(await client.exec(MARKER_PRESENT_SQL), "marker_present");
  return result.rows[0]?.[0] === true;
}

export async function createMarkerTable(client: PgliteWorkerClient): Promise<boolean> {
  await client.exec(MARKER_CREATE_SQL);
  return markerTablePresent(client);
}

export async function runRlsProof(client: PgliteWorkerClient): Promise<RlsProof> {
  await client.exec(SETUP_SQL);

  const countResult = resultWithField(await client.exec(SUPERUSER_COUNT_SQL), "total");
  const totalRowsAsSuperuser = Number(countResult.rows[0]?.[0] ?? Number.NaN);

  const probe = resultWithField(await client.exec(PROBE_SQL), "body");
  const visibleRows = probe.rows.map((row) => ({
    id: Number(cell(row, probe, "id")),
    owner: String(cell(row, probe, "owner")),
    body: String(cell(row, probe, "body")),
  }));
  const firstRow = probe.rows[0];
  const actingRole = firstRow ? String(cell(firstRow, probe, "acting_role")) : "";

  return { totalRowsAsSuperuser, actingRole, visibleRows };
}
