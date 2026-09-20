/**
 * `/lab` reads three query parameters. They are chosen by whoever wrote the link, so they are
 * parsed with zod (SEC-002) and anything unknown falls back to the default entry instead of
 * failing the page.
 *
 *   ?template=<template id>&variant=leaky|fixed   a built-in template
 *   ?template=blank                               an empty scenario
 *   ?saved=<store id>                             an entry of the local store (read in the browser)
 */
import { z } from "zod";

import { ID_PATTERN, MAX_ID_LENGTH } from "@/lib/scenario";
import {
  TEMPLATES,
  TEMPLATE_VARIANT_KINDS,
  findTemplate,
  type TemplateVariantKind,
} from "@/lib/scenario/templates";

export const BLANK_TEMPLATE_ID = "blank";
export const DEFAULT_VARIANT: TemplateVariantKind = "leaky";

export type LabEntry =
  | {
      readonly kind: "template";
      readonly templateId: string;
      readonly variant: TemplateVariantKind;
    }
  | { readonly kind: "blank" }
  | { readonly kind: "saved"; readonly storeId: string };

/** A query value may arrive as a list (`?a=1&a=2`); the first one counts. */
const firstValue = z.preprocess(
  (value) => (Array.isArray(value) ? value[0] : value),
  z.string().max(200).optional(),
);

const searchParamsSchema = z.object({
  template: firstValue,
  variant: firstValue,
  saved: firstValue,
});

const variantSchema = z.enum(TEMPLATE_VARIANT_KINDS);
const storeIdSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(ID_PATTERN);

/** What `/lab` opens without parameters: the first template, leaky, ready to run. */
export function defaultLabEntry(): LabEntry {
  const first = TEMPLATES[0];
  return first === undefined
    ? { kind: "blank" }
    : { kind: "template", templateId: first.id, variant: DEFAULT_VARIANT };
}

/** Never throws. Unknown templates, variants and ids lead to the default entry. */
export function parseLabSearchParams(raw: unknown): LabEntry {
  const parsed = searchParamsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return defaultLabEntry();
  }
  const { template, variant, saved } = parsed.data;
  if (template === BLANK_TEMPLATE_ID) {
    return { kind: "blank" };
  }
  if (template !== undefined) {
    const found = findTemplate(template);
    if (found !== undefined) {
      const kind = variantSchema.safeParse(variant);
      return {
        kind: "template",
        templateId: found.id,
        variant: kind.success ? kind.data : DEFAULT_VARIANT,
      };
    }
    return defaultLabEntry();
  }
  if (saved !== undefined) {
    const id = storeIdSchema.safeParse(saved);
    if (id.success) {
      return { kind: "saved", storeId: id.data };
    }
  }
  return defaultLabEntry();
}

/** The query string that reopens `entry`, without the leading `?`. */
export function labEntryQuery(entry: LabEntry): string {
  const params = new URLSearchParams();
  if (entry.kind === "template") {
    params.set("template", entry.templateId);
    params.set("variant", entry.variant);
  } else if (entry.kind === "blank") {
    params.set("template", BLANK_TEMPLATE_ID);
  } else {
    params.set("saved", entry.storeId);
  }
  return params.toString();
}
