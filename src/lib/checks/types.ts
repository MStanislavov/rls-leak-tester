/**
 * The contract of the static checks RLS001 to RLS009 (brief 3.6). A finding is a fact read from
 * the catalog, never a verdict: verdicts come from the matrix (rules.yaml P1). Everything here is
 * plain data, so a finding list can be serialised, diffed and rendered as text.
 */
import type { Scenario, ScenarioOptions } from "@/lib/scenario";

export const CHECK_IDS = [
  "RLS001",
  "RLS002",
  "RLS003",
  "RLS004",
  "RLS005",
  "RLS006",
  "RLS007",
  "RLS008",
  "RLS009",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** Most severe first. The order of this tuple is the sort order of findings. */
export const SEVERITIES = ["critical", "high", "medium", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type FindingObjectKind = "table" | "policy" | "function" | "view";

export interface FindingObject {
  readonly kind: FindingObjectKind;
  readonly schema: string;
  /** The object's own name: the table, the policy, the function or the view. */
  readonly name: string;
  /** Only for a policy: the table it belongs to. */
  readonly table?: string;
  /** Only for a function: `pg_get_function_identity_arguments`, which tells overloads apart. */
  readonly identityArguments?: string;
  /**
   * Quoted and ready to paste into SQL: `"public"."docs"`, `"public"."fn"(integer)`, and for a
   * policy the form ALTER POLICY takes, `"p" ON "public"."docs"`.
   */
  readonly qualifiedName: string;
}

/** One piece of proof, as text. Expressions are exactly what `pg_get_expr` printed. */
export interface FindingEvidence {
  readonly label: string;
  readonly value: string;
}

export interface Finding {
  readonly id: CheckId;
  readonly severity: Severity;
  readonly object: FindingObject;
  readonly title: string;
  /** One paragraph, plain text. */
  readonly explanation: string;
  /** The official Postgres or Supabase page the rule's semantics were confirmed against. */
  readonly docsUrl: string;
  readonly evidence: readonly FindingEvidence[];
}

/** What a rule is, independent of any database: the /docs page and the UI legend list these. */
export interface StaticCheckRule {
  readonly id: CheckId;
  readonly severity: Severity;
  readonly title: string;
  /** One paragraph: what is flagged, and what is deliberately not. */
  readonly summary: string;
  readonly docsUrl: string;
  /** `supabase` for a rule that only runs in Supabase mode, else `all`. */
  readonly modes: "all" | "supabase";
}

/**
 * What the checks need to know beyond the catalog. A whole `Scenario` fits. `personas` tells
 * which roles are application roles in `postgres` mode; `options.supabaseGrants` tells which
 * grants the tool made itself (RLS006).
 */
export type StaticCheckContext = Pick<Scenario, "mode"> & {
  readonly personas: readonly { readonly dbRole: string }[];
  readonly options?: ScenarioOptions;
};
