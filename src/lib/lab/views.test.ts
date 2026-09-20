/**
 * The view models over a REAL result: the leaky multi-tenant template, run once against PGlite.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createPgliteEngine } from "@/lib/engine/pglite-engine";
import { SUPABASE_SETUP_SQL } from "@/lib/engine/supabase-setup-sql";
import type { Finding } from "@/lib/checks";
import { toProbeFailure, type CellResult, type MatrixResult, type MatrixRun } from "@/lib/runner";
import { EngineTimeoutError } from "@/lib/runner/types";
import { statusMeta } from "@/lib/site/status";
import { SetupError } from "@/lib/runner/setup";
import { MULTI_TENANT_SAAS } from "@/lib/scenario/templates";
import {
  KEY_LIST_CAP,
  buildCellKeyLists,
  buildKeyList,
  buildSubProbeViews,
  cellStatusView,
  cellTimeout,
  cellTranscript,
  formatKey,
} from "./cell-view";
import { firstCell, isGridKey, moveInGrid, positionOf, cellAt, type GridCells } from "./grid-nav";
import { buildMatrixView, findingTableKey, statusChips, tableKey } from "./matrix-view";
import { runLab } from "./run-lab";
import {
  blankScenario,
  scenarioFromTemplate,
  setExpectation,
  setTableColumn,
} from "./scenario-edit";
import { locateTimedOutStatement, toSetupErrorView } from "./setup-error-view";
import { buildTablesView } from "./tables-view";
import { buildVerdictView, countPhrase, runStatusText, verdictAnnouncement } from "./verdict-view";

let run: MatrixRun;
let result: MatrixResult;
let findings: readonly Finding[];

beforeAll(async () => {
  const outcome = await runLab(scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky"), {
    createEngine: async () => {
      const engine = await createPgliteEngine();
      return { engine, terminate: () => void engine.close().catch(() => undefined) };
    },
    supabase: SUPABASE_SETUP_SQL,
  });
  if (outcome.kind !== "done") {
    throw new Error(`The fixture run did not finish: ${outcome.kind}`);
  }
  run = outcome.run;
  result = outcome.run.result;
  findings = outcome.findings;
});

function cell(id: string): CellResult {
  const found = result.cells.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`No cell ${id}`);
  }
  return found;
}

describe("a cell whose probe timed out", () => {
  const timeout = toProbeFailure(new EngineTimeoutError(5000));

  /** What the runner records when the reach probe never came back: nothing reached, all "missing". */
  function reachTimedOut(): CellResult {
    const source = cell("alice|public.projects|select");
    return {
      ...source,
      status: "inconclusive",
      reason: timeout.message,
      actualKeys: [],
      leakedKeys: [],
      missingKeys: source.expectedKeys,
      error: timeout,
      subProbes: [],
    };
  }

  function subProbeTimedOut(): CellResult {
    const source = cell("alice|public.projects|update");
    const [first, ...rest] = source.subProbes;
    if (first === undefined) throw new Error("The fixture cell has no sub-probe");
    return {
      ...source,
      status: "inconclusive",
      reason: timeout.message,
      subProbes: [
        { ...first, status: "inconclusive", outcome: "inconclusive", error: timeout },
        ...rest,
      ],
    };
  }

  it("is told apart from every other inconclusive cell", () => {
    expect(cellTimeout(reachTimedOut())).toBe("reach");
    expect(cellTimeout(subProbeTimedOut())).toBe("sub-probe");
    expect(cellTimeout(cell("alice|public.projects|select"))).toBeNull();
    expect(
      cellTimeout({ ...reachTimedOut(), error: { sqlState: "23505", message: "duplicate key" } }),
    ).toBeNull();
    // Only an inconclusive cell: a leak that was measured stays a leak.
    expect(cellTimeout({ ...subProbeTimedOut(), status: "leak" })).toBeNull();
  });

  it("has its own words for the grid, the drawer and a screen reader", () => {
    const view = cellStatusView(reachTimedOut());
    expect(view).toMatchObject({ status: "inconclusive", timedOut: true, label: "Timed out" });
    expect(view.meaning).toContain("Nothing was measured");
    expect(view.meaning).not.toBe(statusMeta("inconclusive").meaning);

    expect(cellStatusView(subProbeTimedOut())).toMatchObject({
      timedOut: true,
      label: "Timed out",
    });
    expect(cellStatusView(subProbeTimedOut()).meaning).toContain("sub-probe");
    expect(buildSubProbeViews(subProbeTimedOut()).map((probe) => probe.timedOut)).toEqual(
      subProbeTimedOut().subProbes.map((_probe, index) => index === 0),
    );

    const plain = cellStatusView(cell("alice|public.projects|select"));
    expect(plain).toEqual({
      status: "pass",
      timedOut: false,
      label: statusMeta("pass").label,
      meaning: statusMeta("pass").meaning,
    });
  });

  it("shows no missing rows in the grid when nothing was measured", () => {
    const timedOut = reachTimedOut();
    expect(timedOut.missingKeys.length).toBeGreaterThan(0);
    const view = buildMatrixView({
      ...result,
      cells: result.cells.map((entry) => (entry.id === timedOut.id ? timedOut : entry)),
    });
    const shown = view.tables
      .flatMap((table) => table.rows.flatMap((row) => row.cells))
      .find((entry) => entry?.id === timedOut.id);

    expect(shown).toMatchObject({
      status: "inconclusive",
      timedOut: true,
      label: "Timed out",
      leakedCount: 0,
      missingCount: 0,
    });
  });

  it("keeps the measured counts when only a sub-probe timed out", () => {
    const timedOut = { ...subProbeTimedOut(), leakedKeys: ['["1"]'] };
    const view = buildMatrixView({
      ...result,
      cells: result.cells.map((entry) => (entry.id === timedOut.id ? timedOut : entry)),
    });
    const shown = view.tables
      .flatMap((table) => table.rows.flatMap((row) => row.cells))
      .find((entry) => entry?.id === timedOut.id);

    expect(shown).toMatchObject({ timedOut: true, label: "Timed out", leakedCount: 1 });
  });
});

