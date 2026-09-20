/**
 * The lab's state and its reducer. Pure: the component dispatches, effects (the worker, the
 * store, the clock) stay in `src/components/lab`.
 *
 * The run is a small state machine:
 *
 *   idle -> setting-up -> running n/total -> done | failed | cancelled
 *
 * `setting-up` also covers an explicit Introspect, which ends in `done` (a result exists) or
 * back in `idle`. A result stays on screen while the scenario is edited; `isResultStale` says
 * that it no longer describes what is in the editors.
 */
import type { Finding } from "@/lib/checks";
import type { CellStatus, MatrixResult, MatrixRun, MatrixTimings } from "@/lib/runner";
import type { Catalog } from "@/lib/runner/introspect";
import {
  serializeScenario,
  type Mode,
  type Scenario,
  type SupabaseGrants,
  type TableConfig,
  type TableRef,
} from "@/lib/scenario";
import type { TemplateVariantKind } from "@/lib/scenario/templates";
import { formatClaims, parseClaimsText } from "./claims-text";
import type { LabFailureReason, LabIntrospectOutcome, LabRunOutcome } from "./run-lab";
import {
  addPersona,
  removePersona,
  resetTableConfig,
  setExpectation,
  setTableColumn,
  updatePersona,
  withGrants,
  withMode,
  withSql,
  withTitle,
  type CellRef,
  type PersonaPatch,
  type ScopeChoice,
  type SqlKind,
  type TableColumnField,
} from "./scenario-edit";
import type { SetupErrorView } from "./setup-error-view";

export type ScenarioOrigin =
  | {
      readonly kind: "template";
      readonly templateId: string;
      readonly variant: TemplateVariantKind;
    }
  | { readonly kind: "blank" }
  | { readonly kind: "saved"; readonly storeId: string }
  | { readonly kind: "imported" };

export type RunPurpose = "run" | "introspect";

/** The tabs of the scenario panel: the two SQL editors, the personas, the expectations. */
export const LAB_TABS = ["schema", "seed", "personas", "expectations"] as const;
export type LabTab = (typeof LAB_TABS)[number];

export type RunState =
  | { readonly status: "idle" }
  | { readonly status: "setting-up"; readonly purpose: RunPurpose }
  | { readonly status: "running"; readonly done: number; readonly total: number }
  | { readonly status: "done" }
  | {
      readonly status: "failed";
      readonly reason: LabFailureReason | "setup";
      readonly message: string;
    }
  | { readonly status: "cancelled" };

export interface ClaimsDraft {
  readonly text: string;
  /** `null` while the text is valid claims JSON. */
  readonly error: string | null;
}

export interface LabState {
  readonly scenario: Scenario;
  readonly origin: ScenarioOrigin;
  /** `serializeScenario` of what was loaded or last saved; dirty means the text differs. */
  readonly baseline: string;
  /** Grows with every load: editors remount on it instead of diffing 200 KB of SQL. */
  readonly loadCount: number;
  /** Grows with every edit of the scenario. */
  readonly revision: number;
  /** Claims JSON as typed, per persona id, while it differs from the stored claims. */
  readonly claimsDrafts: Readonly<Record<string, ClaimsDraft>>;
  readonly run: RunState;
  /**
   * `revision` when the current or last run started. Recorded by the reducer, so an edit that is
   * dispatched right before `run/start` (the editors flush their text) belongs to the run.
   */
  readonly runRevision: number;
  readonly result: MatrixResult | null;
  readonly timings: MatrixTimings | null;
  /** The whole last run (catalog, table configs, cell contexts): what the CI export reads. */
  readonly matrixRun: MatrixRun | null;
  /** From the last run or the last Introspect. */
  readonly catalog: Catalog | null;
  readonly findings: readonly Finding[] | null;
  /** `revision` at which `result` was produced. */
  readonly resultRevision: number | null;
  /** `revision` at which `catalog` and `findings` were produced. */
  readonly catalogRevision: number | null;
  readonly setupError: SetupErrorView | null;
  /** The tab on screen. A setup error switches to the editor that holds the statement. */
  readonly activeTab: LabTab;
  readonly selectedCellId: string | null;
  /** Empty means every status is shown. */
  readonly statusFilter: readonly CellStatus[];
  /** `schema.table` of the row group a finding points at. */
  readonly highlightedTable: string | null;
}

