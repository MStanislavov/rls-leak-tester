/**
 * Reading values out of a persona's JWT claims. The runner compares these with the owner and
 * tenant columns of the ground truth, as text.
 */
import type { Persona } from "./types";

/**
 * The hyphenated 8-4-4-4-12 form, any version and variant: Postgres' `uuid` type does not look at
 * those bits, and seeds use ids such as `00000000-0000-0000-0000-000000000001`.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function child(container: Record<string, unknown> | unknown[], segment: string): unknown {
  if (Array.isArray(container)) {
    return /^(0|[1-9]\d*)$/.test(segment) ? container[Number(segment)] : undefined;
  }
  // Own properties only: `constructor` or `__proto__` in a path must not reach the prototype.
  return Object.hasOwn(container, segment) ? container[segment] : undefined;
}

/**
 * Follows a dot path such as `app_metadata.tenant_id` into the claims. A segment is an own key of
 * an object or an index of an array. Returns `undefined` when the path is empty, has an empty
 * segment, or does not lead to a value.
 */
export function getClaimPath(claims: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = claims;
  for (const segment of path.split(".")) {
    if (segment.length === 0 || !isContainer(current)) {
      return undefined;
    }
    current = child(current, segment);
  }
  return current;
}

/** A claim value as the text a column comparison uses: non-empty strings and finite numbers. */
function claimText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** The persona's user id: the `sub` claim as text, or `undefined` (for example for `anon`). */
export function personaSub(persona: Pick<Persona, "claims">): string | undefined {
  return claimText(getClaimPath(persona.claims, "sub"));
}

/** The persona's tenant: the value at `tenantClaimPath` as text, or `undefined`. */
export function personaTenant(
  persona: Pick<Persona, "claims" | "tenantClaimPath">,
): string | undefined {
  if (persona.tenantClaimPath === undefined) {
    return undefined;
  }
  return claimText(getClaimPath(persona.claims, persona.tenantClaimPath));
}
