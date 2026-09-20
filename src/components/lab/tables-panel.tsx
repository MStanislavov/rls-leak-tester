"use client";

import { Code, RotateCcw, ScanSearch, Sparkles, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  starterExpectedRowsSql,
  type CellRef,
  type ExpectationCellView,
  type ExpectationTableView,
  type LabTableView,
  type ScopeChoice,
  type TableColumnField,
  type TablesView,
} from "@/lib/lab";
import {
  MAX_EXPECTED_ROWS_SQL_LENGTH,
  OPERATIONS,
  SCOPES,
  type TableConfig,
  type TableRef,
} from "@/lib/scenario";
import { cn } from "@/lib/utils";
import { NativeSelect } from "./native-select";

interface TablesPanelProps {
  readonly view: TablesView;
  readonly busy: boolean;
  readonly stale: boolean;
  readonly canIntrospect: boolean;
  readonly onIntrospect: () => void;
  readonly onSetColumn: (
    effective: TableConfig,
    field: TableColumnField,
    column: string | undefined,
  ) => void;
  readonly onResetTable: (table: TableRef) => void;
  readonly onSetExpectation: (cell: CellRef, choice: ScopeChoice, expectedRowsSql?: string) => void;
  /**
   * `/s/[slug]`: every control is off. A scrolling table whose controls are all off has nothing
   * the keyboard can reach, so the scroll region takes the focus itself.
   */
  readonly readOnly?: boolean;
}

const DEFAULT_CHOICE = "default";

function isScopeChoice(value: string): value is ScopeChoice {
  return value === DEFAULT_CHOICE || (SCOPES as readonly string[]).includes(value);
}

const SOURCE_TEXT: Readonly<Record<LabTableView["source"], string>> = {
  configured: "set by you",
  suggested: "suggested from the column names",
  none: "no owner or tenant column found",
};

function ColumnSelect({
  table,
  field,
  label,
  onSetColumn,
  disabled,
}: {
  readonly table: LabTableView;
  readonly field: TableColumnField;
  readonly label: string;
  readonly onSetColumn: TablesPanelProps["onSetColumn"];
  readonly disabled: boolean;
}) {
  const id = `table-${table.key}-${field}`;
  const value = table.effective[field] ?? "";
  if (!table.introspected) {
    return (
      <p className="text-xs">
        <span className="text-muted-foreground">{label}: </span>
        <span className="font-mono">{value === "" ? "none" : value}</span>
      </p>
    );
  }
  const unknown = value !== "" && !table.columns.includes(value);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <NativeSelect
        id={id}
        data-testid={`table-${field}`}
        data-table={table.key}
        className="h-7 font-mono text-xs"
        value={value}
        disabled={disabled}
        aria-invalid={unknown}
        onChange={(event) =>
          onSetColumn(
            table.effective,
            field,
            event.target.value === "" ? undefined : event.target.value,
          )
        }
      >
        <option value="">none</option>
        {table.columns.map((column) => (
          <option key={column} value={column}>
            {column}
          </option>
        ))}
        {unknown ? <option value={value}>{value} (no such column)</option> : null}
      </NativeSelect>
    </div>
  );
}

