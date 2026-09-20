"use client";

/**
 * The lab workbench: the working scenario on the left, the evidence on the right. All state is
 * the reducer of `@/lib/lab`; this component wires it to the worker (through `useLabRunner`),
 * the local store and the browser. Every string that comes from the scenario or the database is
 * rendered as a text node (SEC-001).
 */
// Keep this import FIRST: it must run before any module below builds a zod schema (see the file).
import "@/lib/lab/zod-csp";
import { CircleStop, Play, TriangleAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { STATUS_CLASSES, STATUS_ICONS } from "@/components/site/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  blankScenario,
  buildMatrixView,
  buildTablesView,
  claimsTextOf,
  formatIssue,
  hasClaimsErrors,
  initialLabState,
  issuesUnder,
  isBusy,
  isCatalogStale,
  isDirty,
  isResultStale,
  labEntryQuery,
  labReducer,
  parseScenarioFile,
  renamedScenario,
  scenarioFileName,
  scenarioFileText,
  scenarioFromTemplate,
  statusChips,
  validateLabScenario,
  SCENARIO_FILE_TYPE,
  type LabEntry,
  type LabState,
  type ScenarioOrigin,
  type SqlKind,
} from "@/lib/lab";
import { MAX_TITLE_LENGTH, newScenarioId, resolveOptions, type Scenario } from "@/lib/scenario";
import {
  TEMPLATES,
  TEMPLATE_VARIANT_KINDS,
  findTemplate,
  type TemplateVariantKind,
} from "@/lib/scenario/templates";
import { STATUS_META, statusMeta } from "@/lib/site/status";
import { createLocalScenarioStore, isStoreError } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CellDrawer } from "./cell-drawer";
import { FindingsList } from "./findings-list";
import {
  LAB_CELL_DRAWER_EXTENSIONS,
  LAB_TOOLBAR_EXTENSIONS,
  type LabCellDrawerExtension,
  type LabSlotProps,
  type LabToolbarExtension,
} from "./lab-extensions";
import { loadLabPorts } from "./lab-engine";
import { NativeSelect } from "./native-select";
import { PersonasPanel } from "./personas-panel";
import { ResultMatrix } from "./result-matrix";
import { ScenarioMenu } from "./scenario-menu";
import { ScenarioPanel } from "./scenario-panel";
import { SetupErrorPanel } from "./setup-error-panel";
import type { SqlEditorHandle } from "./sql-editor";
import { TablesPanel } from "./tables-panel";
import { useLabRunner } from "./use-lab-runner";
import { VerdictBanner } from "./verdict-banner";

export interface LabWorkbenchProps {
  /** What to open, from the query string (parsed with zod on the server). */
  readonly entry: LabEntry;
  readonly toolbarExtensions?: readonly LabToolbarExtension[];
  readonly cellDrawerExtensions?: readonly LabCellDrawerExtension[];
  /**
   * `/s/[slug]`: this scenario is opened READ-ONLY instead of `entry`. It can be run and
   * inspected; no control that edits, saves or replaces it is offered. `notice` goes under the
   * toolbar.
   */
  readonly shared?: { readonly scenario: Scenario; readonly notice: ReactNode };
}

interface InitialArgs {
  readonly entry: LabEntry;
  readonly sharedScenario: Scenario | null;
}

function initialState({ entry, sharedScenario }: InitialArgs): LabState {
  if (sharedScenario !== null) {
    return initialLabState(sharedScenario, { kind: "imported" });
  }
  if (entry.kind === "template") {
    const template = findTemplate(entry.templateId);
    if (template !== undefined) {
      return initialLabState(scenarioFromTemplate(template, entry.variant), entry);
    }
  }
  // A saved entry is read from the store after mount; until then the lab shows a blank scenario.
  return initialLabState(blankScenario(newScenarioId("Untitled scenario")), { kind: "blank" });
}

function storeMessage(error: unknown): string {
  if (isStoreError(error)) {
    return error.message;
  }
  return error instanceof Error ? error.message : "The scenario store failed.";
}

