/**
 * Shared fixtures of the runner's integration suites: a real PGlite per run, the way the lab
 * starts one.
 */
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import {
  runMatrix,
  type CellResult,
  type MatrixResult,
  type MatrixRun,
  type RunMatrixOptions,
  type SubProbeKind,
  type SubProbeResult,
} from "@/lib/runner";
import type { SqlExecutor } from "@/lib/runner/types";
import { parseScenario, qualifiedName, type Operation, type Scenario } from "@/lib/scenario";

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const CAROL = "33333333-3333-4333-8333-333333333333";

/** The claims reader of the postgres-mode fixtures. */
export const CLAIM = (name: string): string =>
  `(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> '${name}')`;

export function scenarioOf(parts: Partial<Scenario> & Pick<Scenario, "schemaSql">): Scenario {
  const candidate = {
    id: "test-scenario",
    version: 1,
    title: "Test scenario",
    description: "",
    mode: "postgres",
    seedSql: "",
    personas: [],
    tables: [],
    expectations: [],
    ...parts,
  };
  const parsed = parseScenario(candidate);
  if (!parsed.ok) {
    throw new Error(`The fixture is not a valid scenario: ${parsed.message}`);
  }
  return parsed.scenario;
}

export function run(
  scenario: Scenario,
  options: Partial<RunMatrixOptions> = {},
): Promise<MatrixRun> {
  return runMatrix(scenario, {
    createEngine: () => createPgliteEngine(),
    supabase: SUPABASE_SETUP_SQL,
    ...options,
  });
}

export function cellOf(
  result: MatrixResult,
  personaId: string,
  table: string,
  operation: Operation,
): CellResult {
  const found = result.cells.find(
    (cell) => cell.personaId === personaId && cell.table === table && cell.operation === operation,
  );
  if (found === undefined) {
    throw new Error(`No cell ${personaId} / ${table} / ${operation}`);
  }
  return found;
}

export function subProbeOf(cell: CellResult, kind: SubProbeKind): SubProbeResult {
  const found = cell.subProbes.find((probe) => probe.kind === kind);
  if (found === undefined) {
    throw new Error(`No sub-probe ${kind} in cell ${cell.id}`);
  }
  return found;
}

/** `["1"]` for `1`: the serialised form of single-column keys. */
export const keys = (...values: (string | number)[]): string[] =>
  values.map((value) => JSON.stringify([String(value)]));

/** Every row of every user table, every sequence position, and the RLS catalog, as one string. */
export async function dumpDatabase(engine: SqlExecutor): Promise<string> {
  const relations = await engine.query(`
    select n.nspname::text as schema, c.relname::text as name, c.relkind::text as kind,
           c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'S') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
     order by 1, 2`);
  const parts: string[] = [JSON.stringify(relations.rows)];
  for (const relation of relations.rows) {
    const name = qualifiedName(String(relation.schema), String(relation.name));
    const sql =
      relation.kind === "S"
        ? `select last_value::text || ':' || is_called::text as dump from ${name}`
        : `select coalesce(json_agg(t order by t::text)::text, '[]') as dump from ${name} t`;
    parts.push(`${name}=${String((await engine.query(sql)).rows[0]?.dump)}`);
  }
  const policies = await engine.query(
    "select schemaname::text, tablename::text, policyname::text, cmd::text, roles::text, qual, with_check from pg_policies order by 1, 2, 3",
  );
  const roles = await engine.query(
    "select rolname::text, rolsuper, rolbypassrls from pg_roles where rolname !~ '^pg_' order by 1",
  );
  parts.push(JSON.stringify(policies.rows), JSON.stringify(roles.rows));
  return parts.join("\n");
}
