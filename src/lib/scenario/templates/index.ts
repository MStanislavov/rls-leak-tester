/**
 * The built-in templates (brief 3.9). Import from `@/lib/scenario/templates`; the scenario index
 * does not re-export them, so a page that only needs the types does not load the SQL.
 */
import { MULTI_TENANT_SAAS } from "./multi-tenant-saas";
import { TEAM_WORKSPACE } from "./team-workspace";
import { TODOS_SHARING } from "./todos-sharing";
import { TEMPLATE_VARIANT_KINDS, type Template, type TemplateVariant } from "./types";

export { TEMPLATE_VARIANT_KINDS } from "./types";
export type {
  ExpectedFailure,
  ExpectedStaticCheck,
  FailureStatus,
  Template,
  TemplateCheckId,
  TemplateVariant,
  TemplateVariantKind,
} from "./types";

export { MULTI_TENANT_SAAS } from "./multi-tenant-saas";
export { TEAM_WORKSPACE } from "./team-workspace";
export { TODOS_SHARING } from "./todos-sharing";

/** Stable order: the order of the brief, and the order every list and test shows them in. */
export const TEMPLATES: readonly Template[] = [MULTI_TENANT_SAAS, TEAM_WORKSPACE, TODOS_SHARING];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/** Every variant of every template, leaky before fixed: what a golden test iterates over. */
export function templateVariants(): { template: Template; variant: TemplateVariant }[] {
  return TEMPLATES.flatMap((template) =>
    TEMPLATE_VARIANT_KINDS.map((kind) => ({ template, variant: template[kind] })),
  );
}

/** The variant whose scenario has this id (`<template id>-leaky` or `<template id>-fixed`). */
export function findTemplateVariant(scenarioId: string): TemplateVariant | undefined {
  return templateVariants().find(({ variant }) => variant.scenario.id === scenarioId)?.variant;
}
