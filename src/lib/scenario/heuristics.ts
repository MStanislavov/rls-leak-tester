/**
 * Column-name heuristics (brief section 3.4): after introspection the lab suggests which column
 * holds the owner and which the tenant. The user can override both; a table the scenario already
 * configures is never second-guessed.
 */
import type { TableConfig, TableRef } from "./types";

/** In priority order: the first name that matches a column wins. */
export const OWNER_COLUMN_NAMES = ["user_id", "owner_id", "created_by"] as const;
/** In priority order: the first name that matches a column wins. */
export const TENANT_COLUMN_NAMES = [
  "tenant_id",
  "org_id",
  "organization_id",
  "team_id",
  "workspace_id",
] as const;

/** Code-unit order: the same on every machine, unlike `localeCompare`. */
export function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * The column to suggest for a list of candidate names. Matching ignores case; when two columns
 * differ only in case (`"User_Id"` and `user_id`), the all-lower-case spelling wins, then the
 * smaller in code-unit order, so the input order never changes the answer.
 */
function pick(columns: readonly string[], candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const matches = columns
      .filter((column) => column.toLowerCase() === candidate)
      .sort(compareText);
    const best = matches.find((column) => column === candidate) ?? matches[0];
    if (best !== undefined) {
      return best;
    }
  }
  return undefined;
}

export type TableConfigSuggestion = Pick<TableConfig, "ownerColumn" | "tenantColumn">;

/** Suggests the owner and tenant column from a table's column names, as the catalog spells them. */
export function suggestTableConfig(columns: readonly string[]): TableConfigSuggestion {
  const suggestion: TableConfigSuggestion = {};
  const ownerColumn = pick(columns, OWNER_COLUMN_NAMES);
  if (ownerColumn !== undefined) {
    suggestion.ownerColumn = ownerColumn;
  }
  const tenantColumn = pick(columns, TENANT_COLUMN_NAMES);
  if (tenantColumn !== undefined) {
    suggestion.tenantColumn = tenantColumn;
  }
  return suggestion;
}

/** A table as introspection reports it, with its column names. */
export interface IntrospectedTableColumns extends TableRef {
  columns: readonly string[];
}

/**
 * The effective config of every introspected table, sorted by schema and name. A table the
 * scenario configures keeps exactly that config (that is the user's override, including "no owner
 * column"); every other table gets the suggestion.
 */
export function resolveTableConfigs(
  configured: readonly TableConfig[],
  introspected: readonly IntrospectedTableColumns[],
): TableConfig[] {
  const byKey = new Map(
    configured.map((table) => [JSON.stringify([table.schema, table.name]), table]),
  );
  return [...introspected]
    .sort((a, b) => compareText(a.schema, b.schema) || compareText(a.name, b.name))
    .map((table) => {
      const override = byKey.get(JSON.stringify([table.schema, table.name]));
      return override === undefined
        ? { schema: table.schema, name: table.name, ...suggestTableConfig(table.columns) }
        : { ...override };
    });
}
