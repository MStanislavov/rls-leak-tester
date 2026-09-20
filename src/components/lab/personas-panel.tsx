"use client";

import { Dices, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatIssue, personaIssues, type ClaimsDraft, type PersonaPatch } from "@/lib/lab";
import {
  MAX_PERSONAS,
  SUPABASE_ROLES,
  type Mode,
  type Persona,
  type ScenarioIssue,
} from "@/lib/scenario";
import { NativeSelect } from "./native-select";

interface PersonasPanelProps {
  readonly mode: Mode;
  readonly personas: readonly Persona[];
  /** Claims JSON as typed, by persona id; absent while the text equals the stored claims. */
  readonly claimsDrafts: Readonly<Record<string, ClaimsDraft>>;
  readonly claimsTextOf: (personaId: string) => string;
  readonly issues: readonly ScenarioIssue[];
  readonly onAdd: () => void;
  readonly onRemove: (personaId: string) => void;
  readonly onUpdate: (personaId: string, patch: PersonaPatch) => void;
  readonly onClaimsText: (personaId: string, text: string) => void;
  readonly onNewSub: (personaId: string) => void;
}

interface PersonaCardProps {
  readonly mode: Mode;
  readonly persona: Persona;
  readonly claimsText: string;
  readonly claimsError: string | null;
  readonly issues: readonly ScenarioIssue[];
  readonly onRemove: (personaId: string) => void;
  readonly onUpdate: (personaId: string, patch: PersonaPatch) => void;
  readonly onClaimsText: (personaId: string, text: string) => void;
  readonly onNewSub: (personaId: string) => void;
}

function RoleField({
  mode,
  persona,
  fieldId,
  onUpdate,
}: Pick<PersonaCardProps, "mode" | "persona" | "onUpdate"> & { readonly fieldId: string }) {
  if (mode === "postgres") {
    return (
      <Input
        id={fieldId}
        data-testid="persona-role"
        className="font-mono"
        value={persona.dbRole}
        spellCheck={false}
        onChange={(event) => onUpdate(persona.id, { dbRole: event.target.value })}
      />
    );
  }
  const known = (SUPABASE_ROLES as readonly string[]).includes(persona.dbRole);
  return (
    <NativeSelect
      id={fieldId}
      data-testid="persona-role"
      className="font-mono"
      value={persona.dbRole}
      aria-invalid={!known}
      onChange={(event) => onUpdate(persona.id, { dbRole: event.target.value })}
    >
      {SUPABASE_ROLES.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
      {known ? null : (
        <option value={persona.dbRole}>{persona.dbRole} (not a Supabase role)</option>
      )}
    </NativeSelect>
  );
}

function PersonaCard(props: PersonaCardProps) {
  const { persona, claimsError, issues } = props;
  const id = (field: string): string => `persona-${persona.id}-${field}`;
  const problems = [...(claimsError === null ? [] : [claimsError]), ...issues.map(formatIssue)];
  return (
    <li
      data-testid="persona-card"
      data-persona-id={persona.id}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="grid grid-cols-[1fr_auto] items-end gap-2 sm:grid-cols-[1fr_11rem_auto]">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id("label")}>Label</Label>
          <Input
            id={id("label")}
            data-testid="persona-label"
            value={persona.label}
            onChange={(event) => props.onUpdate(persona.id, { label: event.target.value })}
          />
        </div>
        <div className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
          <Label htmlFor={id("role")}>Database role</Label>
          <RoleField
            mode={props.mode}
            persona={persona}
            fieldId={id("role")}
            onUpdate={props.onUpdate}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="col-start-2 row-start-1 sm:col-start-3"
          aria-label={`Remove persona ${persona.label}`}
          data-testid="persona-remove"
          onClick={() => props.onRemove(persona.id)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-end justify-between gap-2">
          <Label htmlFor={id("claims")}>
            JWT claims{" "}
            <span className="font-normal text-muted-foreground">(JSON; sub is the user id)</span>
          </Label>
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="persona-new-sub"
            onClick={() => props.onNewSub(persona.id)}
          >
            <Dices aria-hidden="true" />
            New uuid for sub
          </Button>
        </div>
        <Textarea
          id={id("claims")}
          data-testid="persona-claims"
          className="max-h-40 min-h-20 font-mono text-xs"
          rows={4}
          spellCheck={false}
          value={props.claimsText}
          aria-invalid={claimsError !== null}
          aria-describedby={problems.length > 0 ? id("problems") : undefined}
          onChange={(event) => props.onClaimsText(persona.id, event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={id("tenant")}>
          Tenant claim path <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id={id("tenant")}
          data-testid="persona-tenant-path"
          className="font-mono"
          placeholder="app_metadata.tenant_id"
          spellCheck={false}
          value={persona.tenantClaimPath ?? ""}
          onChange={(event) => props.onUpdate(persona.id, { tenantClaimPath: event.target.value })}
        />
      </div>

      {problems.length === 0 ? null : (
        <ul
          id={id("problems")}
          data-testid="persona-problems"
          className="flex flex-col gap-0.5 text-xs font-medium text-status-leak"
        >
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function PersonasPanel(props: PersonasPanelProps) {
  const full = props.personas.length >= MAX_PERSONAS;
  return (
    <section aria-labelledby="personas-heading" className="flex flex-col gap-3 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="personas-heading" className="text-base font-semibold">
            Personas
          </h2>
          <p className="text-xs text-muted-foreground">
            Who is asking. Every probe runs under the persona&apos;s role with these claims, never
            as the superuser.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full}
          data-testid="persona-add"
          onClick={props.onAdd}
        >
          <Plus aria-hidden="true" />
          Add persona
        </Button>
      </div>
      {props.personas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No persona yet. Without one there is nobody to test.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {props.personas.map((persona, index) => (
            <PersonaCard
              key={persona.id}
              mode={props.mode}
              persona={persona}
              claimsText={props.claimsTextOf(persona.id)}
              claimsError={props.claimsDrafts[persona.id]?.error ?? null}
              issues={personaIssues(props.issues, index)}
              onRemove={props.onRemove}
              onUpdate={props.onUpdate}
              onClaimsText={props.onClaimsText}
              onNewSub={props.onNewSub}
            />
          ))}
        </ul>
      )}
      {full ? (
        <p className="text-xs text-muted-foreground">
          A scenario holds at most {MAX_PERSONAS} personas.
        </p>
      ) : null}
    </section>
  );
}