export type LabAction =
  | { readonly type: "scenario/load"; readonly scenario: Scenario; readonly origin: ScenarioOrigin }
  | { readonly type: "scenario/saved"; readonly scenario: Scenario; readonly storeId: string }
  | { readonly type: "title/set"; readonly title: string }
  | { readonly type: "sql/set"; readonly kind: SqlKind; readonly text: string }
  | { readonly type: "mode/set"; readonly mode: Mode }
  | { readonly type: "grants/set"; readonly grants: SupabaseGrants }
  | { readonly type: "persona/add"; readonly sub: string }
  | { readonly type: "persona/remove"; readonly personaId: string }
  | { readonly type: "persona/update"; readonly personaId: string; readonly patch: PersonaPatch }
  | { readonly type: "persona/claims-text"; readonly personaId: string; readonly text: string }
  | { readonly type: "persona/new-sub"; readonly personaId: string; readonly sub: string }
  | {
      readonly type: "table/set-column";
      readonly effective: TableConfig;
      readonly field: TableColumnField;
      readonly column: string | undefined;
    }
  | { readonly type: "table/reset"; readonly table: TableRef }
  | {
      readonly type: "expectation/set";
      readonly cell: CellRef;
      readonly choice: ScopeChoice;
      readonly expectedRowsSql?: string | undefined;
    }
  | { readonly type: "run/start"; readonly purpose: RunPurpose }
  | { readonly type: "run/progress"; readonly done: number; readonly total: number }
  | { readonly type: "run/finished"; readonly outcome: LabRunOutcome }
  | { readonly type: "introspect/finished"; readonly outcome: LabIntrospectOutcome }
  | { readonly type: "tab/show"; readonly tab: LabTab }
  | { readonly type: "cell/select"; readonly cellId: string | null }
  | { readonly type: "filter/toggle"; readonly status: CellStatus }
  | { readonly type: "filter/clear" }
  | { readonly type: "table/highlight"; readonly table: string | null };

export function initialLabState(scenario: Scenario, origin: ScenarioOrigin): LabState {
  return {
    scenario,
    origin,
    baseline: serializeScenario(scenario),
    loadCount: 0,
    revision: 0,
    claimsDrafts: {},
    run: { status: "idle" },
    runRevision: 0,
    result: null,
    timings: null,
    matrixRun: null,
    catalog: null,
    findings: null,
    resultRevision: null,
    catalogRevision: null,
    setupError: null,
    activeTab: "schema",
    selectedCellId: null,
    statusFilter: [],
    highlightedTable: null,
  };
}

export function isBusy(run: RunState): boolean {
  return run.status === "setting-up" || run.status === "running";
}

export function isDirty(state: Pick<LabState, "scenario" | "baseline">): boolean {
  return serializeScenario(state.scenario) !== state.baseline;
}

export function isResultStale(
  state: Pick<LabState, "result" | "revision" | "resultRevision">,
): boolean {
  return state.result !== null && state.resultRevision !== state.revision;
}

export function isCatalogStale(
  state: Pick<LabState, "catalog" | "revision" | "catalogRevision">,
): boolean {
  return state.catalog !== null && state.catalogRevision !== state.revision;
}

export function hasClaimsErrors(state: Pick<LabState, "claimsDrafts">): boolean {
  return Object.values(state.claimsDrafts).some((draft) => draft.error !== null);
}

/** The text of a persona's claims editor: the draft while there is one, else the stored claims. */
export function claimsTextOf(
  state: Pick<LabState, "claimsDrafts" | "scenario">,
  id: string,
): string {
  const draft = state.claimsDrafts[id];
  if (draft !== undefined) {
    return draft.text;
  }
  const persona = state.scenario.personas.find((candidate) => candidate.id === id);
  return persona === undefined ? "" : formatClaims(persona.claims);
}

function edited(state: LabState, scenario: Scenario): LabState {
  return scenario === state.scenario ? state : { ...state, scenario, revision: state.revision + 1 };
}

function withoutDraft(
  drafts: Readonly<Record<string, ClaimsDraft>>,
  personaId: string,
): Readonly<Record<string, ClaimsDraft>> {
  return Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== personaId));
}

function claimsTextChanged(state: LabState, personaId: string, text: string): LabState {
  const parsed = parseClaimsText(text);
  if (!parsed.ok) {
    return {
      ...state,
      claimsDrafts: { ...state.claimsDrafts, [personaId]: { text, error: parsed.message } },
    };
  }
  const next = edited(state, updatePersona(state.scenario, personaId, { claims: parsed.claims }));
  return { ...next, claimsDrafts: { ...state.claimsDrafts, [personaId]: { text, error: null } } };
}

