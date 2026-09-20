"use client";

/**
 * The scenario, in four tabs: Schema SQL, Seed SQL, Personas, Expectations. Mode and default
 * grants sit above them because they apply to all four.
 */
import dynamic from "next/dynamic";
import { CircleX } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LAB_TABS, type LabTab, type SetupErrorView, type SqlKind } from "@/lib/lab";
import {
  MAX_SQL_LENGTH,
  MODES,
  SUPABASE_GRANT_REGIMES,
  type Mode,
  type SupabaseGrants,
} from "@/lib/scenario";
import { NativeSelect } from "./native-select";
import type { SqlEditorHandle } from "./sql-editor";

/** CodeMirror is a chunk of its own: it loads when the lab is on screen, not with its shell. */
const SqlEditor = dynamic(() => import("./sql-editor").then((module) => module.SqlEditor), {
  ssr: false,
  loading: () => (
    <p role="status" className="p-3 text-sm text-muted-foreground">
      Loading the SQL editor
    </p>
  ),
});

const MODE_HELP: Readonly<Record<Mode, string>> = {
  supabase:
    "Adds the roles anon, authenticated and service_role and auth.uid(), auth.jwt(), auth.role(), auth.email() before your schema runs.",
  postgres: "Plain Postgres: your schema creates its own roles and grants; nothing is added.",
};

const GRANTS_HELP: Readonly<Record<SupabaseGrants, string>> = {
  legacy:
    "New tables are granted to anon, authenticated and service_role, so RLS is the only barrier (projects created before 2026-05-30).",
  explicit:
    "New tables get no grants until your SQL grants them (new projects, and every project from 2026-10-30).",
};

const SQL_TABS: readonly { readonly kind: SqlKind; readonly label: string }[] = [
  { kind: "schema", label: "Schema SQL" },
  { kind: "seed", label: "Seed SQL" },
];

interface ScenarioPanelProps {
  readonly mode: Mode;
  readonly grants: SupabaseGrants;
  readonly schemaSql: string;
  readonly seedSql: string;
  /** Changes with every load: the editors remount on it and read their text again. */
  readonly loadCount: number;
  readonly activeTab: LabTab;
  readonly setupError: SetupErrorView | null;
  readonly personaCount: number;
  /** `true` when a persona has a problem: the tab says so. */
  readonly personasInvalid: boolean;
  readonly handles: Readonly<Record<SqlKind, RefObject<SqlEditorHandle | null>>>;
  readonly personas: ReactNode;
  readonly expectations: ReactNode;
  readonly onTabChange: (tab: LabTab) => void;
  readonly onSqlChange: (kind: SqlKind, text: string) => void;
  readonly onModeChange: (mode: Mode) => void;
  readonly onGrantsChange: (grants: SupabaseGrants) => void;
  readonly onRun: () => void;
  /** `/s/[slug]`: mode, grants and both editors show the scenario and cannot change it. */
  readonly readOnly?: boolean;
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

function isGrants(value: string): value is SupabaseGrants {
  return (SUPABASE_GRANT_REGIMES as readonly string[]).includes(value);
}

function isLabTab(value: string): value is LabTab {
  return (LAB_TABS as readonly string[]).includes(value);
}

function ErrorMark() {
  return (
    <>
      <CircleX aria-hidden="true" className="size-3.5 text-status-leak" />
      <span className="sr-only">(has an error)</span>
    </>
  );
}

export function ScenarioPanel(props: ScenarioPanelProps) {
  const { mode, grants, setupError, activeTab, readOnly = false } = props;
  const sqlOf = (kind: SqlKind): string => (kind === "schema" ? props.schemaSql : props.seedSql);

  return (
    <section
      aria-labelledby="scenario-heading"
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <h2 id="scenario-heading" className="sr-only">
        Scenario
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="lab-mode">Mode</Label>
          <NativeSelect
            id="lab-mode"
            data-testid="mode-select"
            value={mode}
            disabled={readOnly}
            aria-describedby="lab-mode-help"
            onChange={(event) => {
              if (isMode(event.target.value)) {
                props.onModeChange(event.target.value);
              }
            }}
          >
            <option value="supabase">supabase</option>
            <option value="postgres">postgres</option>
          </NativeSelect>
          <p id="lab-mode-help" className="text-xs text-muted-foreground">
            {MODE_HELP[mode]}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="lab-grants">Default grants</Label>
          <NativeSelect
            id="lab-grants"
            data-testid="grants-select"
            value={grants}
            disabled={readOnly || mode !== "supabase"}
            aria-describedby="lab-grants-help"
            onChange={(event) => {
              if (isGrants(event.target.value)) {
                props.onGrantsChange(event.target.value);
              }
            }}
          >
            <option value="legacy">legacy</option>
            <option value="explicit">explicit</option>
          </NativeSelect>
          <p id="lab-grants-help" className="text-xs text-muted-foreground">
            {mode === "supabase"
              ? GRANTS_HELP[grants]
              : "Only in supabase mode: plain Postgres has no default grants to choose."}
          </p>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isLabTab(value)) {
            props.onTabChange(value);
          }
        }}
      >
        <TabsList className="w-full [&>button]:px-1 [&>button]:text-xs xl:[&>button]:text-sm">
          {SQL_TABS.map((tab) => (
            <TabsTrigger key={tab.kind} value={tab.kind} data-testid={`tab-${tab.kind}`}>
              {tab.label}
              {setupError?.editor === tab.kind ? <ErrorMark /> : null}
            </TabsTrigger>
          ))}
          <TabsTrigger value="personas" data-testid="tab-personas">
            Personas ({props.personaCount}){props.personasInvalid ? <ErrorMark /> : null}
          </TabsTrigger>
          <TabsTrigger value="expectations" data-testid="tab-expectations">
            Expectations
          </TabsTrigger>
        </TabsList>
        {SQL_TABS.map((tab) => (
          <TabsContent key={tab.kind} value={tab.kind} className="flex flex-col gap-2">
            <div className="h-[30rem]">
              <SqlEditor
                key={`${tab.kind}-${props.loadCount}`}
                label={tab.label}
                initialValue={sqlOf(tab.kind)}
                errorLine={setupError?.editor === tab.kind ? setupError.errorLine : null}
                handleRef={props.handles[tab.kind]}
                testId={`sql-editor-${tab.kind}`}
                readOnly={readOnly}
                onChange={(text) => props.onSqlChange(tab.kind, text)}
                onRun={props.onRun}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Runs statement by statement as the superuser, in your browser only.{" "}
              {readOnly
                ? "Read-only here."
                : `Up to ${MAX_SQL_LENGTH.toLocaleString("en")} characters.`}{" "}
              Ctrl+Enter or Cmd+Enter runs the matrix.
            </p>
          </TabsContent>
        ))}
        <TabsContent value="personas">{props.personas}</TabsContent>
        <TabsContent value="expectations">{props.expectations}</TabsContent>
      </Tabs>
    </section>
  );
}
