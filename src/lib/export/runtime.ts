/**
 * The SQL runtime of the exported test file: a handful of PL/pgSQL functions in `pg_temp` that do
 * in the database what `executor.ts`, `cells.ts` and `classify.ts` do in the runner. Every probe
 * statement they execute is handed to them by the cell blocks, and those come from the shared
 * probe builders; nothing here writes a probe.
 *
 * How the runner's mechanics map to SQL:
 *
 * - A probe transaction (begin, role, claims, probe, rollback) is a PL/pgSQL block that ALWAYS ends
 *   by raising SQLSTATE RLT00, which its own handler catches. A block with an exception handler is
 *   a subtransaction, so everything the probe did is rolled back, role and claims included, while
 *   the variables that hold what was measured keep their values. The database is unchanged after
 *   every cell, whether it passes or fails and whoever runs the file (psql, PGlite, a session
 *   that is already inside a transaction).
 * - `attempt` (a savepoint that is always rolled back) is the same kind of block, nested.
 * - A statement the runner sends as the superuser and that fails is re-raised as RLT01, an
 *   identity check that fails as RLT02. Neither is 42501, so neither can read as "blocked"
 *   (`SuperuserStepError` and `IdentityError` in the runner have no SQLSTATE at all).
 * - The role is switched by the statements of `identityProbes`, checked with `WHOAMI_PROBE`, and
 *   switched back with `RESET_ROLE_PROBE` right after the persona's statement, so no function of
 *   this runtime is ever CALLED as the persona (a schema may have revoked EXECUTE from PUBLIC).
 * - A per-row statement keeps its `$n::text` parameters and runs through `EXECUTE ... USING`,
 *   exactly as the runner sends it; the key comes from the loop. PL/pgSQL cannot spread an array
 *   into USING, so every EXECUTE passes `maxParams` values and a statement uses as many as it
 *   names.
 * - Results travel between statements in the custom setting `rls_leak_tester.report`. A cell that
 *   fails raises a WARNING at once and the last block of the file raises the exception that lists
 *   every failed cell. A temporary table would do the same but would outlive a failed run.
 * - The preflight decides what the cells may be believed about. A table whose rows are not the
 *   exported ones is `stale`: its cells are NOT run (`ready`), because literal keys compared with
 *   other rows print leaks that do not exist. A table the file does not know fails the run.
 *
 * Keys are jsonb arrays of the key columns' text (`["7", "b"]`), compared as jsonb values.
 */
import {
  NOT_ABOUT_THE_ROWS,
  RESET_ROLE_PROBE,
  ROW_SECURITY_VIOLATION,
  STATEMENT_DENIAL,
  WHOAMI_PROBE,
} from "@/lib/runner";
import { quoteLiteral } from "@/lib/scenario";
import { dollarQuote } from "./sql-text";

/** The custom setting that carries the report from block to block. */
export const REPORT_SETTING = "rls_leak_tester.report";

/**
 * The report at the start of the file. `setup`: lines of the preflight; `stale`: tables
 * (`schema.table`) whose cells are not run; `not_run`: how many cells that were.
 */
export const EMPTY_REPORT = {
  passed: 0,
  failed: [],
  warned: [],
  setup: [],
  stale: [],
  not_run: 0,
} as const;

const PREFIX = "pg_temp.rls_leak_tester_";

/** Every function of the runtime, in creation order; dropped in reverse before the verdict. */
export const RUNTIME_FUNCTIONS = [
  "blocked",
  "row_violation",
  "statement_denial",
  "key_of",
  "keys",
  "minus",
  "unite",
  "has_key",
  "touched",
  "become",
  "rows",
  "affected",
  "superuser_rows",
  "superuser_exec",
  "record",
  "ready",
  "judge",
  "reach",
  "blind_failed",
  "select_cell",
  "delete_cell",
  "update_cell",
  "insert_cell",
  "check_roles",
  "check_tables",
  "check_seed",
] as const;

export type RuntimeFunction = (typeof RUNTIME_FUNCTIONS)[number];

/** `pg_temp.rls_leak_tester_<name>`. */
export function runtimeName(name: RuntimeFunction): string {
  return `${PREFIX}${name}`;
}

/**
 * A JavaScript pattern of the classifier as a Postgres regular expression. The only construct
 * the two dialects spell differently in these patterns is the word boundary.
 */
