import { beforeAll, describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import { MULTI_TENANT_SAAS } from "@/lib/scenario/templates";
import { introspectLab, runLab, type LabIntrospectOutcome, type LabRunOutcome } from "./run-lab";
import { blankScenario, scenarioFromTemplate } from "./scenario-edit";
import type { SetupErrorView } from "./setup-error-view";
import {
  claimsTextOf,
  hasClaimsErrors,
  initialLabState,
  isBusy,
  isCatalogStale,
  isDirty,
  isResultStale,
  labReducer,
  type LabAction,
  type LabState,
} from "./state";

const PORTS = {
  createEngine: async () => {
    const engine = await createPgliteEngine();
    return { engine, terminate: () => void engine.close().catch(() => undefined) };
  },
  supabase: SUPABASE_SETUP_SQL,
};

let done: LabRunOutcome;
let introspected: LabIntrospectOutcome;

beforeAll(async () => {
  const scenario = scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky");
  done = await runLab(scenario, PORTS);
  introspected = await introspectLab(scenario, PORTS);
});

const SETUP_ERROR: SetupErrorView = {
  phase: "schema",
  editor: "schema",
  sqlState: "42601",
  message: "syntax error",
  detail: null,
  hint: null,
  statement: "create table (",
  statementLine: 1,
  errorLine: 1,
  timedOut: false,
};

function start(): LabState {
  return initialLabState(scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky"), {
    kind: "template",
    templateId: "multi-tenant-saas",
    variant: "leaky",
  });
}

function reduce(state: LabState, ...actions: LabAction[]): LabState {
  return actions.reduce(labReducer, state);
}

describe("editing and dirty tracking", () => {
  it("starts clean and becomes dirty with an edit, clean again when the edit is undone", () => {
    const state = start();
    expect(isDirty(state)).toBe(false);
    const original = state.scenario.schemaSql;
    const edited = reduce(state, { type: "sql/set", kind: "schema", text: "select 1;" });
    expect(isDirty(edited)).toBe(true);
    expect(edited.revision).toBe(1);
    const undone = reduce(edited, { type: "sql/set", kind: "schema", text: original });
    expect(isDirty(undone)).toBe(false);
  });

  it("applies every scenario action", () => {
    const state = reduce(
      initialLabState(blankScenario("b"), { kind: "blank" }),
      { type: "title/set", title: "Mine" },
      { type: "sql/set", kind: "seed", text: "select 2;" },
      { type: "mode/set", mode: "postgres" },
      { type: "grants/set", grants: "explicit" },
      { type: "persona/add", sub: "00000000-0000-4000-8000-0000000000aa" },
      { type: "persona/update", personaId: "user-4", patch: { label: "Dora" } },
      { type: "persona/remove", personaId: "user-b" },
      {
        type: "table/set-column",
        effective: { schema: "public", name: "notes" },
        field: "ownerColumn",
        column: "user_id",
      },
      {
        type: "expectation/set",
        cell: { personaId: "user-a", schema: "public", table: "notes", operation: "select" },
        choice: "own",
      },
    );
    expect(state.scenario).toMatchObject({
      title: "Mine",
      seedSql: "select 2;",
      mode: "postgres",
      options: { supabaseGrants: "explicit" },
      tables: [{ schema: "public", name: "notes", ownerColumn: "user_id" }],
      expectations: [{ personaId: "user-a", scope: "own" }],
    });
    expect(state.scenario.personas.map((persona) => persona.label)).toEqual([
      "Anonymous visitor",
      "User A",
      "Dora",
    ]);
    // The title is no input of a run.
    expect(state.revision).toBe(8);
    const reset = reduce(state, {
      type: "table/reset",
      table: { schema: "public", name: "notes" },
    });
    expect(reset.scenario.tables).toEqual([]);
  });

  it("keeps an invalid claims draft beside the last valid claims, and blocks on it", () => {
    const state = start();
    const before = state.scenario.personas[1]?.claims;
    const broken = reduce(state, { type: "persona/claims-text", personaId: "alice", text: "{" });
    expect(hasClaimsErrors(broken)).toBe(true);
    expect(claimsTextOf(broken, "alice")).toBe("{");
    expect(broken.scenario.personas[1]?.claims).toEqual(before);
    expect(broken.revision).toBe(0);

    const fixedText = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","plan":"pro"}';
    const fixed = reduce(broken, {
      type: "persona/claims-text",
      personaId: "alice",
      text: fixedText,
    });
    expect(hasClaimsErrors(fixed)).toBe(false);
    expect(fixed.scenario.personas[1]?.claims).toMatchObject({ plan: "pro" });
    expect(claimsTextOf(fixed, "alice")).toBe(fixedText);
    expect(claimsTextOf(state, "alice")).toContain('"sub"');
    expect(claimsTextOf(state, "nobody")).toBe("");
  });

  it("sets a new sub and drops the draft; removing a persona drops its draft too", () => {
    const drafted = reduce(start(), { type: "persona/claims-text", personaId: "alice", text: "{" });
    const withSub = reduce(drafted, {
      type: "persona/new-sub",
      personaId: "alice",
      sub: "99999999-0000-4000-8000-000000000009",
    });
    expect(hasClaimsErrors(withSub)).toBe(false);
    expect(withSub.scenario.personas[1]?.claims).toMatchObject({
      sub: "99999999-0000-4000-8000-000000000009",
      app_metadata: expect.anything(),
    });
    expect(reduce(drafted, { type: "persona/new-sub", personaId: "nobody", sub: "x" })).toBe(
      drafted,
    );
    const removed = reduce(drafted, { type: "persona/remove", personaId: "alice" });
    expect(hasClaimsErrors(removed)).toBe(false);
  });
});

