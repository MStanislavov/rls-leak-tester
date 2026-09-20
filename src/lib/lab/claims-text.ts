/**
 * The claims of a persona are edited as JSON text. The text is external input (SEC-002): it is
 * parsed and then validated with the persona schema's own `claims` rule on every keystroke.
 */
import { personaSchema } from "@/lib/scenario";

export type ClaimsTextResult =
  | { readonly ok: true; readonly claims: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

const claimsSchema = personaSchema.shape.claims;

export function parseClaimsText(text: string): ClaimsTextResult {
  if (text.trim() === "") {
    return { ok: true, claims: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "syntax error";
    return { ok: false, message: `Not valid JSON: ${detail}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'Claims must be a JSON object, for example { "sub": "..." }' };
  }
  const parsed = claimsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((issue) => `Claims ${issue.message}`).join("; "),
    };
  }
  return { ok: true, claims: parsed.data };
}

export function formatClaims(claims: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(claims, null, 2);
}