export function toPostgresPattern(pattern: RegExp): string {
  if (pattern.flags !== "") {
    throw new RangeError(`The pattern ${String(pattern)} has flags; only plain patterns translate`);
  }
  return pattern.source.replaceAll("\\b", "\\y");
}

/** What a failed seed check says when the generator saw no reason in the scenario itself. */
export const SEED_CHANGED_ADVICE =
  "The expected keys in this file are literal: export the check again after changing the seed. If the keys come from a volatile default such as gen_random_uuid() or now(), they differ on every load: give the seed explicit keys.";

const ROLLBACK = "raise exception using errcode = 'RLT00', message = 'rolled back on purpose'";

function usingList(maxParams: number): string {
  return Array.from({ length: maxParams }, (_unused, index) => `p_params[${index + 1}]`).join(", ");
}

/**
 * The runtime. `maxParams` is the largest number of parameters one per-row statement of this
 * file names (key columns plus moved columns), at least 1.
 */
export function runtimeSql(maxParams: number, inconclusive: "fail" | "warn"): string {
  const using = usingList(Math.max(1, maxParams));
  const f = (name: RuntimeFunction): string => runtimeName(name);
  const failing = inconclusive === "fail" ? "true" : "p_status <> 'inconclusive'";
  const body = (text: string): string => dollarQuote(text.trim(), "fn");

  const functions: readonly string[] = [
    // -------------------------------------------------------------------------------- classify
    `create or replace function ${f("blocked")}(p_state text, p_message text) returns boolean
language sql immutable as ${body(`
  select p_state = '42501' and p_message !~ ${quoteLiteral(toPostgresPattern(NOT_ABOUT_THE_ROWS))}
`)};`,
    `create or replace function ${f("row_violation")}(p_state text, p_message text) returns boolean
language sql immutable as ${body(`
  select p_state = '42501' and p_message ~ ${quoteLiteral(toPostgresPattern(ROW_SECURITY_VIOLATION))}
`)};`,
    `create or replace function ${f("statement_denial")}(p_state text, p_message text) returns boolean
language sql immutable as ${body(`
  select p_state = '42501' and p_message ~ ${quoteLiteral(toPostgresPattern(STATEMENT_DENIAL))}
`)};`,
    // ------------------------------------------------------------------------------------ keys
    `create or replace function ${f("key_of")}(p_row jsonb, p_key_columns integer) returns jsonb
language sql immutable as ${body(`
  select jsonb_agg(p_row -> ('k' || i) order by i) from generate_series(0, p_key_columns - 1) as i
`)};`,
    `create or replace function ${f("keys")}(p_rows jsonb, p_key_columns integer) returns jsonb
language sql immutable as ${body(`
  select coalesce(jsonb_agg(k order by k::text collate "C"), '[]'::jsonb)
    from (select distinct ${f("key_of")}(item, p_key_columns) as k
            from jsonb_array_elements(p_rows) as listed(item)) as found
`)};`,
    `create or replace function ${f("minus")}(p_a jsonb, p_b jsonb) returns jsonb
language sql immutable as ${body(`
  select coalesce(jsonb_agg(a.item order by a.item::text collate "C"), '[]'::jsonb)
    from jsonb_array_elements(p_a) as a(item)
   where not exists (select 1 from jsonb_array_elements(p_b) as b(item) where b.item = a.item)
`)};`,
    `create or replace function ${f("unite")}(p_a jsonb, p_b jsonb) returns jsonb
language sql immutable as ${body(`
  select coalesce(jsonb_agg(u.item order by u.item::text collate "C"), '[]'::jsonb)
    from (select item from jsonb_array_elements(p_a) as a(item)
          union
          select item from jsonb_array_elements(p_b) as b(item)) as u
`)};`,
    `create or replace function ${f("has_key")}(p_keys jsonb, p_key jsonb) returns boolean
language sql immutable as ${body(`
  select exists (select 1 from jsonb_array_elements(p_keys) as k(item) where k.item = p_key)
`)};`,
    // Rows whose physical version differs, or that are gone: what a blind UPDATE touched.
    `create or replace function ${f("touched")}(p_before jsonb, p_after jsonb, p_key_columns integer) returns jsonb
language sql immutable as ${body(`
  select ${f("keys")}(coalesce(jsonb_agg(b.item), '[]'::jsonb), p_key_columns)
    from jsonb_array_elements(p_before) as b(item)
   where not exists (
     select 1 from jsonb_array_elements(p_after) as a(item)
      where ${f("key_of")}(a.item, p_key_columns) = ${f("key_of")}(b.item, p_key_columns)
        and a.item ->> 'row_version' = b.item ->> 'row_version')
`)};`,
    // -------------------------------------------------------------------------------- executor
    `create or replace function ${f("become")}(p_identity text[], p_role text) returns void
language plpgsql as ${body(`
declare
  v_statement text;
  v_who record;
begin
  foreach v_statement in array p_identity loop
    execute v_statement;
  end loop;
  execute ${quoteLiteral(WHOAMI_PROBE.inlined)} into v_who;
  if v_who.role is distinct from p_role then
    raise exception using errcode = 'RLT02', message = format(
      'The probe would have run as "%s" instead of "%s": the role switch did not take effect. Nothing was probed.',
      v_who.role, p_role);
  end if;
  if v_who.row_security is distinct from 'on' then
    raise exception using errcode = 'RLT02', message = format(
      'The probe would have run with row_security = %s: a statement that a policy filters would raise an error instead of running. Nothing was probed.',
      v_who.row_security);
  end if;
end
`)};`,
    // One statement as the persona; its rows as a jsonb array of objects.
    `create or replace function ${f("rows")}(p_identity text[], p_role text, p_statement text, p_params text[]) returns jsonb
language plpgsql as ${body(`
declare
  v_row record;
  v_rows jsonb[] := array[]::jsonb[];
begin
  perform ${f("become")}(p_identity, p_role);
  for v_row in execute p_statement using ${using} loop
    v_rows := array_append(v_rows, to_jsonb(v_row));
  end loop;
  execute ${quoteLiteral(RESET_ROLE_PROBE.inlined)};
  return to_jsonb(v_rows);
end
`)};`,
    // One statement as the persona that returns no rows; how many rows it touched.
    `create or replace function ${f("affected")}(p_identity text[], p_role text, p_statement text) returns bigint
language plpgsql as ${body(`
declare
  v_count bigint;
begin
  perform ${f("become")}(p_identity, p_role);
  execute p_statement;
  get diagnostics v_count = row_count;
  execute ${quoteLiteral(RESET_ROLE_PROBE.inlined)};
  return v_count;
end
`)};`,
    `create or replace function ${f("superuser_rows")}(p_statement text) returns jsonb
language plpgsql as ${body(`
declare
  v_row record;
  v_rows jsonb[] := array[]::jsonb[];
  v_state text;
  v_message text;
begin
  for v_row in execute p_statement loop
    v_rows := array_append(v_rows, to_jsonb(v_row));
  end loop;
  return to_jsonb(v_rows);
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  raise exception using errcode = 'RLT01', message = format(
    'A statement the runner sends as the superuser failed: [%s] %s', v_state, v_message);
end
`)};`,
    `create or replace function ${f("superuser_exec")}(p_statements text[]) returns void
language plpgsql as ${body(`
declare
  v_statement text;
  v_state text;
  v_message text;
begin
  foreach v_statement in array p_statements loop
    execute v_statement;
  end loop;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  raise exception using errcode = 'RLT01', message = format(
    'A statement the runner sends as the superuser failed: [%s] %s', v_state, v_message);
end
`)};`,
    // ---------------------------------------------------------------------------------- report
    `create or replace function ${f("record")}(p_cell text, p_status text, p_line text) returns void
language plpgsql as ${body(`
declare
  v_report jsonb := current_setting(${quoteLiteral(REPORT_SETTING)})::jsonb;
  v_bucket text := 'warned';
begin
  if p_status = 'pass' then
    v_report := jsonb_set(v_report, '{passed}', to_jsonb((v_report ->> 'passed')::integer + 1));
    raise notice 'ok - %', p_cell;
  else
    if p_status = 'setup' then
      v_bucket := 'setup';
    elsif ${failing} then
      v_bucket := 'failed';
    end if;
    v_report := jsonb_set(v_report, array[v_bucket], (v_report -> v_bucket) || to_jsonb(p_line));
    raise warning 'not ok - %', p_line;
  end if;
  perform set_config(${quoteLiteral(REPORT_SETTING)}, v_report::text, false);
end
`)};`,
    // Called by every cell block first. `false`: the preflight found other rows in the table than
    // the exported ones, so comparing them with the literal keys would prove nothing.
    `create or replace function ${f("ready")}(p_table text, p_cell text) returns boolean
language plpgsql as ${body(`
declare
  v_report jsonb := current_setting(${quoteLiteral(REPORT_SETTING)})::jsonb;
begin
  if not exists (select 1 from jsonb_array_elements_text(v_report -> 'stale') as listed(name) where name = p_table) then
    return true;
  end if;
  v_report := jsonb_set(v_report, '{not_run}', to_jsonb((v_report ->> 'not_run')::integer + 1));
  perform set_config(${quoteLiteral(REPORT_SETTING)}, v_report::text, false);
  raise notice 'not run - %: the rows of % are not the exported ones', p_cell, p_table;
  return false;
end
`)};`,
    // classify.ts in SQL: leak > escape > inconclusive > overblock > pass.
    `create or replace function ${f("judge")}(p_cell text, p_label text, p_expected jsonb, p_actual jsonb, p_inconclusive text, p_findings jsonb) returns void
language plpgsql as ${body(`
declare
  v_leaked jsonb := ${f("minus")}(p_actual, p_expected);
  v_missing jsonb := ${f("minus")}(p_expected, p_actual);
  v_status text := 'pass';
  v_details text;
begin
  if jsonb_array_length(v_leaked) > 0 then
    v_status := 'leak';
  elsif p_findings @> '[{"status": "escape"}]' then
    v_status := 'escape';
  elsif p_inconclusive is not null or p_findings @> '[{"status": "inconclusive"}]' then
    v_status := 'inconclusive';
  elsif jsonb_array_length(v_missing) > 0 or p_findings @> '[{"status": "overblock"}]' then
    v_status := 'overblock';
  end if;
  select string_agg(format('%s: %s', finding ->> 'status', finding ->> 'text'), '; ' order by position)
    into v_details
    from jsonb_array_elements(p_findings) with ordinality as listed(finding, position)
   where finding ->> 'status' <> 'pass';
  perform ${f("record")}(p_cell, v_status, format(
    '[%s] %s (%s): leaked keys %s; missing keys %s%s%s',
    v_status, p_cell, p_label,
    case when jsonb_array_length(v_leaked) = 0 then 'none' else v_leaked::text end,
    case when jsonb_array_length(v_missing) = 0 then 'none' else v_missing::text end,
    coalesce('; not measured: ' || p_inconclusive, ''),
    coalesce('; ' || v_details, '')));
end
`)};`,
    // ----------------------------------------------------------------------------------- reach
    // measureVisibleReach + perRowReach + pullRow of cells.ts.
    `create or replace function ${f("reach")}(
  p_identity text[], p_role text, p_key_columns integer, p_bulk text, p_row_statement text,
  p_pull_statements text[], p_pull_values jsonb, p_truth jsonb, p_expected jsonb,
  out o_actual jsonb, out o_inconclusive text, out o_state text, out o_message text)
language plpgsql as ${body(`
declare
  v_rows jsonb;
  v_key jsonb;
  v_state text;
  v_message text;
  v_failure text;
  v_pull_failure text;
  v_taken boolean;
  v_params text[];
begin
  o_actual := '[]'::jsonb;
  begin
    v_rows := ${f("rows")}(p_identity, p_role, p_bulk, null);
    ${ROLLBACK};
  exception
    when sqlstate 'RLT00' then
      o_actual := ${f("keys")}(v_rows, p_key_columns);
      return;
    when others then
      get stacked diagnostics o_state = returned_sqlstate, o_message = message_text;
  end;
  if not ${f("blocked")}(o_state, o_message) then
    o_inconclusive := format('[%s] %s', o_state, o_message);
  end if;
  -- A missing privilege, a failed identity check: about the statement, the same for every row.
  if p_row_statement is null or left(o_state, 3) = 'RLT' or ${f("statement_denial")}(o_state, o_message) then
    return;
  end if;
  o_inconclusive := null;
  begin
    for v_key in select item from jsonb_array_elements(p_truth) as listed(item) loop
      begin
        v_params := array(select jsonb_array_elements_text(v_key));
        v_rows := ${f("rows")}(p_identity, p_role, p_row_statement, v_params);
        ${ROLLBACK};
      exception
        when sqlstate 'RLT00' then
          o_actual := ${f("unite")}(o_actual, ${f("keys")}(v_rows, p_key_columns));
        when sqlstate 'RLT01' or sqlstate 'RLT02' then
          raise;
        when others then
          get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
          if not ${f("blocked")}(v_state, v_message) then
            v_failure := coalesce(v_failure, format('[%s] %s', v_state, v_message));
          elsif ${f("row_violation")}(v_state, v_message) and not ${f("has_key")}(p_expected, v_key) then
            -- USING let the persona at the row, WITH CHECK refused the unchanged row: the takeover.
            v_taken := false;
            v_pull_failure := null;
            for v_index in 1 .. coalesce(array_length(p_pull_statements, 1), 0) loop
              begin
                v_params := array(select jsonb_array_elements_text((p_pull_values -> (v_index - 1)) || v_key));
                v_rows := ${f("rows")}(p_identity, p_role, p_pull_statements[v_index], v_params);
                ${ROLLBACK};
              exception
                when sqlstate 'RLT00' then
                  if jsonb_array_length(v_rows) > 0 then
                    o_actual := ${f("unite")}(o_actual, ${f("keys")}(v_rows, p_key_columns));
                    v_taken := true;
                  end if;
                when sqlstate 'RLT01' or sqlstate 'RLT02' then
                  raise;
                when others then
                  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
                  -- A claim that does not fit the column's type (class 22) cannot take a row over.
                  if not ${f("blocked")}(v_state, v_message) and left(v_state, 2) <> '22' then
                    v_pull_failure := coalesce(v_pull_failure, format('[%s] %s', v_state, v_message));
                  end if;
              end;
              exit when v_taken;
            end loop;
            if not v_taken then
              v_failure := coalesce(v_failure, v_pull_failure);
            end if;
          end if;
      end;
    end loop;
  exception when sqlstate 'RLT01' or sqlstate 'RLT02' then
    get stacked diagnostics o_state = returned_sqlstate, o_message = message_text;
    o_actual := '[]'::jsonb;
    o_inconclusive := format('[%s] %s', o_state, o_message);
    return;
  end;
  o_inconclusive := v_failure;
end
`)};`,
    // withBlind of cells.ts for a blind statement that failed: refused is no finding, anything
    // else makes the cell inconclusive, and an earlier reason wins.
    `create or replace function ${f("blind_failed")}(p_inconclusive text, p_state text, p_message text) returns text
language sql immutable as ${body(`
  select case when ${f("blocked")}(p_state, p_message) then p_inconclusive
              else coalesce(p_inconclusive, format('[%s] %s', p_state, p_message)) end
`)};`,
    // ----------------------------------------------------------------------------------- cells
    `create or replace function ${f("select_cell")}(
  p_cell text, p_label text, p_identity text[], p_role text, p_key_columns integer,
  p_expected jsonb, p_truth jsonb, p_reach text, p_count text) returns void
language plpgsql as ${body(`
declare
  v_reach record;
  v_actual jsonb;
  v_inconclusive text;
  v_rows jsonb;
  v_visible bigint;
  v_state text;
  v_message text;
begin
  select * into v_reach from ${f("reach")}(p_identity, p_role, p_key_columns, p_reach, null, null, null, p_truth, p_expected);
  v_actual := v_reach.o_actual;
  v_inconclusive := v_reach.o_inconclusive;
  -- The key is not selectable. Can the role read the rows through another column?
  if v_reach.o_state is not null and ${f("blocked")}(v_reach.o_state, v_reach.o_message) then
    begin
      v_rows := ${f("rows")}(p_identity, p_role, p_count, null);
      ${ROLLBACK};
    exception
      when sqlstate 'RLT00' then
        v_visible := (v_rows -> 0 ->> 'visible_rows')::bigint;
        if v_visible = jsonb_array_length(p_truth) then
          v_actual := p_truth;
        elsif v_visible <> 0 then
          v_inconclusive := format(
            'The role can read %s of %s rows, but it holds no SELECT privilege on the primary key, so which rows they are cannot be told. Grant SELECT on the key columns to measure this cell.',
            v_visible, jsonb_array_length(p_truth));
        end if;
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        if not ${f("blocked")}(v_state, v_message) then
          v_inconclusive := format('[%s] %s', v_state, v_message);
        end if;
    end;
  end if;
  perform ${f("judge")}(p_cell, p_label, p_expected, v_actual, v_inconclusive, '[]'::jsonb);
end
`)};`,
    `create or replace function ${f("delete_cell")}(
  p_cell text, p_label text, p_identity text[], p_role text, p_key_columns integer,
  p_expected jsonb, p_truth jsonb, p_reach text, p_row_statement text,
  p_blind text, p_read_keys text) returns void
language plpgsql as ${body(`
declare
  v_reach record;
  v_actual jsonb;
  v_inconclusive text;
  v_before jsonb;
  v_after jsonb;
  v_state text;
  v_message text;
begin
  select * into v_reach from ${f("reach")}(p_identity, p_role, p_key_columns, p_reach, p_row_statement, null, null, p_truth, p_expected);
  v_actual := v_reach.o_actual;
  v_inconclusive := v_reach.o_inconclusive;
  -- The same without WHERE and RETURNING: no SELECT policy applies to it.
  if left(coalesce(v_reach.o_state, ''), 3) <> 'RLT' and jsonb_array_length(v_actual) < jsonb_array_length(p_truth) then
    begin
      v_before := ${f("keys")}(${f("superuser_rows")}(p_read_keys), p_key_columns);
      perform ${f("affected")}(p_identity, p_role, p_blind);
      v_after := ${f("keys")}(${f("superuser_rows")}(p_read_keys), p_key_columns);
      ${ROLLBACK};
    exception
      when sqlstate 'RLT00' then
        v_actual := ${f("unite")}(v_actual, ${f("minus")}(v_before, v_after));
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        v_inconclusive := ${f("blind_failed")}(v_inconclusive, v_state, v_message);
    end;
  end if;
  perform ${f("judge")}(p_cell, p_label, p_expected, v_actual, v_inconclusive, '[]'::jsonb);
end
`)};`,
    // updateCell of cells.ts: visible reach with takeover, the blind UPDATE, the escape pairs.
    // p_escapes: [{"label", "values" (the moved value), "before" (keys that carry it already)}];
    // the statements of pair n are p_escape_targeted[n], p_escape_bulk[n], p_escape_read[n].
    `create or replace function ${f("update_cell")}(
  p_cell text, p_label text, p_identity text[], p_role text, p_key_columns integer,
  p_expected jsonb, p_truth jsonb, p_reach text, p_row_statement text,
  p_pull_statements text[], p_pull_values jsonb,
  p_blind_source text[], p_blind_versions text, p_blind_constants text[], p_blind_pulls text[],
  p_escapes jsonb, p_escape_targeted text[], p_escape_bulk text[], p_escape_read text[]) returns void
language plpgsql as ${body(`
declare
  v_reach record;
  v_actual jsonb;
  v_inconclusive text;
  v_before jsonb;
  v_after jsonb;
  v_touched jsonb;
  v_refused boolean := false;
  v_failure text;
  v_candidates text[] := p_blind_constants || p_blind_pulls;
  v_constants integer := coalesce(array_length(p_blind_constants, 1), 0);
  v_state text;
  v_message text;
  v_findings jsonb := '[]'::jsonb;
  v_escape jsonb;
  v_source jsonb;
  v_rows jsonb;
  v_moved jsonb;
  v_params text[];
begin
  select * into v_reach from ${f("reach")}(p_identity, p_role, p_key_columns, p_reach, p_row_statement, p_pull_statements, p_pull_values, p_truth, p_expected);
  v_actual := v_reach.o_actual;
  v_inconclusive := v_reach.o_inconclusive;
  -- Without WHERE and RETURNING, and with a value that does not read the table: no SELECT policy
  -- applies to it. Which rows it touched is read as the superuser before and after.
  if v_constants > 0 and left(coalesce(v_reach.o_state, ''), 3) <> 'RLT'
     and jsonb_array_length(v_actual) < jsonb_array_length(p_truth) then
    begin
      perform ${f("superuser_exec")}(p_blind_source);
      v_before := ${f("superuser_rows")}(p_blind_versions);
      for v_index in 1 .. coalesce(array_length(v_candidates, 1), 0) loop
        -- A constant that WITH CHECK refused: another constant would fare the same.
        continue when v_refused and v_index <= v_constants;
        begin
          perform ${f("affected")}(p_identity, p_role, v_candidates[v_index]);
          v_after := ${f("superuser_rows")}(p_blind_versions);
          ${ROLLBACK};
        exception
          when sqlstate 'RLT00' then
            v_touched := ${f("touched")}(v_before, v_after, p_key_columns);
          when sqlstate 'RLT01' or sqlstate 'RLT02' then
            raise;
          when others then
            get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
            if v_index <= v_constants and ${f("blocked")}(v_state, v_message) and ${f("statement_denial")}(v_state, v_message) then
              -- No UPDATE privilege on THIS column. The file also names columns the role did not
              -- hold in the exported run (cell-plan.ts); the runner never plans such a constant,
              -- so this answer is nothing to it: neither refused nor failed, on to the next one.
              null;
            elsif ${f("blocked")}(v_state, v_message) then
              v_refused := true;
            elsif left(v_state, 2) <> '22' or v_index <= v_constants then
              v_failure := coalesce(v_failure, format('[%s] %s', v_state, v_message));
            end if;
        end;
        exit when v_touched is not null;
      end loop;
      ${ROLLBACK};
    exception
      when sqlstate 'RLT00' then
        if v_touched is not null then
          v_actual := ${f("unite")}(v_actual, v_touched);
        elsif not v_refused then
          v_inconclusive := coalesce(v_inconclusive, v_failure);
        end if;
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        v_inconclusive := ${f("blind_failed")}(v_inconclusive, v_state, v_message);
    end;
  end if;
  -- Scope escape: the first row that is expected AND reachable, moved to a foreign value.
  for v_index in 1 .. jsonb_array_length(p_escapes) loop
    v_escape := p_escapes -> (v_index - 1);
    select item into v_source from jsonb_array_elements(p_expected) with ordinality as listed(item, position)
     where ${f("has_key")}(v_actual, item) order by position limit 1;
    continue when v_source is null;
    begin
      v_params := array(select jsonb_array_elements_text((v_escape -> 'values') || v_source));
      v_rows := ${f("rows")}(p_identity, p_role, p_escape_targeted[v_index], v_params);
      ${ROLLBACK};
    exception
      when sqlstate 'RLT00' then
        if jsonb_array_length(v_rows) > 0 then
          v_findings := v_findings || jsonb_build_object('status', 'escape', 'text', format(
            'the row %s could be moved to %s', v_source, v_escape ->> 'label'));
        end if;
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        if not ${f("blocked")}(v_state, v_message) then
          v_findings := v_findings || jsonb_build_object('status', 'inconclusive', 'text', format(
            'moving the row %s to %s failed with [%s] %s', v_source, v_escape ->> 'label', v_state, v_message));
        end if;
    end;
    begin
      perform ${f("affected")}(p_identity, p_role, p_escape_bulk[v_index]);
      v_moved := ${f("minus")}(${f("keys")}(${f("superuser_rows")}(p_escape_read[v_index]), p_key_columns), v_escape -> 'before');
      ${ROLLBACK};
    exception
      when sqlstate 'RLT00' then
        if jsonb_array_length(v_moved) > 0 then
          v_findings := v_findings || jsonb_build_object('status', 'escape', 'text', format(
            'an UPDATE without WHERE moved the rows %s to %s', v_moved, v_escape ->> 'label'));
        end if;
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        if not ${f("blocked")}(v_state, v_message) then
          v_findings := v_findings || jsonb_build_object('status', 'inconclusive', 'text', format(
            'an UPDATE without WHERE to %s failed with [%s] %s', v_escape ->> 'label', v_state, v_message));
        end if;
    end;
  end loop;
  perform ${f("judge")}(p_cell, p_label, p_expected, v_actual, v_inconclusive, v_findings);
end
`)};`,
    // insertCell of cells.ts. p_clones: [{"kind", "expected", "source"}]; clone n copies its source
    // row with p_sources[n] (then p_grant) as the superuser and inserts with p_inserts[n].
    `create or replace function ${f("insert_cell")}(
  p_cell text, p_label text, p_identity text[], p_role text,
  p_clones jsonb, p_sources text[], p_grant text, p_inserts text[]) returns void
language plpgsql as ${body(`
declare
  v_clone jsonb;
  v_count bigint;
  v_outcome text;
  v_state text;
  v_message text;
  v_findings jsonb := '[]'::jsonb;
begin
  for v_index in 1 .. jsonb_array_length(p_clones) loop
    v_clone := p_clones -> (v_index - 1);
    v_message := null;
    begin
      -- The superuser lays the seeded row out for the persona; the persona inserts its clone.
      perform ${f("superuser_exec")}(array[p_sources[v_index], p_grant]);
      v_count := ${f("affected")}(p_identity, p_role, p_inserts[v_index]);
      ${ROLLBACK};
    exception
      when sqlstate 'RLT00' then
        v_outcome := case when v_count > 0 then 'allowed' else 'blocked' end;
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        v_outcome := case when ${f("blocked")}(v_state, v_message) then 'blocked' else 'inconclusive' end;
    end;
    v_findings := v_findings || jsonb_build_object(
      'status', case when v_outcome = 'inconclusive' then 'inconclusive'
                     when v_outcome = v_clone ->> 'expected' then 'pass'
                     when v_outcome = 'allowed' then 'escape'
                     else 'overblock' end,
      'text', case when v_outcome = 'inconclusive'
                   then format('%s, a clone of the row %s, failed with [%s] %s', v_clone ->> 'kind', v_clone -> 'source', v_state, v_message)
                   else format('%s, a clone of the row %s, was %s and must be %s', v_clone ->> 'kind', v_clone -> 'source', v_outcome, v_clone ->> 'expected') end);
  end loop;
  perform ${f("judge")}(p_cell, p_label, '[]'::jsonb, '[]'::jsonb, null, v_findings);
end
`)};`,
    // ------------------------------------------------------------------------------- preflight
    `create or replace function ${f("check_roles")}(p_roles text[]) returns void
language plpgsql as ${body(`
declare
  v_role text;
begin
  foreach v_role in array p_roles loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      raise notice 'ready - role %', v_role;
    else
      perform ${f("record")}(format('role %s', v_role), 'setup', format(
        '[setup] the role "%s" does not exist in this database. Load the roles before the schema (in supabase mode: the setup file of this export).', v_role));
    end if;
  end loop;
end
`)};`,
    // Every ordinary and partitioned table of the exposed schemas, as the runner's introspection
    // lists them. p_tables: [[schema, table], ...], the tables of the exported run.
    `create or replace function ${f("check_tables")}(p_schemas text[], p_tables jsonb) returns void
language plpgsql as ${body(`
declare
  v_table record;
begin
  for v_table in
    select n.nspname::text as schema_name, c.relname::text as table_name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname = any (p_schemas)
       and not ${f("has_key")}(p_tables, jsonb_build_array(n.nspname::text, c.relname::text))
     order by n.nspname collate "C", c.relname collate "C"
  loop
    perform ${f("record")}(format('table %s.%s', v_table.schema_name, v_table.table_name), 'setup', format(
      '[setup] the table %s.%s is not covered by this file: the exported run did not have it, so nothing is known about its isolation. Run the matrix on the current schema and export the check again.',
      v_table.schema_name, v_table.table_name));
  end loop;
end
`)};`,
    // p_volatile: what the generator knows about keys that cannot be reproduced, or null.
    `create or replace function ${f("check_seed")}(p_table text, p_key_columns integer, p_read_keys text, p_truth jsonb, p_cells integer, p_volatile text) returns void
language plpgsql as ${body(`
declare
  v_found jsonb := ${f("keys")}(${f("superuser_rows")}(p_read_keys), p_key_columns);
  v_unknown jsonb := ${f("minus")}(v_found, p_truth);
  v_gone jsonb := ${f("minus")}(p_truth, v_found);
  v_report jsonb;
begin
  if jsonb_array_length(v_unknown) = 0 and jsonb_array_length(v_gone) = 0 then
    raise notice 'ready - seed of %', p_table;
    return;
  end if;
  v_report := current_setting(${quoteLiteral(REPORT_SETTING)})::jsonb;
  v_report := jsonb_set(v_report, '{stale}', (v_report -> 'stale') || to_jsonb(p_table));
  perform set_config(${quoteLiteral(REPORT_SETTING)}, v_report::text, false);
  perform ${f("record")}(format('seed of %s', p_table), 'setup', format(
    '[setup] the rows of %s are not the rows this file was exported for (unknown keys %s; missing keys %s). %s %s',
    p_table, v_unknown, v_gone,
    coalesce(p_volatile, ${quoteLiteral(SEED_CHANGED_ADVICE)}),
    case when p_cells = 1 then 'The 1 cell of this table was not run.'
         else format('The %s cells of this table were not run.', p_cells) end));
end
`)};`,
  ];
  return functions.join("\n\n");
}

/** Drops every function of the runtime, the dependent ones first. */
export function dropRuntimeSql(): string {
  return [...RUNTIME_FUNCTIONS]
    .reverse()
    .map((name) => `drop function ${runtimeName(name)};`)
    .join("\n");
}
