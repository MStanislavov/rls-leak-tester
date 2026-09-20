/**
 * Structure and numbers of the /docs page. The numbers repeat `thresholds` of rules.yaml;
 * `docs.test.ts` reads that file and fails when they drift apart.
 */

export interface DocsSection {
  readonly id: string;
  readonly title: string;
}

/** In page order. The ids are URL fragments: other pages link to `/docs#<id>`. */
export const DOCS_SECTIONS = [
  { id: "how-it-works", title: "How it works" },
  { id: "probes", title: "Probe semantics" },
  { id: "outcomes", title: "How outcomes are classified" },
  { id: "verdict", title: "Verdict rules" },
  { id: "static-checks", title: "Static checks" },
  { id: "supabase-mode", title: "Supabase mode" },
  { id: "threat-model", title: "Threat model and privacy" },
  { id: "limits", title: "Limits" },
] as const satisfies readonly DocsSection[];

export type DocsSectionId = (typeof DOCS_SECTIONS)[number]["id"];

export function docsSectionHref(id: DocsSectionId): string {
  return `/docs#${id}`;
}

/** The anchor of one static check on the docs page: `/docs#rls004`. */
export function staticCheckAnchor(checkId: string): string {
  return checkId.toLowerCase();
}

export function staticCheckDocsHref(checkId: string): string {
  return `/docs#${staticCheckAnchor(checkId)}`;
}

/** rules.yaml thresholds.runner.probe_timeout_ms, in seconds. */
export const PROBE_TIMEOUT_SECONDS = 5;
/** rules.yaml thresholds.runner.run_ceiling_ms, in seconds. */
export const RUN_CEILING_SECONDS = 60;
/** rules.yaml thresholds.ai.explain_payload_max_bytes, in KiB. */
export const EXPLAIN_PAYLOAD_MAX_KIB = 30;

/** SQLSTATEs the docs name. `42501` is the only one that means "blocked". */
export const BLOCKED_SQLSTATE = "42501";
export const CONSTRAINT_SQLSTATES = ["23505", "23503", "23502", "23514"] as const;

/** Supabase's switch from blanket default grants to explicit grants (ADR 0002). */
export const SUPABASE_EXPLICIT_GRANTS_DATES = {
  newProjects: "2026-05-30",
  allProjects: "2026-10-30",
} as const;
