/**
 * Who is calling, verified on the server. `auth.getUser()` asks Supabase Auth to validate the
 * access token of the request's cookies; `auth.getSession()` would only decode the cookie, which
 * the caller controls, so it is never used to authorise anything here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { StoreError } from "../types";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "./policy";

const userSchema = z.object({ id: z.uuid() });

/** Statuses with which Supabase Auth says "this token is not good", as opposed to "I am down". */
const REJECTED_STATUSES = new Set([400, 401, 403, 404]);

function isRejection(error: { name?: unknown; status?: unknown }): boolean {
  if (error.name === "AuthSessionMissingError") return true;
  return typeof error.status === "number" && REJECTED_STATUSES.has(error.status);
}

/**
 * The verified user id, or `undefined` when nobody is signed in. Throws `unavailable` when
 * Supabase Auth could not be asked: an outage must not look like "signed out".
 */
export async function resolveUserId(client: SupabaseClient): Promise<string | undefined> {
  let result: Awaited<ReturnType<SupabaseClient["auth"]["getUser"]>>;
  try {
    result = await client.auth.getUser();
  } catch (error) {
    throw authUnavailable(error);
  }
  if (result.error !== null) {
    if (isRejection(result.error)) return undefined;
    throw authUnavailable({ name: result.error.name });
  }
  const user = userSchema.safeParse(result.data.user);
  return user.success ? user.data.id : undefined;
}

function authUnavailable(cause: unknown): StoreError {
  return new StoreError("unavailable", "Sign-in could not be checked. Try again shortly.", {
    cause,
    retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
  });
}

export async function requireUserId(client: SupabaseClient): Promise<string> {
  const userId = await resolveUserId(client);
  if (userId === undefined) {
    throw new StoreError("unauthenticated", "Sign in with GitHub to save and share scenarios.");
  }
  return userId;
}
