/** Builders for findings and their objects, and the one ordering every list of findings uses. */
import type {
  CatalogFunction,
  CatalogPolicy,
  CatalogTable,
  CatalogView,
} from "@/lib/runner/introspect";
import { compareText, qualifiedName, quoteIdent } from "@/lib/scenario";
import { ruleById } from "./rules";
import {
  SEVERITIES,
  type CheckId,
  type Finding,
  type FindingEvidence,
  type FindingObject,
} from "./types";

export function tableObject(table: Pick<CatalogTable, "schema" | "name">): FindingObject {
  return {
    kind: "table",
    schema: table.schema,
    name: table.name,
    qualifiedName: qualifiedName(table.schema, table.name),
  };
}

export function viewObject(view: Pick<CatalogView, "schema" | "name">): FindingObject {
  return { ...tableObject(view), kind: "view" };
}

export function policyObject(
  policy: Pick<CatalogPolicy, "schema" | "table" | "name">,
): FindingObject {
  return {
    kind: "policy",
    schema: policy.schema,
    name: policy.name,
    table: policy.table,
    qualifiedName: `${quoteIdent(policy.name)} ON ${qualifiedName(policy.schema, policy.table)}`,
  };
}

export function functionObject(
  fn: Pick<CatalogFunction, "schema" | "name" | "identityArguments">,
): FindingObject {
  return {
    kind: "function",
    schema: fn.schema,
    name: fn.name,
    identityArguments: fn.identityArguments,
    qualifiedName: `${qualifiedName(fn.schema, fn.name)}(${fn.identityArguments})`,
  };
}

export interface FindingDetails {
  readonly explanation: string;
  readonly evidence: readonly FindingEvidence[];
  /** Overrides the rule's page when another one fits this finding better. */
  readonly docsUrl?: string;
}

/** Severity, title and documentation come from the rule, so a finding cannot disagree with it. */
export function finding(id: CheckId, object: FindingObject, details: FindingDetails): Finding {
  const rule = ruleById(id);
  return {
    id,
    severity: rule.severity,
    object,
    title: rule.title,
    explanation: details.explanation,
    docsUrl: details.docsUrl ?? rule.docsUrl,
    evidence: details.evidence,
  };
}

export function evidence(label: string, value: string): FindingEvidence {
  return { label, value };
}

export const yesNo = (value: boolean): string => (value ? "yes" : "no");

function objectSortKey(object: FindingObject): readonly string[] {
  // A policy sorts with its table; overloads sort by their arguments.
  return [
    object.schema,
    object.table ?? object.name,
    object.kind,
    object.name,
    object.identityArguments ?? "",
  ];
}

/** Severity (critical first), then rule id, then object. Code-unit order, locale-free (P6). */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
  if (bySeverity !== 0) {
    return bySeverity;
  }
  const byId = compareText(a.id, b.id);
  if (byId !== 0) {
    return byId;
  }
  const left = objectSortKey(a.object);
  const right = objectSortKey(b.object);
  for (let at = 0; at < left.length; at += 1) {
    const byPart = compareText(left[at] ?? "", right[at] ?? "");
    if (byPart !== 0) {
      return byPart;
    }
  }
  return 0;
}