describe("buildMatrixView", () => {
  it("groups by table, one row per persona, four operation cells", () => {
    const view = buildMatrixView(result, [], findings);
    expect(view.operations).toEqual(["select", "insert", "update", "delete"]);
    expect(view.tables.map((table) => table.key)).toEqual([
      "public.invoices",
      "public.projects",
      "public.tenants",
    ]);
    expect(view.tables[1]?.rows.map((row) => row.personaId)).toEqual([
      "anon",
      "alice",
      "bob",
      "carol",
      "service",
    ]);
    expect(view.visibleRows).toBe(15);
    expect(view.cellIds).toHaveLength(15);
    expect(view.cellIds[5]).toEqual([
      "anon|public.projects|select",
      "anon|public.projects|insert",
      "anon|public.projects|update",
      "anon|public.projects|delete",
    ]);
    expect(view.totalCells).toBe(60);
    expect(view.tables[1]).toMatchObject({
      rlsEnabled: true,
      rowCount: 5,
      ownerColumn: "created_by",
      tenantColumn: "tenant_id",
      findingCount: 2,
    });
    expect(view.tables[0]?.findingCount).toBe(0);
    const service = view.tables[1]?.rows[4];
    expect(service).toMatchObject({ dbRole: "service_role", rlsBypass: "bypassrls" });
  });

  it("marks exactly the template's declared failures", () => {
    const view = buildMatrixView(result);
    const failing = view.tables.flatMap((table) =>
      table.rows.flatMap((row) =>
        row.cells.flatMap((entry) =>
          entry !== null && (entry.status === "escape" || entry.status === "leak")
            ? [`${entry.id}:${entry.status}`]
            : [],
        ),
      ),
    );
    expect(failing).toEqual([
      "alice|public.projects|update:escape",
      "bob|public.projects|update:escape",
      "carol|public.projects|update:escape",
    ]);
  });

  it("filters rows by status and dims the other cells of a kept row", () => {
    const view = buildMatrixView(result, ["escape"]);
    expect(view.tables.map((table) => table.key)).toEqual(["public.projects"]);
    expect(view.tables[0]?.rows.map((row) => row.personaId)).toEqual(["alice", "bob", "carol"]);
    expect(view.tables[0]?.rows[0]?.cells.map((entry) => entry?.matchesFilter)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(view.visibleRows).toBe(3);
    // The chips keep counting everything.
    expect(view.counts).toEqual(result.counts);
    expect(buildMatrixView(result, ["leak"]).tables).toEqual([]);
  });

  it("leaves a hole where the runner produced no cell and drops personas without cells", () => {
    const partial: MatrixResult = {
      ...result,
      cells: result.cells.filter(
        (entry) => entry.id !== "anon|public.invoices|insert" && entry.personaId !== "service",
      ),
    };
    const view = buildMatrixView(partial);
    expect(view.cellIds[0]).toEqual([
      "anon|public.invoices|select",
      null,
      "anon|public.invoices|update",
      "anon|public.invoices|delete",
    ]);
    expect(view.tables[0]?.rows.map((row) => row.personaId)).not.toContain("service");
  });

  it("offers a chip for every status that occurs, in the fixed order", () => {
    expect(statusChips(result.counts).map((chip) => chip.status)).toEqual(
      (["pass", "leak", "escape", "overblock", "inconclusive", "skipped"] as const).filter(
        (status) => result.counts[status] > 0,
      ),
    );
    expect(
      statusChips({ pass: 0, leak: 0, escape: 0, overblock: 0, inconclusive: 0, skipped: 0 }),
    ).toEqual([]);
  });

  it("finds the table of a finding", () => {
    expect(findings.map(findingTableKey)).toEqual(["public.projects", "public.projects"]);
    const base = findings[0];
    if (base === undefined) {
      throw new Error("no finding");
    }
    const onTable = { object: { ...base.object, kind: "table", name: "t" } } as const;
    expect(findingTableKey(onTable)).toBe(tableKey("public", "t"));
    expect(findingTableKey({ object: { ...base.object, kind: "function" } })).toBeNull();
    expect(findingTableKey({ object: { ...base.object, kind: "view" } })).toBeNull();
    expect(
      findingTableKey({
        object: { kind: "policy", schema: "public", name: "p", qualifiedName: "p" },
      }),
    ).toBeNull();
  });
});

describe("grid navigation", () => {
  const GRID: GridCells = [
    ["a1", "a2", "a3"],
    ["b1", null, "b3"],
    [null, null, null],
    ["d1", "d2", "d3"],
  ];

  it("moves by one cell and stays at the edges", () => {
    expect(moveInGrid(GRID, "a1", "ArrowRight")).toBe("a2");
    expect(moveInGrid(GRID, "a2", "ArrowLeft")).toBe("a1");
    expect(moveInGrid(GRID, "a1", "ArrowLeft")).toBe("a1");
    expect(moveInGrid(GRID, "a1", "ArrowUp")).toBe("a1");
    expect(moveInGrid(GRID, "a1", "ArrowDown")).toBe("b1");
    expect(moveInGrid(GRID, "d3", "ArrowDown")).toBe("d3");
    expect(moveInGrid(GRID, "d3", "ArrowRight")).toBe("d3");
  });

  it("steps over holes in the direction of travel", () => {
    expect(moveInGrid(GRID, "b1", "ArrowRight")).toBe("b3");
    expect(moveInGrid(GRID, "b3", "ArrowLeft")).toBe("b1");
    expect(moveInGrid(GRID, "b1", "ArrowDown")).toBe("d1");
    expect(moveInGrid(GRID, "d2", "ArrowUp")).toBe("a2");
  });

  it("supports Home, End and their Ctrl variants", () => {
    expect(moveInGrid(GRID, "a2", "Home")).toBe("a1");
    expect(moveInGrid(GRID, "a2", "End")).toBe("a3");
    expect(moveInGrid(GRID, "d2", "Home", true)).toBe("a1");
    expect(moveInGrid(GRID, "a2", "End", true)).toBe("d3");
  });

  it("pages by five rows and lands on a real cell", () => {
    const tall: GridCells = Array.from({ length: 12 }, (_, row) => [`r${row}`]);
    expect(moveInGrid(tall, "r0", "PageDown")).toBe("r5");
    expect(moveInGrid(tall, "r10", "PageDown")).toBe("r11");
    expect(moveInGrid(tall, "r7", "PageUp")).toBe("r2");
    expect(moveInGrid(tall, "r1", "PageUp")).toBe("r0");
    expect(moveInGrid(GRID, "a1", "PageDown")).toBe("d1");
  });

  it("falls back to the first cell for an unknown id, and knows positions", () => {
    expect(moveInGrid(GRID, "gone", "ArrowDown")).toBe("a1");
    expect(moveInGrid([], "gone", "ArrowDown")).toBe("gone");
    expect(firstCell(GRID)).toBe("a1");
    expect(firstCell([[null], [null, "x"]])).toBe("x");
    expect(firstCell([])).toBeNull();
    expect(positionOf(GRID, "b3")).toEqual({ row: 1, col: 2 });
    expect(positionOf(GRID, "zz")).toBeNull();
    expect(positionOf(GRID, null)).toBeNull();
    expect(cellAt(GRID, { row: 3, col: 1 })).toBe("d2");
    expect(cellAt(GRID, { row: 9, col: 9 })).toBeNull();
    expect(isGridKey("ArrowUp")).toBe(true);
    expect(isGridKey("Enter")).toBe(false);
  });
});

describe("buildVerdictView and runStatusText", () => {
  it("words a LEAKING result with counts by kind", () => {
    const view = buildVerdictView(result);
    expect(view.verdict).toBe("LEAKING");
    expect(view.deciding).toEqual([
      { status: "leak", count: 0, label: "0 leaks" },
      { status: "escape", count: 3, label: "3 escapes" },
    ]);
    expect(view.beside.map((entry) => entry.status)).toContain("pass");
    expect(view.announcement).toMatch(/^Verdict: LEAKING\. 3 escapes\. /);
    expect(view.announcement).toContain("60 cells in total.");
  });

  it("words ISOLATED and NOT PROVEN without failing kinds", () => {
    const isolated = buildVerdictView({
      ...result,
      verdict: "ISOLATED",
      counts: { pass: 1, leak: 0, escape: 0, overblock: 0, inconclusive: 0, skipped: 0 },
      totalCells: 1,
    });
    expect(isolated.announcement).toBe("Verdict: ISOLATED. 1 pass. 1 cell in total.");
    const unproven = buildVerdictView({
      ...result,
      verdict: "NOT PROVEN",
      counts: { pass: 0, leak: 0, escape: 0, overblock: 0, inconclusive: 0, skipped: 0 },
      totalCells: 0,
    });
    expect(unproven.announcement).toBe("Verdict: NOT PROVEN. 0 cells in total.");
    expect(unproven.beside).toEqual([]);
  });

  it("pluralises every status", () => {
    expect(countPhrase("pass", 2)).toBe("2 passes");
    expect(countPhrase("leak", 1)).toBe("1 leak");
    expect(countPhrase("overblock", 2)).toBe("2 overblocks");
    expect(countPhrase("inconclusive", 2)).toBe("2 inconclusive cells");
    expect(countPhrase("skipped", 1)).toBe("1 skipped cell");
  });

  it("describes every run state", () => {
    expect(runStatusText({ status: "idle" })).toBe("Not run yet.");
    expect(runStatusText({ status: "setting-up", purpose: "run" })).toContain("Setting up");
    expect(runStatusText({ status: "setting-up", purpose: "introspect" })).toContain(
      "Introspecting",
    );
    expect(runStatusText({ status: "running", done: 3, total: 60 })).toBe(
      "Running probes: 3 of 60 cells.",
    );
    expect(runStatusText({ status: "done" })).toBe("Run finished.");
    expect(runStatusText({ status: "cancelled" })).toContain("cancelled");
    expect(runStatusText({ status: "failed", reason: "setup", message: "x" })).toContain("setup");
    expect(runStatusText({ status: "failed", reason: "ceiling", message: "too long" })).toBe(
      "too long",
    );
  });

  it("announces the verdict of a finished run as it stands", () => {
    expect(verdictAnnouncement({ status: "done" }, result, false)).toBe(
      buildVerdictView(result).announcement,
    );
  });

  it("says that a cancelled run shows the result of the run before it", () => {
    const announcement = verdictAnnouncement({ status: "cancelled" }, result, false);
    expect(announcement).toBe(
      `Run cancelled. The result is from the run before it. ${buildVerdictView(result).announcement}`,
    );
    // Without an earlier result there is nothing to attribute: the plain status line.
    expect(verdictAnnouncement({ status: "cancelled" }, null, false)).toBe(
      "Run cancelled. Nothing was proven.",
    );
  });

  it("says that a stale result no longer describes the scenario", () => {
    expect(verdictAnnouncement({ status: "done" }, result, true)).toBe(
      `${buildVerdictView(result).announcement} The scenario changed after this run; run again.`,
    );
    const both = verdictAnnouncement({ status: "cancelled" }, result, true);
    expect(both).toMatch(
      /^Run cancelled\. The result is from the run before it\. Verdict: LEAKING\./,
    );
    expect(both).toMatch(/The scenario changed after this run; run again\.$/);
    // Staleness is a property of a result: without one it is not mentioned.
    expect(verdictAnnouncement({ status: "idle" }, null, true)).toBe("Not run yet.");
  });

  it("announces a run in progress or failed instead of an older result", () => {
    expect(verdictAnnouncement({ status: "setting-up", purpose: "run" }, result, true)).toBe(
      runStatusText({ status: "setting-up", purpose: "run" }),
    );
    // Progress is not announced cell by cell.
    expect(verdictAnnouncement({ status: "running", done: 3, total: 60 }, result, false)).toBe(
      "Running probes.",
    );
    expect(
      verdictAnnouncement(
        { status: "failed", reason: "ceiling", message: "too long" },
        result,
        true,
      ),
    ).toBe("too long");
  });
});

describe("cell details", () => {
  it("formats keys and caps long lists with a count", () => {
    expect(formatKey('["7"]')).toBe("7");
    expect(formatKey('["7","b"]')).toBe("7, b");
    expect(formatKey("not json")).toBe("not json");
    expect(formatKey("[1]")).toBe("[1]");
    const many = Array.from({ length: KEY_LIST_CAP + 50 }, (_, index) => `["${index}"]`);
    const list = buildKeyList(many);
    expect(list.total).toBe(KEY_LIST_CAP + 50);
    expect(list.shown).toHaveLength(KEY_LIST_CAP);
    expect(list.hidden).toBe(50);
    expect(list.copyText.split("\n")).toHaveLength(KEY_LIST_CAP + 50);
    expect(buildKeyList(['["1"]'], 5)).toEqual({
      total: 1,
      shown: ["1"],
      hidden: 0,
      copyText: "1",
    });
  });

  it("lists the keys of a real cell", () => {
    const lists = buildCellKeyLists(cell("alice|public.projects|select"));
    expect(lists.expected.total).toBe(3);
    expect(lists.actual.shown).toEqual(lists.expected.shown);
    expect(lists.leaked.total).toBe(0);
    expect(lists.missing.total).toBe(0);
    expect(lists.blind.total).toBe(0);
  });

  it("tells the sub-probes of the escaping cell apart", () => {
    const escaping = cell("alice|public.projects|update");
    const views = buildSubProbeViews(escaping);
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(new Set(views.map((view) => view.id)).size).toBe(views.length);
    const bulk = views.find(
      (view) => view.probe.kind === "escape-bulk" && view.probe.status === "escape",
    );
    expect(bulk?.title).toContain("without WHERE");
    expect(bulk?.distinction).toMatch(/^must be blocked, row /);
    expect(bulk?.movedKeys.total).toBeGreaterThan(0);
    expect(buildSubProbeViews({ subProbes: [] })).toEqual([]);
    const skipped = { ...views[0]?.probe, sourceKey: null } as (typeof views)[number]["probe"];
    expect(buildSubProbeViews({ subProbes: [skipped] })[0]?.distinction).toContain("no source row");
  });

  it("joins the scripts of a cell into one transcript", () => {
    const escaping = cell("alice|public.projects|update");
    const transcript = cellTranscript(escaping);
    expect(transcript).toContain(escaping.sql);
    for (const probe of escaping.subProbes.filter((entry) => entry.sql !== "")) {
      expect(transcript).toContain(probe.sql);
    }
    const insert = cell("anon|public.projects|insert");
    expect(insert.sql).toBe("");
    expect(cellTranscript(insert).startsWith("\n")).toBe(false);
  });
});

describe("buildTablesView", () => {
  it("lists the configured tables before anything was introspected", () => {
    const scenario = scenarioFromTemplate(MULTI_TENANT_SAAS, "leaky");
    const view = buildTablesView(scenario, null);
    expect(view.introspected).toBe(false);
    expect(view.tables.map((table) => table.key)).toEqual([
      "public.invoices",
      "public.projects",
      "public.tenants",
    ]);
    expect(view.tables.every((table) => !table.introspected && table.source === "configured")).toBe(
      true,
    );
    expect(view.expectations[1]?.rows).toHaveLength(5);
    expect(view.expectations[1]?.rows[1]?.cells.map((entry) => entry.scope)).toEqual([
      "tenant",
      "own",
      "tenant",
      "own",
    ]);
    expect(view.expectations[1]?.rows[1]?.cells.every((entry) => entry.source === "explicit")).toBe(
      true,
    );
    expect(view.orphans).toEqual([]);
  });

  it("suggests columns for tables the scenario does not configure, and marks defaults", () => {
    const scenario = {
      ...blankScenario("b"),
      schemaSql: MULTI_TENANT_SAAS.leaky.scenario.schemaSql,
    };
    const view = buildTablesView(scenario, run.catalog);
    expect(view.introspected).toBe(true);
    const invoices = view.tables[0];
    const tenants = view.tables[2];
    expect(invoices).toMatchObject({
      key: "public.invoices",
      introspected: true,
      source: "suggested",
      effective: { schema: "public", name: "invoices", tenantColumn: "tenant_id" },
      primaryKey: ["id"],
      unknownColumns: [],
    });
    expect(invoices?.columns).toContain("amount_cents");
    expect(tenants?.source).toBe("none");
    const userRow = view.expectations[0]?.rows[1];
    expect(userRow?.cells.map((entry) => [entry.scope, entry.source, entry.defaultScope])).toEqual([
      ["tenant", "default", "tenant"],
      ["tenant", "default", "tenant"],
      ["tenant", "default", "tenant"],
      ["tenant", "default", "tenant"],
    ]);
    expect(view.expectations[0]?.rows[0]?.cells[0]).toMatchObject({
      scope: "none",
      source: "default",
      expectedRowsSql: null,
    });
  });

  it("shows overrides, unknown columns, custom SQL and orphans", () => {
    const base = { ...blankScenario("b") };
    const invoices = { schema: "public", name: "invoices", tenantColumn: "tenant_id" };
    const cellRef = {
      personaId: "user-a",
      schema: "public",
      table: "invoices",
      operation: "select",
    } as const;
    let scenario = setTableColumn(base, invoices, "ownerColumn", "no_such_column");
    scenario = setExpectation(scenario, cellRef, "custom", "select id from public.invoices");
    scenario = setExpectation(scenario, { ...cellRef, table: "dropped" }, "all");
    const view = buildTablesView(scenario, run.catalog);
    expect(view.tables[0]).toMatchObject({
      source: "configured",
      unknownColumns: ["no_such_column"],
    });
    expect(view.expectations[0]?.rows[1]?.cells[0]).toMatchObject({
      scope: "custom",
      source: "explicit",
      defaultScope: "own",
      expectedRowsSql: "select id from public.invoices",
    });
    expect(view.orphans.map((orphan) => orphan.table)).toEqual(["dropped"]);
  });
});

describe("setup error views", () => {
  it("keeps the statement's line when Postgres gives no position", () => {
    const view = toSetupErrorView(
      new SetupError({
        phase: "grants",
        statementIndex: 0,
        statement: "grant usage on schema x to anon",
        line: 4,
        column: 1,
        sqlState: "3F000",
        message: "schema does not exist",
      }),
    );
    expect(view).toEqual({
      phase: "grants",
      editor: null,
      sqlState: "3F000",
      message: "schema does not exist",
      detail: null,
      hint: null,
      statement: "grant usage on schema x to anon",
      statementLine: 4,
      errorLine: 4,
      timedOut: false,
    });
  });

  it("adds the lines before the reported position, and carries detail and hint", () => {
    const statement = "insert into t\nvalues\n  (1, 'x')";
    const view = toSetupErrorView(
      new SetupError({
        phase: "seed",
        statementIndex: 2,
        statement,
        line: 10,
        column: 1,
        sqlState: "23505",
        message: "duplicate key",
        detail: "Key (id)=(1) already exists.",
        hint: "Use another id.",
        position: statement.indexOf("(1") + 1,
      }),
    );
    expect(view).toMatchObject({
      editor: "seed",
      statementLine: 10,
      errorLine: 12,
      detail: "Key (id)=(1) already exists.",
      hint: "Use another id.",
    });
    const zero = toSetupErrorView(
      new SetupError({
        phase: "seed",
        statementIndex: 0,
        statement,
        line: 3,
        column: 1,
        sqlState: null,
        message: "m",
        position: 0,
      }),
    );
    expect(zero.errorLine).toBe(3);
  });

  it("finds a timed-out statement by text and occurrence, schema before seed", () => {
    const scenario = {
      schemaSql: "select 1;\nselect pg_sleep(60);",
      seedSql: "select 2;\n\nselect pg_sleep(60);",
    };
    expect(locateTimedOutStatement(scenario, "select pg_sleep(60)", 0, 5_000)).toMatchObject({
      phase: "schema",
      statementLine: 2,
      timedOut: true,
      sqlState: null,
    });
    expect(locateTimedOutStatement(scenario, "select pg_sleep(60)", 1, 5_000)).toMatchObject({
      phase: "seed",
      statementLine: 3,
    });
    // More executions than occurrences (a rebuild): the last occurrence is the best answer.
    expect(locateTimedOutStatement(scenario, "select pg_sleep(60)", 7, 5_000)).toMatchObject({
      phase: "seed",
    });
    expect(locateTimedOutStatement(scenario, "set time zone 'UTC'", 0, 5_000)).toBeNull();
  });
});
