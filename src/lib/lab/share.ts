/**
 * Sharing, browser side (brief 3.10): whether the deployment can share at all, what the Share
 * dialog does with the `ScenarioStore` port, and "Fork to my lab". No React and no DOM here: the
 * components under `src/components/lab/share` pass the stores, the auth client and `fetch` in.
 *
 * What is SHOWN is decided here; what is ALLOWED is decided by the server (session check) and by
 * row level security behind it.
 */
import { z } from "zod";

import { newScenarioId, type FillRandom, type Scenario } from "@/lib/scenario";
import {
  isStoreError,
  StoreError,
  type ScenarioStore,
  type StoredScenario,
  type StoredScenarioSummary,
  type Visibility,
} from "@/lib/store";

import { renamedScenario } from "./scenario-file";
import { labEntryQuery } from "./search-params";
import type { ScenarioOrigin } from "./state";

export const HEALTH_PATH = "/api/health";
export const LAB_PATH = "/lab";
export const SHARED_PATH_PREFIX = "/s/";

/** Brief 3.10 and 4.8: a clear, non-alarming notice while Supabase is not configured. */
export const SHARE_DISABLED_EXPLANATION =
  "Sharing needs a Supabase project: see docs/DEPLOY.md; local save works.";

/** Brief 4.7, shown above every scenario that somebody else wrote. */
export const SHARED_SQL_NOTICE =
  "This scenario was shared by someone else. Its SQL runs only inside your browser's sandboxed Postgres; it has no network access.";

export const OWN_SHARED_SQL_NOTICE =
  "You shared this scenario. Like every scenario, its SQL runs only inside your browser's sandboxed Postgres; it has no network access.";

/** What a new share starts with: reachable by its link, not listed anywhere. */
export const DEFAULT_SHARE_VISIBILITY: Visibility = "unlisted";

export const VISIBILITY_HELP: Readonly<Record<Visibility, string>> = {
  public: "Anybody can open it, and it may be listed.",
  unlisted: "Anybody with the link can open it. It cannot be found without the link.",
  private: "Only you, signed in, can open the link.",
};

// --- is sharing configured? --------------------------------------------------------------------

export type HealthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Only the one boolean this module needs; `/api/health` never carries values (brief 4.6). */
const healthSchema = z.object({ features: z.object({ supabase: z.boolean() }) });

/** Pure. `null` when the body is not a health report. */
export function parseSharingEnabled(body: unknown): boolean | null {
  const parsed = healthSchema.safeParse(body);
  return parsed.success ? parsed.data.features.supabase : null;
}

/** Never throws: a deployment whose health cannot be read shares nothing. */
export async function fetchSharingEnabled(fetchImpl: HealthFetch): Promise<boolean> {
  try {
    const response = await fetchImpl(HEALTH_PATH, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    return parseSharingEnabled((await response.json()) as unknown) ?? false;
  } catch {
    return false;
  }
}

// --- links ---------------------------------------------------------------------------------------

export function sharedPath(slug: string): string {
  return `${SHARED_PATH_PREFIX}${encodeURIComponent(slug)}`;
}

/** The absolute link of a shared scenario. `origin` is the site URL or the page's origin. */
export function sharedUrl(origin: string, slug: string): string {
  return new URL(sharedPath(slug), origin).href;
}

// --- errors --------------------------------------------------------------------------------------

/** One sentence for the person in front of the dialog. Never the server's raw text for a 5xx. */
export function shareErrorMessage(error: unknown): string {
  if (!isStoreError(error)) {
    return "Sharing failed for a reason this app does not know.";
  }
  switch (error.code) {
    case "unauthenticated":
      return "You are signed out. Sign in with GitHub and try again.";
    case "forbidden":
      return "That scenario belongs to somebody else.";
    case "not_found":
      return "That shared scenario no longer exists.";
    case "rate_limited":
      return error.retryAfterSeconds === undefined
        ? "Too many changes in a short time. Try again in a moment."
        : `Too many changes in a short time. Try again in ${error.retryAfterSeconds} s.`;
    case "too_large":
      return "The scenario is larger than the server accepts.";
    case "invalid": {
      const first = error.issues[0];
      return first === undefined
        ? "The server did not accept the scenario."
        : `The server did not accept the scenario: ${first.path} ${first.message}`.trim();
    }
    case "not_configured":
      return SHARE_DISABLED_EXPLANATION;
    case "network":
      return "The server could not be reached. Check the connection.";
    case "unavailable":
    case "invalid_response":
    case "corrupt":
      return "The sharing service is not available right now. Your local copy is unaffected.";
    default:
      return error.message;
  }
}

// --- the Share dialog ----------------------------------------------------------------------------

export type ShareSession =
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly mine: StoredScenarioSummary[] }
  | { readonly status: "error"; readonly message: string };