function originQuery(origin: ScenarioOrigin): string {
  return origin.kind === "imported" ? "" : labEntryQuery(origin);
}

function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: SCENARIO_FILE_TYPE }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** A disabled fieldset switches every control inside it off: how a panel becomes read-only. */
function Lockable({
  locked,
  children,
}: {
  readonly locked: boolean;
  readonly children: ReactNode;
}) {
  return locked ? (
    <fieldset disabled aria-label="Read-only" className="m-0 min-w-0 border-0 p-0">
      {children}
    </fieldset>
  ) : (
    children
  );
}

export function LabWorkbench({
  entry,
  toolbarExtensions = LAB_TOOLBAR_EXTENSIONS,
  cellDrawerExtensions = LAB_CELL_DRAWER_EXTENSIONS,
  shared,
}: LabWorkbenchProps) {
  const readOnly = shared !== undefined;
  const [state, dispatch] = useReducer(
    labReducer,
    { entry, sharedScenario: shared?.scenario ?? null },
    initialState,
  );
  const runner = useLabRunner(dispatch);
  const store = useMemo(() => createLocalScenarioStore(), []);
  const schemaHandle = useRef<SqlEditorHandle | null>(null);
  const seedHandle = useRef<SqlEditorHandle | null>(null);
  const handles = useMemo<Record<SqlKind, RefObject<SqlEditorHandle | null>>>(
    () => ({ schema: schemaHandle, seed: seedHandle }),
    [],
  );
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  /** What "Discard changes?" will do when the user says yes. */
  const [pendingLoad, setPendingLoad] = useState<(() => void) | null>(null);

  const { scenario, run, result } = state;
  const busy = isBusy(run);
  const validation = useMemo(() => validateLabScenario(scenario), [scenario]);
  const dirty = useMemo(() => isDirty(state), [state]);
  const claimsBroken = hasClaimsErrors(state);
  const resultStale = isResultStale(state);
  const problems = useMemo(
    () => [
      ...(claimsBroken ? ["A persona's claims are not valid JSON claims; see the persona."] : []),
      ...validation.issues.map(formatIssue),
    ],
    [claimsBroken, validation.issues],
  );
  const runnable = problems.length === 0;

  const matrixView = useMemo(
    () =>
      result === null ? null : buildMatrixView(result, state.statusFilter, state.findings ?? []),
    [result, state.statusFilter, state.findings],
  );
  const tablesView = useMemo(
    () => buildTablesView(scenario, state.catalog),
    [scenario, state.catalog],
  );
  const selectedCell = useMemo(
    () => result?.cells.find((cell) => cell.id === state.selectedCellId) ?? null,
    [result, state.selectedCellId],
  );
  const selectedPersona =
    result?.personas.find((persona) => persona.id === selectedCell?.personaId) ?? null;

  // The engine's JavaScript (not the worker, not the WASM) is fetched ahead of the first Run.
  useEffect(() => {
    loadLabPorts().catch(() => undefined);
  }, []);

  // ?saved=<id>: the local store only exists in the browser, so the entry is read after mount.
  const savedEntryId = entry.kind === "saved" ? entry.storeId : null;
  useEffect(() => {
    if (savedEntryId === null) {
      return;
    }
    let cancelled = false;
    store.get(savedEntryId).then(
      (stored) => {
        if (cancelled) {
          return;
        }
        if (stored === null) {
          toast.error("That saved scenario does not exist in this browser.");
          return;
        }
        dispatch({
          type: "scenario/load",
          scenario: stored.scenario,
          origin: { kind: "saved", storeId: stored.id },
        });
      },
      (error: unknown) => toast.error(storeMessage(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [savedEntryId, store]);

  // The address follows the scenario, so a reload reopens the same thing.
  const query = originQuery(state.origin);
  useEffect(() => {
    const target = query === "" ? window.location.pathname : `${window.location.pathname}?${query}`;
    if (`${window.location.pathname}${window.location.search}` !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [query]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const highlighted = state.highlightedTable;
  useEffect(() => {
    if (highlighted === null) {
      return;
    }
    for (const group of document.querySelectorAll<HTMLElement>(
      '[data-testid="matrix-table-group"]',
    )) {
      if (group.dataset.table === highlighted) {
        group.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlighted]);

  /** The scenario including what is in the editors this instant; also flushes them. */
  const getScenario = useCallback((): Scenario => {
    const current = latest.current.scenario;
    const schemaSql = schemaHandle.current?.getValue() ?? current.schemaSql;
    const seedSql = seedHandle.current?.getValue() ?? current.seedSql;
    schemaHandle.current?.flush();
    seedHandle.current?.flush();
    return schemaSql === current.schemaSql && seedSql === current.seedSql
      ? current
      : { ...current, schemaSql, seedSql };
  }, []);

  /** The scenario if it may be run, saved or exported; else a toast that says why not. */
  const validScenario = useCallback((): Scenario | null => {
    const checked = validateLabScenario(getScenario());
    if (hasClaimsErrors(latest.current)) {
      toast.error("A persona's claims are not valid JSON. Fix them first.");
      return null;
    }
    if (checked.scenario === null) {
      toast.error(`The scenario is not valid: ${checked.issues.map(formatIssue).join("; ")}`);
      return null;
    }
    return checked.scenario;
  }, [getScenario]);

  const startRun = useCallback(() => {
    if (isBusy(latest.current.run)) {
      return;
    }
    const valid = validScenario();
    if (valid !== null) {
      runner.run(valid);
    }
  }, [runner, validScenario]);

  const startIntrospect = useCallback(() => {
    if (isBusy(latest.current.run)) {
      return;
    }
    const valid = validScenario();
    if (valid !== null) {
      runner.introspect(valid);
    }
  }, [runner, validScenario]);

  // Ctrl+Enter / Cmd+Enter anywhere on the page. Inside an editor CodeMirror handles it first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) {
        event.preventDefault();
        startRun();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startRun]);

  /** Replaces the working scenario, after asking when there are unsaved changes. */
  const guardedLoad = useCallback(
    (load: () => void): void => {
      // The editors hand their text over debounced, so the check reads them directly.
      if (isDirty({ scenario: getScenario(), baseline: latest.current.baseline })) {
        setPendingLoad(() => load);
      } else {
        load();
      }
    },
    [getScenario],
  );

  const loadScenario = useCallback(
    (next: Scenario, origin: ScenarioOrigin = { kind: "imported" }) =>
      guardedLoad(() => {
        // A run of the scenario that is being replaced has nothing left to report.
        runner.cancel();
        dispatch({ type: "scenario/load", scenario: next, origin });
      }),
    [guardedLoad, runner],
  );

  /** An edit of the schema from outside the editor (a verified fix the user applies). */
  const applySchemaSql = useCallback((schemaSql: string) => {
    const handle = schemaHandle.current;
    if (handle === null) {
      // The schema tab is not on screen; its editor reads the state when it mounts.
      dispatch({ type: "sql/set", kind: "schema", text: schemaSql });
    } else {
      handle.setValue(schemaSql);
    }
    dispatch({ type: "tab/show", tab: "schema" });
  }, []);

  const loadTemplate = useCallback(
    (templateId: string, variant: TemplateVariantKind) => {
      const template = findTemplate(templateId);
      if (template !== undefined) {
        loadScenario(scenarioFromTemplate(template, variant), {
          kind: "template",
          templateId,
          variant,
        });
      }
    },
    [loadScenario],
  );

  const save = useCallback(
    (title: string | null) => {
      const valid = validScenario();
      if (valid === null) {
        return;
      }
      const origin = latest.current.origin;
      const input =
        title === null && origin.kind === "saved"
          ? { id: origin.storeId, scenario: valid }
          : {
              scenario: renamedScenario(
                valid,
                newScenarioId(title ?? valid.title),
                title ?? valid.title,
              ),
            };
      store.save(input).then(
        (stored) => {
          dispatch({ type: "scenario/saved", scenario: stored.scenario, storeId: stored.id });
          toast.success(`Saved "${stored.title}" in this browser.`);
        },
        (error: unknown) => toast.error(storeMessage(error)),
      );
    },
    [store, validScenario],
  );

  const openSaved = useCallback(
    (id: string) => {
      store.get(id).then(
        (stored) => {
          if (stored === null) {
            toast.error("That saved scenario could not be read.");
            return;
          }
          loadScenario(stored.scenario, { kind: "saved", storeId: stored.id });
        },
        (error: unknown) => toast.error(storeMessage(error)),
      );
    },
    [loadScenario, store],
  );

  const importFile = useCallback(
    (file: File) => {
      file.text().then(
        (text) => {
          const parsed = parseScenarioFile(text);
          if (parsed.ok) {
            loadScenario(parsed.scenario, { kind: "imported" });
          } else {
            toast.error(`${file.name} is not a scenario: ${parsed.message}`);
          }
        },
        () => toast.error(`${file.name} could not be read.`),
      );
    },
    [loadScenario],
  );

  const exportJson = useCallback(() => {
    const valid = validScenario();
    if (valid !== null) {
      download(scenarioFileName(valid), scenarioFileText(valid));
    }
  }, [validScenario]);

  const slotProps: LabSlotProps = {
    scenario,
    getScenario,
    validation,
    origin: state.origin,
    dirty,
    run,
    busy,
    result,
    matrixRun: state.matrixRun,
    resultIsStale: resultStale,
    catalog: state.catalog,
    findings: state.findings ?? [],
    runIsolated: runner.runIsolated,
    loadScenario,
    applySchemaSql,
    startRun,
  };

  const templateId = state.origin.kind === "template" ? state.origin.templateId : "";
  const variant = state.origin.kind === "template" ? state.origin.variant : null;
  const chips = result === null ? [] : statusChips(result.counts);

  return (
    <main
      data-lab-root=""
      data-testid="lab-root"
      data-run-status={run.status}
      data-dirty={dirty}
      data-origin={state.origin.kind}
      data-read-only={readOnly}
      className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col gap-4 px-4 py-4 sm:px-6"
    >
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
            <h1 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {readOnly ? "Shared scenario, read-only" : "Lab"}
            </h1>
            <Label htmlFor="scenario-title" className="sr-only">
              Scenario title
            </Label>
            <Input
              id="scenario-title"
              data-testid="scenario-title"
              className="h-9 text-base font-semibold"
              value={scenario.title}
              maxLength={MAX_TITLE_LENGTH}
              readOnly={readOnly}
              onChange={(event) => dispatch({ type: "title/set", title: event.target.value })}
            />
          </div>
          {readOnly ? null : (
            <div className="flex flex-col gap-1">
              <Label htmlFor="template-select">Template</Label>
              <NativeSelect
                id="template-select"
                data-testid="template-select"
                className="w-56"
                disabled={busy}
                value={templateId}
                onChange={(event) => loadTemplate(event.target.value, variant ?? "leaky")}
              >
                {templateId === "" ? <option value="">Your own scenario</option> : null}
                {TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.title}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {variant === null ? null : (
            <div role="group" aria-label="Template variant" className="flex items-center gap-1">
              {TEMPLATE_VARIANT_KINDS.map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={variant === kind ? "secondary" : "ghost"}
                  aria-pressed={variant === kind}
                  disabled={busy}
                  data-testid={`variant-${kind}`}
                  onClick={() => loadTemplate(templateId, kind)}
                >
                  {kind}
                </Button>
              ))}
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {readOnly ? null : (
              <ScenarioMenu
                disabled={busy}
                canSave={runnable}
                title={scenario.title}
                savedId={state.origin.kind === "saved" ? state.origin.storeId : null}
                onNew={() =>
                  loadScenario(blankScenario(newScenarioId("Untitled scenario")), { kind: "blank" })
                }
                onSave={() => save(null)}
                onSaveAs={(title) => save(title)}
                onExport={exportJson}
                onImportFile={importFile}
                listSaved={() =>
                  store.list().catch((error: unknown) => {
                    toast.error(storeMessage(error));
                    return [];
                  })
                }
                onOpenSaved={openSaved}
                onDeleteSaved={(id) =>
                  store.remove(id).catch((error: unknown) => {
                    toast.error(storeMessage(error));
                  })
                }
              />
            )}
            <div data-testid="lab-toolbar-extensions" className="contents">
              {toolbarExtensions.map((Extension, index) => (
                <Extension
                  key={`${Extension.displayName ?? Extension.name}-${index}`}
                  {...slotProps}
                />
              ))}
            </div>
            {busy ? (
              <Button
                type="button"
                variant="destructive"
                data-testid="cancel-button"
                onClick={runner.cancel}
              >
                <CircleStop aria-hidden="true" />
                Cancel
              </Button>
            ) : (
              <Button
                type="button"
                disabled={!runnable}
                data-testid="run-button"
                aria-keyshortcuts="Control+Enter Meta+Enter"
                onClick={startRun}
              >
                <Play aria-hidden="true" />
                Run
                <kbd className="hidden rounded border border-primary-foreground/40 px-1 font-mono text-[0.65rem] sm:inline">
                  Ctrl/Cmd+Enter
                </kbd>
              </Button>
            )}
          </div>
        </div>
        {templateId === "" ? null : (
          <p className="text-sm text-muted-foreground" data-testid="template-description">
            <span className="font-medium text-foreground">
              {variant === "fixed" ? "The fix: " : "The leak: "}
            </span>
            {variant === "fixed" ? findTemplate(templateId)?.fix : findTemplate(templateId)?.leak}
          </p>
        )}
        {shared?.notice}
        {problems.length === 0 ? null : (
          <div
            data-testid="scenario-problems"
            className="flex items-start gap-2 rounded-md border border-status-overblock/40 bg-status-overblock-bg p-3 text-sm text-status-overblock"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">
                The scenario cannot run, be saved or be exported until this is fixed:
              </p>
              <ul className="list-disc pl-5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </header>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ScenarioPanel
            mode={scenario.mode}
            grants={resolveOptions(scenario).supabaseGrants}
            schemaSql={scenario.schemaSql}
            seedSql={scenario.seedSql}
            loadCount={state.loadCount}
            activeTab={state.activeTab}
            setupError={state.setupError}
            personaCount={scenario.personas.length}
            personasInvalid={claimsBroken || issuesUnder(validation.issues, "personas").length > 0}
            handles={handles}
            onTabChange={(tab) => dispatch({ type: "tab/show", tab })}
            onSqlChange={(kind, text) => dispatch({ type: "sql/set", kind, text })}
            onModeChange={(mode) => dispatch({ type: "mode/set", mode })}
            onGrantsChange={(grants) => dispatch({ type: "grants/set", grants })}
            onRun={startRun}
            readOnly={readOnly}
            personas={
              <Lockable locked={readOnly}>
                <PersonasPanel
                  mode={scenario.mode}
                  personas={scenario.personas}
                  claimsDrafts={state.claimsDrafts}
                  claimsTextOf={(personaId) => claimsTextOf(state, personaId)}
                  issues={validation.issues}
                  onAdd={() => dispatch({ type: "persona/add", sub: crypto.randomUUID() })}
                  onRemove={(personaId) => dispatch({ type: "persona/remove", personaId })}
                  onUpdate={(personaId, patch) =>
                    dispatch({ type: "persona/update", personaId, patch })
                  }
                  onClaimsText={(personaId, text) =>
                    dispatch({ type: "persona/claims-text", personaId, text })
                  }
                  onNewSub={(personaId) =>
                    dispatch({ type: "persona/new-sub", personaId, sub: crypto.randomUUID() })
                  }
                />
              </Lockable>
            }
            expectations={
              <TablesPanel
                view={tablesView}
                busy={busy}
                stale={isCatalogStale(state)}
                canIntrospect={runnable}
                readOnly={readOnly}
                onIntrospect={startIntrospect}
                onSetColumn={(effective, field, column) =>
                  dispatch({ type: "table/set-column", effective, field, column })
                }
                onResetTable={(table) => dispatch({ type: "table/reset", table })}
                onSetExpectation={(cell, choice, expectedRowsSql) =>
                  dispatch({ type: "expectation/set", cell, choice, expectedRowsSql })
                }
              />
            }
          />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <h2 className="sr-only">Results</h2>
          <VerdictBanner run={run} result={result} timings={state.timings} stale={resultStale} />
          {state.setupError === null ? null : (
            <SetupErrorPanel
              error={state.setupError}
              onShowInEditor={() => {
                const kind = state.setupError?.editor;
                if (kind !== null && kind !== undefined) {
                  dispatch({ type: "tab/show", tab: kind });
                  document
                    .querySelector(`[data-testid="sql-editor-${kind}"]`)
                    ?.scrollIntoView({ block: "center" });
                }
              }}
            />
          )}
          {matrixView === null ? null : (
            <>
              <div
                role="group"
                aria-label="Filter cells by status"
                className="flex flex-wrap items-center gap-1.5"
              >
                {chips.map(({ status, count }) => {
                  const Icon = STATUS_ICONS[status];
                  const pressed = state.statusFilter.includes(status);
                  return (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={pressed}
                      data-testid="status-chip"
                      data-status={status}
                      data-count={count}
                      onClick={() => dispatch({ type: "filter/toggle", status })}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium",
                        STATUS_CLASSES[status],
                        pressed && "ring-2 ring-ring",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5" />
                      {statusMeta(status).label}
                      <span className="font-mono">{count}</span>
                    </button>
                  );
                })}
                {state.statusFilter.length === 0 ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="status-chip-clear"
                    onClick={() => dispatch({ type: "filter/clear" })}
                  >
                    Show all
                  </Button>
                )}
              </div>
              <ResultMatrix
                view={matrixView}
                selectedCellId={state.selectedCellId}
                highlightedTable={state.highlightedTable}
                onOpenCell={(cellId) => dispatch({ type: "cell/select", cellId })}
              />
              <details className="rounded-lg border bg-card p-3 text-sm">
                <summary className="cursor-pointer rounded font-medium">
                  What the statuses mean
                </summary>
                <dl className="mt-2 grid gap-x-3 gap-y-1.5 sm:grid-cols-[auto_1fr]">
                  {STATUS_META.map((meta) => {
                    const Icon = STATUS_ICONS[meta.status];
                    return (
                      <div key={meta.status} className="contents">
                        <dt className="inline-flex items-center gap-1 font-medium">
                          <Icon aria-hidden="true" className="size-4" />
                          {meta.label}
                        </dt>
                        <dd className="text-muted-foreground">{meta.meaning}</dd>
                      </div>
                    );
                  })}
                </dl>
              </details>
            </>
          )}
          <FindingsList
            findings={state.findings}
            stale={isCatalogStale(state)}
            highlightedTable={state.highlightedTable}
            onHighlight={(table) => dispatch({ type: "table/highlight", table })}
          />
        </div>
      </div>

      <CellDrawer
        cell={selectedCell}
        persona={selectedPersona}
        onClose={() => dispatch({ type: "cell/select", cellId: null })}
        footer={
          selectedCell === null
            ? null
            : cellDrawerExtensions.map((Extension, index) => (
                <Extension
                  key={`${Extension.displayName ?? Extension.name}-${index}`}
                  {...slotProps}
                  cell={selectedCell}
                />
              ))
        }
      />

      <Dialog
        open={pendingLoad !== null}
        onOpenChange={(open) => (open ? undefined : setPendingLoad(null))}
      >
        <DialogContent data-testid="discard-dialog">
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              The scenario has changes that are not saved. Opening another one replaces them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              data-testid="discard-cancel"
              onClick={() => setPendingLoad(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="discard-confirm"
              onClick={() => {
                pendingLoad?.();
                setPendingLoad(null);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
