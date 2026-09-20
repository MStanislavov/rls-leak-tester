"use client";

/**
 * The template part of the lab toolbar: the select, the leaky/fixed switch and the sentence that
 * says what the template shows. All three follow from the scenario's origin.
 */
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ScenarioOrigin } from "@/lib/lab";
import {
  TEMPLATES,
  TEMPLATE_VARIANT_KINDS,
  findTemplate,
  type TemplateVariantKind,
} from "@/lib/scenario/templates";
import { NativeSelect } from "./native-select";

interface TemplateChoice {
  /** "" when the scenario does not come from a template. */
  readonly templateId: string;
  readonly variant: TemplateVariantKind | null;
}

function templateChoice(origin: ScenarioOrigin): TemplateChoice {
  return origin.kind === "template"
    ? { templateId: origin.templateId, variant: origin.variant }
    : { templateId: "", variant: null };
}

export function TemplateControls({
  origin,
  readOnly,
  busy,
  onLoadTemplate,
}: {
  readonly origin: ScenarioOrigin;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onLoadTemplate: (templateId: string, variant: TemplateVariantKind) => void;
}) {
  const { templateId, variant } = templateChoice(origin);
  return (
    <>
      {readOnly ? null : (
        <div className="flex flex-col gap-1">
          <Label htmlFor="template-select">Template</Label>
          <NativeSelect
            id="template-select"
            data-testid="template-select"
            className="w-56"
            disabled={busy}
            value={templateId}
            onChange={(event) => onLoadTemplate(event.target.value, variant ?? "leaky")}
          >
            {templateId === "" ? <option value="">Your own scenario</option> : null}
            {TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.title}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {variant === null ? null : (
        <fieldset aria-label="Template variant" className="flex min-w-0 items-center gap-1">
          {TEMPLATE_VARIANT_KINDS.map((kind) => (
            <Button
              key={kind}
              type="button"
              size="sm"
              variant={variant === kind ? "secondary" : "ghost"}
              aria-pressed={variant === kind}
              disabled={busy}
              data-testid={`variant-${kind}`}
              onClick={() => onLoadTemplate(templateId, kind)}
            >
              {kind}
            </Button>
          ))}
        </fieldset>
      )}
    </>
  );
}

export function TemplateDescription({ origin }: { readonly origin: ScenarioOrigin }) {
  const { templateId, variant } = templateChoice(origin);
  if (templateId === "") {
    return null;
  }
  const template = findTemplate(templateId);
  const fixed = variant === "fixed";
  return (
    <p className="text-sm text-muted-foreground" data-testid="template-description">
      <span className="font-medium text-foreground">{fixed ? "The fix: " : "The leak: "}</span>
      {fixed ? template?.fix : template?.leak}
    </p>
  );
}
