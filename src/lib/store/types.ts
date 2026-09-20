/**
 * The `ScenarioStore` port (brief 3.10): where a scenario is saved. Two adapters implement it:
 * browser `localStorage` (the default: no account, no network) and the app's own
 * `/api/scenarios` routes in front of Supabase (only when Supabase is configured and the user
 * is signed in). Client code never talks to Supabase tables directly.
 */
import type { Scenario } from "@/lib/scenario";

export const VISIBILITIES = ["public", "unlisted", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface StoredScenarioSummary {
  id: string;
  slug: string;
  title: string;
  visibility: Visibility;
  /** ISO 8601. */
  updatedAt: string;
}

export interface StoredScenario extends StoredScenarioSummary {
  scenario: Scenario;
  ownedByMe: boolean;
}

export interface SaveScenarioInput {
  /** Omitted: a new entry is created. Given: that entry is replaced. */
  id?: string;
  scenario: Scenario;
  /** Default `private`. The local adapter stores `private` whatever is asked. */
  visibility?: Visibility;
}

export interface ScenarioStore {
  kind: "local" | "supabase";
  /** The caller's own scenarios, newest first. */
  list(): Promise<StoredScenarioSummary[]>;
  get(id: string): Promise<StoredScenario | null>;
  getBySlug(slug: string): Promise<StoredScenario | null>;
  save(input: SaveScenarioInput): Promise<StoredScenario>;
  remove(id: string): Promise<void>;
}

export const STORE_ERROR_CODES = [
  /** The browser refused the write: the storage quota is used up. */
  "quota_exceeded",
  /** `localStorage` does not exist or throws (private mode, blocked site data). */
  "storage_unavailable",
  /** The scenario or the request did not pass validation. */
  "invalid",
  /** The scenario is larger than the store accepts. */
  "too_large",
  "not_found",
  /** Nobody is signed in. */
  "unauthenticated",
  /** Signed in, but not the owner. */
  "forbidden",
  "rate_limited",
  /** Supabase is not configured on this deployment. */
  "not_configured",
  /** The server or a service behind it is down. */
  "unavailable",
  /** The request never got an answer. */
  "network",
  /** The server answered with something this client does not understand. */
  "invalid_response",
  /** What is stored under this id or slug is not a readable scenario. */
  "corrupt",
] as const;
export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export interface StoreErrorIssue {
  path: string;
  message: string;
}

export interface StoreErrorDetails {
  issues?: readonly StoreErrorIssue[];
  /** Seconds, for `rate_limited` and `unavailable`. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** Every failure of a store is this error; `code` says which one. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly issues: readonly StoreErrorIssue[];
  readonly retryAfterSeconds: number | undefined;

  constructor(code: StoreErrorCode, message: string, details: StoreErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "StoreError";
    this.code = code;
    this.issues = details.issues ?? [];
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

export function isStoreError(error: unknown): error is StoreError {
  return error instanceof StoreError;
}

/** A stored entry that could not be read. It is skipped, never thrown. */
export interface StoreProblem {
  /** The storage key of the entry. */
  key: string;
  /** The entry's id when the index still knows it. */
  id: string | undefined;
  reason: "not-json" | "wrong-shape" | "invalid-scenario" | "missing";
  message: string;
}