describe("the run state machine", () => {
  it("goes idle, setting up, running, done and keeps the whole run", () => {
    const state = start();
    expect(state.run).toEqual({ status: "idle" });
    const setting = reduce(state, { type: "run/start", purpose: "run" });
    expect(setting.run).toEqual({ status: "setting-up", purpose: "run" });
    expect(isBusy(setting.run)).toBe(true);
    const running = reduce(setting, { type: "run/progress", done: 3, total: 60 });
    expect(running.run).toEqual({ status: "running", done: 3, total: 60 });
    const finished = reduce(running, { type: "run/finished", outcome: done });
    expect(finished.run).toEqual({ status: "done" });
    expect(finished.result?.verdict).toBe("LEAKING");
    expect(finished.matrixRun?.cellContexts.length).toBeGreaterThan(0);
    expect(finished.timings?.rebuilds).toBe(0);
    expect(finished.catalog?.tables).toHaveLength(3);
    expect(finished.findings).toHaveLength(2);
    expect(isResultStale(finished)).toBe(false);
    expect(isCatalogStale(finished)).toBe(false);
  });

  it("ignores a second start, progress without a run and an outcome after a load", () => {
    const setting = reduce(start(), { type: "run/start", purpose: "run" });
    expect(reduce(setting, { type: "run/start", purpose: "introspect" })).toBe(setting);
    const idle = start();
    expect(reduce(idle, { type: "run/progress", done: 1, total: 2 })).toBe(idle);
    const loaded = reduce(setting, {
      type: "scenario/load",
      scenario: blankScenario("b"),
      origin: { kind: "blank" },
    });
    expect(loaded.run).toEqual({ status: "idle" });
    expect(reduce(loaded, { type: "run/finished", outcome: done })).toBe(loaded);
    expect(reduce(loaded, { type: "introspect/finished", outcome: introspected })).toBe(loaded);
  });

  it("marks the result stale after an edit, but not after a title change", () => {
    const finished = reduce(
      start(),
      { type: "run/start", purpose: "run" },
      { type: "run/finished", outcome: done },
    );
    expect(isResultStale(reduce(finished, { type: "title/set", title: "Other" }))).toBe(false);
    const edited = reduce(finished, { type: "sql/set", kind: "seed", text: "select 1;" });
    expect(isResultStale(edited)).toBe(true);
    expect(isCatalogStale(edited)).toBe(true);
    expect(isResultStale(start())).toBe(false);
    expect(isCatalogStale(start())).toBe(false);
  });

  it("dates a result by the revision at which its run started", () => {
    // The editors flush their text right before run/start: that edit belongs to the run.
    const flushed = reduce(
      start(),
      { type: "sql/set", kind: "seed", text: "select 1;" },
      { type: "run/start", purpose: "run" },
      { type: "run/finished", outcome: done },
    );
    expect(isResultStale(flushed)).toBe(false);
    // An edit while the run is in flight does not.
    const editedMeanwhile = reduce(
      start(),
      { type: "run/start", purpose: "run" },
      { type: "sql/set", kind: "seed", text: "select 1;" },
      { type: "run/finished", outcome: done },
    );
    expect(isResultStale(editedMeanwhile)).toBe(true);
  });

  it("shows a setup error and clears the old result", () => {
    const finished = reduce(
      start(),
      { type: "run/start", purpose: "run" },
      { type: "run/finished", outcome: done },
      { type: "cell/select", cellId: "alice|public.projects|update" },
      { type: "run/start", purpose: "run" },
      {
        type: "run/finished",
        outcome: { kind: "setup-error", error: SETUP_ERROR },
      },
    );
    expect(finished.run).toEqual({ status: "failed", reason: "setup", message: "syntax error" });
    expect(finished.setupError).toEqual(SETUP_ERROR);
    expect(finished.activeTab).toBe("schema");
    expect(finished.result).toBeNull();
    expect(finished.matrixRun).toBeNull();
    expect(finished.selectedCellId).toBeNull();
    // The next good run clears the error again.
    const again = reduce(
      finished,
      { type: "run/start", purpose: "run" },
      { type: "run/finished", outcome: done },
    );
    expect(again.setupError).toBeNull();
  });

  it("handles a cancelled and a failed run", () => {
    const withResult = reduce(
      start(),
      { type: "run/start", purpose: "run" },
      { type: "run/finished", outcome: done },
    );
    const cancelled = reduce(
      withResult,
      { type: "run/start", purpose: "run" },
      { type: "run/finished", outcome: { kind: "cancelled" } },
    );
    expect(cancelled.run).toEqual({ status: "cancelled" });
    expect(cancelled.result).not.toBeNull();
    const failed = reduce(
      withResult,
      { type: "run/start", purpose: "run" },
      {
        type: "run/finished",
        outcome: { kind: "failed", reason: "ceiling", message: "too long" },
      },
    );
    expect(failed.run).toEqual({ status: "failed", reason: "ceiling", message: "too long" });
    expect(failed.result).toBeNull();
  });

  it("introspects: catalog and findings, back to idle or done", () => {
    const fresh = reduce(
      start(),
      { type: "run/start", purpose: "introspect" },
      { type: "introspect/finished", outcome: introspected },
    );
    expect(fresh.run).toEqual({ status: "idle" });
    expect(fresh.catalog?.tables).toHaveLength(3);
    expect(fresh.findings).toHaveLength(2);
    expect(fresh.result).toBeNull();

    const afterRun = reduce(
      start(),
      { type: "run/start", purpose: "run" },
      { type: "run/finished", outcome: done },
      { type: "run/start", purpose: "introspect" },
      { type: "introspect/finished", outcome: { kind: "cancelled" } },
    );
    expect(afterRun.run).toEqual({ status: "done" });

    const broken = reduce(
      start(),
      { type: "run/start", purpose: "introspect" },
      {
        type: "introspect/finished",
        outcome: { kind: "setup-error", error: SETUP_ERROR },
      },
    );
    expect(broken.run).toMatchObject({ status: "failed", reason: "setup" });
    expect(broken.setupError).toEqual(SETUP_ERROR);

    // An error in the seed brings the seed editor to the front; the product's own SQL moves nothing.
    const inSeed = reduce(
      start(),
      { type: "run/start", purpose: "introspect" },
      {
        type: "introspect/finished",
        outcome: { kind: "setup-error", error: { ...SETUP_ERROR, phase: "seed", editor: "seed" } },
      },
    );
    expect(inSeed.activeTab).toBe("seed");
    const inShim = reduce(
      inSeed,
      { type: "run/start", purpose: "run" },
      {
        type: "run/finished",
        outcome: { kind: "setup-error", error: { ...SETUP_ERROR, phase: "shim", editor: null } },
      },
    );
    expect(inShim.activeTab).toBe("seed");
    expect(reduce(inShim, { type: "tab/show", tab: "personas" }).activeTab).toBe("personas");

    const failed = reduce(
      start(),
      { type: "run/start", purpose: "introspect" },
      {
        type: "introspect/finished",
        outcome: { kind: "failed", reason: "engine", message: "no wasm" },
      },
    );
    expect(failed.run).toEqual({ status: "failed", reason: "engine", message: "no wasm" });
  });
});

