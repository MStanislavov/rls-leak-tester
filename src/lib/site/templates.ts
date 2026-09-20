/**
 * What the landing page shows of a template: its metadata and a link into the lab. The SQL, the
 * personas and the expectations stay out, so the page that renders these cards ships none of them.
 */
import type { Template, TemplateVariantKind } from "@/lib/scenario/templates";

export interface TemplateCard {
  readonly id: string;
  readonly title: string;
  /** The application the schema stands for. */
  readonly description: string;
  /** What the bug of the leaky variant is. Starts in lower case: it follows "The leak:". */
  readonly leak: string;
  /** `/lab?template=<id>&variant=leaky` */
  readonly href: string;
}

/** The lab reads `template` and `variant` from the query string and loads that built-in scenario. */
export function labTemplateHref(templateId: string, variant: TemplateVariantKind): string {
  const query = new URLSearchParams({ template: templateId, variant });
  return `/lab?${query.toString()}`;
}

export function templateCards(templates: readonly Template[]): TemplateCard[] {
  return templates.map((template) => ({
    id: template.id,
    title: template.title,
    description: template.description,
    leak: template.leak,
    href: labTemplateHref(template.id, "leaky"),
  }));
}
