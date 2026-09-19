/**
 * The cast the templates share. Fixed uuids, so every run and every exported proof names the same
 * rows. In `supabase` mode `sub` must be a real uuid: `auth.uid()` casts it (ADR 0002).
 */
import { quoteLiteral } from "../ident";
import type { Persona } from "../types";
import { everyOperation } from "./build";

export interface TemplateUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export const ALICE: TemplateUser = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "Alice",
  email: "alice@example.com",
};
export const BOB: TemplateUser = {
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  name: "Bob",
  email: "bob@example.com",
};
export const CAROL: TemplateUser = {
  id: "cccccccc-0000-4000-8000-000000000003",
  name: "Carol",
  email: "carol@example.com",
};
export const DAVE: TemplateUser = {
  id: "dddddddd-0000-4000-8000-000000000004",
  name: "Dave",
  email: "dave@example.com",
};
export const ERIN: TemplateUser = {
  id: "eeeeeeee-0000-4000-8000-000000000005",
  name: "Erin",
  email: "erin@example.com",
};

export const ANON_PERSONA_ID = "anon";
export const SERVICE_PERSONA_ID = "service";

/** A visitor without a session: PostgREST's `anon` role, no `sub`. */
export function anonPersona(): Persona {
  return {
    id: ANON_PERSONA_ID,
    label: "Anonymous visitor",
    dbRole: "anon",
    claims: { role: "anon" },
  };
}

/** The backend with the service key: `service_role` has BYPASSRLS and reaches every row. */
export function servicePersona(): Persona {
  return {
    id: SERVICE_PERSONA_ID,
    label: "Backend (service role)",
    dbRole: "service_role",
    claims: { role: "service_role" },
  };
}

/** A signed-in user. `personaId` is the lower-case first name. */
export function userPersona(
  user: TemplateUser,
  label: string,
  extra: Pick<Persona, "tenantClaimPath"> & { claims?: Record<string, unknown> } = {},
): Persona {
  const persona: Persona = {
    id: user.name.toLowerCase(),
    label,
    dbRole: "authenticated",
    claims: { sub: user.id, role: "authenticated", email: user.email, ...extra.claims },
  };
  if (extra.tenantClaimPath !== undefined) {
    persona.tenantClaimPath = extra.tenantClaimPath;
  }
  return persona;
}

/** The shim's `auth.users` must hold a user before a row can reference it. */
export function authUsersSeedSql(users: readonly TemplateUser[]): string {
  const rows = users.map((user) => `  (${quoteLiteral(user.id)}, ${quoteLiteral(user.email)})`);
  return `insert into auth.users (id, email) values\n${rows.join(",\n")};`;
}

/** Nothing at all, and everything: the two ends every template uses. */
export const NOTHING = everyOperation("none");
export const EVERYTHING = everyOperation("all");