describe("loading, saving, selection and filters", () => {
  it("resets everything on load but keeps counting loads and revisions", () => {
    const busy = reduce(
      start(),
      { type: "sql/set", kind: "seed", text: "select 1;" },
      { type: "filter/toggle", status: "leak" },
      { type: "cell/select", cellId: "x" },
    );
    const loaded = reduce(busy, {
      type: "scenario/load",
      scenario: blankScenario("b"),
      origin: { kind: "blank" },
    });
    expect(loaded).toMatchObject({
      origin: { kind: "blank" },
      loadCount: 1,
      revision: 2,
      statusFilter: [],
      selectedCellId: null,
      result: null,
    });
    expect(isDirty(loaded)).toBe(false);
  });

  it("is clean after a save and remembers where it was saved", () => {
    const edited = reduce(start(), { type: "sql/set", kind: "seed", text: "select 1;" });
    const renamed = { ...edited.scenario, id: "copy-1", title: "Copy" };
    const saved = reduce(edited, { type: "scenario/saved", scenario: renamed, storeId: "s1" });
    expect(isDirty(saved)).toBe(false);
    expect(saved.origin).toEqual({ kind: "saved", storeId: "s1" });
    expect(saved.scenario.title).toBe("Copy");
    expect(saved.revision).toBe(edited.revision);
  });

  it("toggles filters, selects cells and highlights a table", () => {
    const state = reduce(
      start(),
      { type: "filter/toggle", status: "leak" },
      { type: "filter/toggle", status: "escape" },
      { type: "filter/toggle", status: "leak" },
      { type: "cell/select", cellId: "alice|public.projects|update" },
      { type: "table/highlight", table: "public.projects" },
    );
    expect(state.statusFilter).toEqual(["escape"]);
    expect(state.selectedCellId).toBe("alice|public.projects|update");
    expect(state.highlightedTable).toBe("public.projects");
    const cleared = reduce(
      state,
      { type: "filter/clear" },
      { type: "cell/select", cellId: null },
      { type: "table/highlight", table: null },
    );
    expect(cleared).toMatchObject({
      statusFilter: [],
      selectedCellId: null,
      highlightedTable: null,
    });
  });
});
