/**
 * The contract of a built-in template (brief 3.9). A template is one schema in two variants:
 * `leaky`, which contains exactly one isolation bug, and `fixed`, which differs from it only in
 * the policy text that repairs the bug. Both carry explicit expectations for every persona x
 * table x operation, and both say, as data, what the matrix runner and the static checks must
 * report. That makes them demos and golden fixtures at once.
 */
import type { Operation, Scenario } from "../types";

export const TEMPLATE_VARIANT_KINDS = ["leaky", "fixed"] as const;
export type TemplateVariantKind = (typeof TEMPLATE_VARIANT_KINDS)[number];

/** The two cell statuses that make a verdict LEAKING (brief 3.5). */
export type FailureStatus = "leak" | "escape";

/** One matrix cell the runner must report as failing, and how. */
export interface ExpectedFailure {
  readonly personaId: string;
  readonly schema: string;
  readonly table: string;
  readonly operation: Operation;
  readonly status: FailureStatus;
}

/** The ids of brief 3.6. Kept local: `src/lib/checks` depends on the scenario model, not back. */
export type TemplateCheckId =
  "RLS001" | "RLS002" | "RLS003" | "RLS004" | "RLS005" | "RLS006" | "RLS007" | "RLS008" | "RLS009";

/** One static finding the checks must produce: the rule, and the policy or table it points at. */
export interface ExpectedStaticCheck {
  readonly id: TemplateCheckId;
  readonly schema: string;
  readonly table: string;
  /** Set when the finding concerns one policy of the table. */
  readonly policy?: string;
}

export interface TemplateVariant {
  readonly kind: TemplateVariantKind;
  readonly scenario: Scenario;
  readonly expectedVerdict: "LEAKING" | "ISOLATED";
  /**
   * Exactly the cells with status `leak` or `escape`, in matrix order (table, persona in scenario
   * order, operation). Every other cell must pass. Empty for a fixed variant.
   */
  readonly expectedFailures: readonly ExpectedFailure[];
  /** Exactly the static findings expected, sorted by id. Empty for a fixed variant. */
  readonly expectedStaticChecks: readonly ExpectedStaticCheck[];
}

export interface Template {
  /** Stable id; the scenario ids are `<id>-leaky` and `<id>-fixed`. */
  readonly id: string;
  readonly title: string;
  /** One paragraph: the application the schema stands for. */
  readonly description: string;
  /** What the bug of the leaky variant is and what it lets a user do. */
  readonly leak: string;
  /** What the fixed variant changes. */
  readonly fix: string;
  readonly leaky: TemplateVariant;
  readonly fixed: TemplateVariant;
}
