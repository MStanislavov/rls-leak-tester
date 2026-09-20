/**
 * `/s/[slug]`, the parts that need no framework: what the page may put into its metadata, and
 * how its browser half gets from the server's answer to something on screen.
 *
 * The server loads the scenario (session from the cookies, read-through cache). Its browser half
 * loads it again through the API only in two cases: the visitor presses "Try again" after an
 * outage, or the server said "not configured" while `/api/health` says sharing is on.
 */
import { isStoreError, type ScenarioStore, type StoredScenario } from "@/lib/store/types";

export type SharedFailure = "not_found" | "not_configured" | "unavailable" | "corrupt";

/** What the Server Component hands to its browser half. A plain object: it crosses as props. */
export type SharedServerResult =
  | { readonly status: "ok"; readonly scenario: StoredScenario }
  | { readonly status: Exclude<SharedFailure, "not_found"> };

/**
 * The loader's answer as the page uses it: `null` means "answer 404" (a miss, which is also what
 * somebody else's private scenario looks like).
 */
export function toSharedServerResult(
  result:
    | { readonly status: "ok"; readonly scenario: StoredScenario }
    | { readonly status: SharedFailure },
): SharedServerResult | null {
  if (result.status === "ok") {
    return { status: "ok", scenario: result.scenario };
  }
  return result.status === "not_found" ? null : { status: result.status };
}

// --- metadata ------------------------------------------------------------------------------------

export const SHARED_PAGE_TITLE = "Shared scenario";
export const SHARED_PAGE_DESCRIPTION =
  "A shared row-level security scenario, read-only. Its SQL runs only in your browser.";

export interface SharedPageMeta {
  readonly title: string;
  readonly description: string;
  /** `false`: the page asks search engines not to index it. */
  readonly index: boolean;
}

/**
 * Only a PUBLIC scenario lends its title to the page's metadata. An unlisted or private title
 * never reaches `<title>` or a link preview, and neither of them is indexed; a miss and every
 * failure look the same from outside.
 */
export function sharedPageMeta(
  result:
    | { readonly status: "ok"; readonly scenario: Pick<StoredScenario, "title" | "visibility"> }
    | { readonly status: SharedFailure },
): SharedPageMeta {
  if (result.status === "ok" && result.scenario.visibility === "public") {
    return { title: result.scenario.title, description: SHARED_PAGE_DESCRIPTION, index: true };
  }
  return { title: SHARED_PAGE_TITLE, description: SHARED_PAGE_DESCRIPTION, index: false };
}

// --- the browser half ----------------------------------------------------------------------------

export type SharedViewState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly stored: StoredScenario }
  | { readonly phase: "failed"; readonly reason: SharedFailure };

export function initialSharedView(result: SharedServerResult): SharedViewState {
  return result.status === "ok"
    ? { phase: "ready", stored: result.scenario }
    : { phase: "failed", reason: result.status };
}

/** An outage may be over on the next attempt; the other failures will not change by asking again. */
export function canRetryShared(state: SharedViewState): boolean {
  return state.phase === "failed" && state.reason === "unavailable";
}

export const SHARED_FAILURE_TEXT: Readonly<
  Record<SharedFailure, { readonly title: string; readonly body: string }>
> = {
  not_configured: {
    title: "Sharing is not enabled on this deployment",
    body: "Shared scenarios need a Supabase project, and this deployment has none configured. The lab works without it: templates, runs, static checks, export and saving in this browser.",
  },
  not_found: {
    title: "This shared scenario does not exist",
    body: "It may have been deleted or made private by its owner. Nothing you have saved in this browser is affected.",
  },
  unavailable: {
    title: "The shared scenario could not be loaded",
    body: "The sharing service did not answer. Nothing is wrong with the link; try again in a moment.",
  },
  corrupt: {
    title: "This shared scenario cannot be read",
    body: "What is stored under this link is not a scenario this version of the app understands.",
  },
};

export interface SharedLoadDeps {
  /** `/api/health`: is sharing configured on this deployment? Never rejects. */
  readonly sharingEnabled: () => Promise<boolean>;
  readonly store: Pick<ScenarioStore, "getBySlug">;
}

/** Loads the scenario through the API. Never throws. */
export async function loadSharedInBrowser(
  slug: string,
  deps: SharedLoadDeps,
): Promise<SharedViewState> {
  if (!(await deps.sharingEnabled())) {
    return { phase: "failed", reason: "not_configured" };
  }
  try {
    const stored = await deps.store.getBySlug(slug);
    return stored === null ? { phase: "failed", reason: "not_found" } : { phase: "ready", stored };
  } catch (error) {
    if (isStoreError(error) && (error.code === "corrupt" || error.code === "not_configured")) {
      return { phase: "failed", reason: error.code };
    }
    return { phase: "failed", reason: "unavailable" };
  }
}