function runFinished(state: LabState, outcome: LabRunOutcome): LabState {
  const revision = state.runRevision;
  switch (outcome.kind) {
    case "done":
      return {
        ...state,
        run: { status: "done" },
        result: outcome.run.result,
        timings: outcome.run.timings,
        matrixRun: outcome.run,
        catalog: outcome.run.catalog,
        findings: outcome.findings,
        resultRevision: revision,
        catalogRevision: revision,
        setupError: null,
        selectedCellId: null,
      };
    case "setup-error":
      return {
        ...state,
        run: { status: "failed", reason: "setup", message: outcome.error.message },
        result: null,
        timings: null,
        matrixRun: null,
        resultRevision: null,
        setupError: outcome.error,
        activeTab: outcome.error.editor ?? state.activeTab,
        selectedCellId: null,
      };
    case "cancelled":
      return { ...state, run: { status: "cancelled" } };
    case "failed":
      return {
        ...state,
        run: { status: "failed", reason: outcome.reason, message: outcome.message },
        result: null,
        timings: null,
        matrixRun: null,
        resultRevision: null,
        selectedCellId: null,
      };
  }
}

function introspectFinished(state: LabState, outcome: LabIntrospectOutcome): LabState {
  const revision = state.runRevision;
  const rest: RunState = state.result === null ? { status: "idle" } : { status: "done" };
  switch (outcome.kind) {
    case "done":
      return {
        ...state,
        run: rest,
        catalog: outcome.catalog,
        findings: outcome.findings,
        catalogRevision: revision,
        setupError: null,
      };
    case "setup-error":
      return {
        ...state,
        run: { status: "failed", reason: "setup", message: outcome.error.message },
        setupError: outcome.error,
        activeTab: outcome.error.editor ?? state.activeTab,
      };
    case "cancelled":
      return { ...state, run: rest };
    case "failed":
      return {
        ...state,
        run: { status: "failed", reason: outcome.reason, message: outcome.message },
      };
  }
}

function toggled(filter: readonly CellStatus[], status: CellStatus): readonly CellStatus[] {
  return filter.includes(status) ? filter.filter((entry) => entry !== status) : [...filter, status];
}

export function labReducer(state: LabState, action: LabAction): LabState {
  switch (action.type) {
    case "scenario/load":
      return {
        ...initialLabState(action.scenario, action.origin),
        loadCount: state.loadCount + 1,
        revision: state.revision + 1,
      };
    case "scenario/saved":
      return {
        ...state,
        scenario: action.scenario,
        origin: { kind: "saved", storeId: action.storeId },
        baseline: serializeScenario(action.scenario),
      };
    case "title/set":
      // No new revision: the title is no input of a run, so it makes no result stale.
      return { ...state, scenario: withTitle(state.scenario, action.title) };
    case "sql/set":
      return edited(state, withSql(state.scenario, action.kind, action.text));
    case "mode/set":
      return edited(state, withMode(state.scenario, action.mode));
    case "grants/set":
      return edited(state, withGrants(state.scenario, action.grants));
    case "persona/add":
      return edited(state, addPersona(state.scenario, action.sub));
    case "persona/remove":
      return {
        ...edited(state, removePersona(state.scenario, action.personaId)),
        claimsDrafts: withoutDraft(state.claimsDrafts, action.personaId),
      };
    case "persona/update":
      return edited(state, updatePersona(state.scenario, action.personaId, action.patch));
    case "persona/claims-text":
      return claimsTextChanged(state, action.personaId, action.text);
    case "persona/new-sub": {
      const persona = state.scenario.personas.find((entry) => entry.id === action.personaId);
      if (persona === undefined) {
        return state;
      }
      const claims = { ...persona.claims, sub: action.sub };
      return {
        ...edited(state, updatePersona(state.scenario, action.personaId, { claims })),
        claimsDrafts: withoutDraft(state.claimsDrafts, action.personaId),
      };
    }
    case "table/set-column":
      return edited(
        state,
        setTableColumn(state.scenario, action.effective, action.field, action.column),
      );
    case "table/reset":
      return edited(state, resetTableConfig(state.scenario, action.table));
    case "expectation/set":
      return edited(
        state,
        setExpectation(state.scenario, action.cell, action.choice, action.expectedRowsSql),
      );
    case "run/start":
      return isBusy(state.run)
        ? state
        : {
            ...state,
            run: { status: "setting-up", purpose: action.purpose },
            runRevision: state.revision,
          };
    case "run/progress":
      return isBusy(state.run)
        ? { ...state, run: { status: "running", done: action.done, total: action.total } }
        : state;
    // An outcome that arrives after a load (which resets the run) belongs to another scenario.
    case "run/finished":
      return isBusy(state.run) ? runFinished(state, action.outcome) : state;
    case "introspect/finished":
      return isBusy(state.run) ? introspectFinished(state, action.outcome) : state;
    case "tab/show":
      return { ...state, activeTab: action.tab };
    case "cell/select":
      return { ...state, selectedCellId: action.cellId };
    case "filter/toggle":
      return { ...state, statusFilter: toggled(state.statusFilter, action.status) };
    case "filter/clear":
      return { ...state, statusFilter: [] };
    case "table/highlight":
      return { ...state, highlightedTable: action.table };
  }
}