export interface ShareSessionDeps {
  /** The browser auth client. When it is enabled and knows no user, the API is not asked. */
  readonly auth: { readonly enabled: boolean; getUser(): Promise<{ id: string } | null> };
  readonly store: Pick<ScenarioStore, "list">;
}

/**
 * Who is in front of the dialog and what they have shared. The server's answer decides: `401`
 * means signed out, whatever the browser session says. Never throws.
 */
export async function loadShareSession(deps: ShareSessionDeps): Promise<ShareSession> {
  try {
    if (deps.auth.enabled && (await deps.auth.getUser()) === null) {
      return { status: "signed-out" };
    }
  } catch {
    // The session could not be read: the server is asked instead.
  }
  try {
    return { status: "signed-in", mine: await deps.store.list() };
  } catch (error) {
    if (isStoreError(error) && error.code === "unauthenticated") {
      return { status: "signed-out" };
    }
    return { status: "error", message: shareErrorMessage(error) };
  }
}

/**
 * Changes who may open a shared scenario. The port replaces whole entries, so the entry is read
 * and written back with the new visibility.
 */
export async function changeVisibility(
  store: Pick<ScenarioStore, "get" | "save">,
  id: string,
  visibility: Visibility,
): Promise<StoredScenario> {
  const current = await store.get(id);
  if (current === null) {
    throw new StoreError("not_found", "There is no such scenario.");
  }
  return store.save({ id, scenario: current.scenario, visibility });
}

/** The list after `changed` was saved: replaced in place, or put first when it is new. */
export function withSharedSummary(
  mine: readonly StoredScenarioSummary[],
  changed: StoredScenarioSummary,
): StoredScenarioSummary[] {
  const summary: StoredScenarioSummary = {
    id: changed.id,
    slug: changed.slug,
    title: changed.title,
    visibility: changed.visibility,
    updatedAt: changed.updatedAt,
  };
  return mine.some((entry) => entry.id === summary.id)
    ? mine.map((entry) => (entry.id === summary.id ? summary : entry))
    : [summary, ...mine];
}

// --- leaving the lab and coming back ------------------------------------------------------------

function labPath(query: string): string {
  return query === "" ? LAB_PATH : `${LAB_PATH}?${query}`;
}

/** A copy under a new id in `store`; resolves with the lab address that opens it. */
export async function forkToLab(
  store: Pick<ScenarioStore, "save">,
  scenario: Scenario,
  fillRandom?: FillRandom,
): Promise<string> {
  const copy = renamedScenario(scenario, newScenarioId(scenario.title, fillRandom), scenario.title);
  const stored = await store.save({ scenario: copy });
  return labPath(labEntryQuery({ kind: "saved", storeId: stored.id }));
}

export interface SignInReturn {
  readonly origin: ScenarioOrigin;
  readonly dirty: boolean;
  /** The working scenario when it validates, else `null`. */
  readonly scenario: Scenario | null;
}

/**
 * Sign-in leaves the page for GitHub. The address to come back to reopens what was on screen:
 * an unchanged template or saved entry by its own address, anything else through a copy in the
 * local store. Never throws: when the copy cannot be written the answer is the plain lab.
 */
export async function signInReturnPath(
  store: Pick<ScenarioStore, "save">,
  current: SignInReturn,
  fillRandom?: FillRandom,
): Promise<string> {
  if (!current.dirty && current.origin.kind !== "imported") {
    return labPath(labEntryQuery(current.origin));
  }
  if (current.scenario === null) {
    return LAB_PATH;
  }
  try {
    return await forkToLab(store, current.scenario, fillRandom);
  } catch {
    return LAB_PATH;
  }
}