function ExpectationCell({
  entry,
  label,
  onChange,
  onEditSql,
  disabled,
}: {
  readonly entry: ExpectationCellView;
  readonly label: string;
  readonly onChange: (choice: ScopeChoice) => void;
  readonly onEditSql: () => void;
  readonly disabled: boolean;
}) {
  const isDefault = entry.source === "default";
  return (
    <td className="p-1 align-top">
      <div className="flex items-center gap-1">
        <NativeSelect
          aria-label={label}
          data-testid="expectation-select"
          data-persona={entry.cell.personaId}
          data-table={`${entry.cell.schema}.${entry.cell.table}`}
          data-operation={entry.cell.operation}
          data-source={entry.source}
          className={cn(
            "h-7 min-w-[4.75rem] px-1 font-mono text-xs",
            isDefault && "border-dashed text-muted-foreground italic",
          )}
          value={isDefault ? DEFAULT_CHOICE : entry.scope}
          disabled={disabled}
          onChange={(event) => {
            if (isScopeChoice(event.target.value)) {
              onChange(event.target.value);
            }
          }}
        >
          <option value={DEFAULT_CHOICE}>{entry.defaultScope} (default)</option>
          {SCOPES.map((scope) => (
            <option key={scope} value={scope}>
              {scope}
            </option>
          ))}
        </NativeSelect>
        {entry.scope === "custom" ? (
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label={`Edit the expected rows SQL: ${label}`}
            data-testid="expectation-edit-sql"
            disabled={disabled}
            onClick={onEditSql}
          >
            <Code aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </td>
  );
}

function TableSection({
  entry,
  onSetColumn,
  onResetTable,
  onSetExpectation,
  onEditSql,
  readOnly = false,
}: {
  readonly entry: ExpectationTableView;
  readonly onEditSql: (cell: ExpectationCellView, table: LabTableView) => void;
} & Pick<TablesPanelProps, "onSetColumn" | "onResetTable" | "onSetExpectation" | "readOnly">) {
  const { table } = entry;
  return (
    <li
      data-testid="table-config"
      data-table={table.key}
      data-source={table.source}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-mono text-sm font-semibold">{table.key}</h3>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          {table.source === "suggested" ? <Sparkles aria-hidden="true" className="size-3" /> : null}
          {table.introspected
            ? SOURCE_TEXT[table.source]
            : "from the scenario; not introspected yet"}
        </span>
        {table.introspected && table.source === "configured" ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="table-reset"
            disabled={readOnly}
            onClick={() => onResetTable({ schema: table.schema, name: table.name })}
          >
            <RotateCcw aria-hidden="true" />
            Use the suggestion
          </Button>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <ColumnSelect
          table={table}
          field="ownerColumn"
          label="Owner column"
          onSetColumn={onSetColumn}
          disabled={readOnly}
        />
        <ColumnSelect
          table={table}
          field="tenantColumn"
          label="Tenant column"
          onSetColumn={onSetColumn}
          disabled={readOnly}
        />
      </div>
      {table.introspected && table.primaryKey.length === 0 ? (
        <p className="inline-flex items-start gap-1.5 text-xs font-medium text-status-overblock">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          No primary key: rows cannot be tracked, every cell of this table will be skipped.
        </p>
      ) : null}
      {table.unknownColumns.length > 0 ? (
        <p className="inline-flex items-start gap-1.5 text-xs font-medium text-status-overblock">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          The table has no column {table.unknownColumns.join(", ")}: its cells will be skipped.
        </p>
      ) : null}

      {entry.rows.length === 0 ? null : (
        <div
          className="relative overflow-x-auto"
          {...(readOnly
            ? { tabIndex: 0, role: "group", "aria-label": `Expectations for ${table.key}` }
            : {})}
        >
          <table className="w-full min-w-[27rem] border-collapse text-xs">
            <caption className="sr-only">
              Expected scope per persona and operation for {table.key}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="px-1 py-1 text-left font-medium">
                  Persona
                </th>
                {OPERATIONS.map((operation) => (
                  <th
                    key={operation}
                    scope="col"
                    className="px-1 py-1 text-left font-mono uppercase"
                  >
                    {operation}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entry.rows.map((row) => (
                <tr key={row.personaId} className="border-t">
                  <th scope="row" className="px-1 py-1 text-left font-normal">
                    <span className="block">{row.personaLabel}</span>
                    <span className="font-mono text-muted-foreground">{row.dbRole}</span>
                  </th>
                  {row.cells.map((cell) => (
                    <ExpectationCell
                      key={cell.cell.operation}
                      entry={cell}
                      label={`${row.personaLabel}, ${table.key}, ${cell.cell.operation}`}
                      disabled={readOnly}
                      onChange={(choice) =>
                        onSetExpectation(
                          cell.cell,
                          choice,
                          choice === "custom" && cell.expectedRowsSql === null
                            ? starterExpectedRowsSql(table, table.primaryKey)
                            : undefined,
                        )
                      }
                      onEditSql={() => onEditSql(cell, table)}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

interface SqlDraft {
  readonly cell: CellRef;
  readonly title: string;
  readonly text: string;
}

export function TablesPanel(props: TablesPanelProps) {
  const { view } = props;
  const [draft, setDraft] = useState<SqlDraft | null>(null);
  const draftInvalid =
    draft !== null &&
    (draft.text.trim() === "" || draft.text.length > MAX_EXPECTED_ROWS_SQL_LENGTH);

  return (
    <section aria-labelledby="tables-heading" className="flex flex-col gap-3 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="tables-heading" className="text-base font-semibold">
            Tables and expectations
          </h2>
          <p className="text-xs text-muted-foreground">
            Which rows each persona should reach: none, own, tenant, all, or a custom query. A
            dashed, italic cell is a default you have not set.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy || !props.canIntrospect || props.readOnly === true}
          data-testid="introspect-button"
          onClick={props.onIntrospect}
        >
          <ScanSearch aria-hidden="true" />
          Introspect
        </Button>
      </div>

      {view.introspected && props.stale ? (
        <p className="text-xs text-muted-foreground" data-testid="tables-stale">
          The table list is from before your last edit. Run or introspect to refresh it.
        </p>
      ) : null}
      {view.tables.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="tables-empty">
          {view.introspected
            ? "No table was found in the exposed schemas."
            : "No tables yet. Write a schema, then run or press Introspect: the tables appear here with a suggested owner and tenant column."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.expectations.map((entry) => (
            <TableSection
              key={entry.table.key}
              entry={entry}
              onSetColumn={props.onSetColumn}
              onResetTable={props.onResetTable}
              onSetExpectation={props.onSetExpectation}
              readOnly={props.readOnly}
              onEditSql={(cell, table) =>
                setDraft({
                  cell: cell.cell,
                  title: `${cell.cell.personaId}, ${table.key}, ${cell.cell.operation}`,
                  text: cell.expectedRowsSql ?? starterExpectedRowsSql(table, table.primaryKey),
                })
              }
            />
          ))}
        </ul>
      )}
      {view.orphans.length > 0 ? (
        <p
          data-testid="orphan-expectations"
          className="inline-flex items-start gap-1.5 text-xs font-medium text-status-overblock"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {view.orphans.length} expectation{view.orphans.length === 1 ? "" : "s"} name a table or
          persona that does not exist ({" "}
          {[...new Set(view.orphans.map((orphan) => `${orphan.schema}.${orphan.table}`))].join(
            ", ",
          )}
          ) and will not be tested.
        </p>
      ) : null}

      <Dialog open={draft !== null} onOpenChange={(open) => (open ? undefined : setDraft(null))}>
        <DialogContent data-testid="expected-rows-dialog" className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Expected rows</DialogTitle>
            <DialogDescription>
              A query that returns the primary keys this persona should reach. It runs as the
              superuser; :sub is the persona&apos;s user id and :claims its claims as jsonb.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="expected-rows-sql" className="font-mono text-xs">
              {draft?.title}
            </Label>
            <Textarea
              id="expected-rows-sql"
              data-testid="expected-rows-sql"
              className="min-h-40 font-mono text-xs"
              spellCheck={false}
              value={draft?.text ?? ""}
              aria-invalid={draftInvalid}
              onChange={(event) =>
                setDraft((current) =>
                  current === null ? null : { ...current, text: event.target.value },
                )
              }
            />
            {draftInvalid ? (
              <p className="text-xs font-medium text-status-leak">
                The query must not be empty and may have at most{" "}
                {MAX_EXPECTED_ROWS_SQL_LENGTH.toLocaleString("en")} characters.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={draftInvalid}
              data-testid="expected-rows-save"
              onClick={() => {
                if (draft !== null) {
                  props.onSetExpectation(draft.cell, "custom", draft.text);
                  setDraft(null);
                }
              }}
            >
              Use this query
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
