/**
 * The default `ScenarioStore`: browser `localStorage`. No account, no network.
 *
 * Layout (versioned, so a later format can live beside this one):
 *   `rls-leak-tester:v1:index`          `{ v: 1, ids: string[] }`
 *   `rls-leak-tester:v1:scenario:<id>`  `{ v: 1, id, updatedAt, scenario }`
 *
 * Everything that comes out of storage is untrusted (another tab, an extension, a user with
 * dev tools): the envelope is parsed with zod and the scenario with `parseScenario` on EVERY
 * read. A corrupted entry is skipped and reported through `problems()` / `onProblem`, never
 * thrown. A slug is the local id. Visibility is always `private`: nothing leaves the browser.
 */
import { z } from "zod";

import {
  MAX_SCENARIO_JSON_LENGTH,
  isValidId,
  newScenarioId,
  parseScenario,
  stableStringify,
  type FillRandom,
  type Scenario,
} from "@/lib/scenario";

import {
  StoreError,
  type SaveScenarioInput,
  type ScenarioStore,
  type StoreProblem,
  type StoredScenario,
  type StoredScenarioSummary,
} from "./types";

export const LOCAL_STORE_VERSION = 1;
export const LOCAL_STORE_PREFIX = `rls-leak-tester:v${LOCAL_STORE_VERSION}:`;
export const LOCAL_INDEX_KEY = `${LOCAL_STORE_PREFIX}index`;
const ENTRY_PREFIX = `${LOCAL_STORE_PREFIX}scenario:`;
/** Attempts at a fresh id before giving up; a collision needs the same title and 50 random bits. */
const MAX_ID_ATTEMPTS = 5;

export function localEntryKey(id: string): string {
  return `${ENTRY_PREFIX}${id}`;
}

export type LocalStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>;

export interface LocalStoreOptions {
  /** Told about every unreadable entry, as it is found. */
  onProblem?: ((problem: StoreProblem) => void) | undefined;
  now?: (() => Date) | undefined;
  fillRandom?: FillRandom | undefined;
}

export interface LocalScenarioStore extends ScenarioStore {
  kind: "local";
  /** The unreadable entries met so far, one per storage key, latest finding. */
  problems(): StoreProblem[];
}

const idSchema = z.string().refine(isValidId);
const indexSchema = z.object({ v: z.literal(LOCAL_STORE_VERSION), ids: z.array(idSchema) });
const envelopeSchema = z.object({
  v: z.literal(LOCAL_STORE_VERSION),
  id: idSchema,
  updatedAt: z.iso.datetime(),
  scenario: z.unknown(),
});

interface Entry {
  id: string;
  updatedAt: string;
  scenario: Scenario;
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

function unavailable(cause: unknown): StoreError {
  return new StoreError(
    "storage_unavailable",
    "This browser does not allow local storage here, so scenarios cannot be saved locally.",
    { cause },
  );
}

function toSummary(entry: Entry): StoredScenarioSummary {
  return {
    id: entry.id,
    slug: entry.id,
    title: entry.scenario.title,
    visibility: "private",
    updatedAt: entry.updatedAt,
  };
}

function toStored(entry: Entry): StoredScenario {
  return { ...toSummary(entry), scenario: entry.scenario, ownedByMe: true };
}

/** Newest first; equal times keep a stable order by id. */
function byNewest(a: Entry, b: Entry): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

export function createLocalScenarioStore(
  storage?: LocalStorageLike,
  options: LocalStoreOptions = {},
): LocalScenarioStore {
  const now = options.now ?? (() => new Date());
  const found = new Map<string, StoreProblem>();

  const resolveStorage = (): LocalStorageLike => {
    if (storage !== undefined) return storage;
    try {
      const candidate: unknown = (globalThis as { localStorage?: unknown }).localStorage;
      if (typeof candidate === "object" && candidate !== null) return candidate as Storage;
    } catch (error) {
      throw unavailable(error);
    }
    throw unavailable(undefined);
  };

  const report = (problem: StoreProblem): void => {
    found.set(problem.key, problem);
    options.onProblem?.(problem);
  };

  const readRaw = (key: string): string | null => {
    try {
      return resolveStorage().getItem(key);
    } catch (error) {
      throw error instanceof StoreError ? error : unavailable(error);
    }
  };

  const write = (key: string, value: string): void => {
    try {
      resolveStorage().setItem(key, value);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (isQuotaError(error)) {
        throw new StoreError(
          "quota_exceeded",
          "The browser's local storage is full. Delete a saved scenario or export this one as a file.",
          { cause: error },
        );
      }
      throw unavailable(error);
    }
  };

  const erase = (key: string): void => {
    try {
      resolveStorage().removeItem(key);
    } catch (error) {
      throw error instanceof StoreError ? error : unavailable(error);
    }
  };

  /** The JSON value under `key`; an unreadable value is reported and comes back as `unreadable`. */
  const readJson = (
    key: string,
    id: string | undefined,
  ): { state: "absent" | "unreadable" } | { state: "read"; value: unknown } => {
    const raw = readRaw(key);
    if (raw === null) return { state: "absent" };
    if (raw.length > MAX_SCENARIO_JSON_LENGTH * 2) {
      report({ key, id, reason: "wrong-shape", message: "The entry is too large to be read" });
      return { state: "unreadable" };
    }
    try {
      return { state: "read", value: JSON.parse(raw) as unknown };
    } catch {
      report({ key, id, reason: "not-json", message: "The entry is not valid JSON" });
      return { state: "unreadable" };
    }
  };

  /** Ids found by walking the storage keys: the way back from a lost index. */
  const scanIds = (): string[] => {
    const target = resolveStorage();
    if (typeof target.key !== "function" || typeof target.length !== "number") return [];
    const ids: string[] = [];
    for (let position = 0; position < target.length; position += 1) {
      const key = target.key(position);
      if (key?.startsWith(ENTRY_PREFIX) === true) {
        const id = key.slice(ENTRY_PREFIX.length);
        if (isValidId(id)) ids.push(id);
      }
    }
    return ids.sort((a, b) => (a < b ? -1 : 1));
  };

  const readIndex = (): string[] => {
    const json = readJson(LOCAL_INDEX_KEY, undefined);
    // No index, or one that is not JSON: whatever entries the storage can enumerate.
    if (json.state !== "read") return scanIds();
    const parsed = indexSchema.safeParse(json.value);
    if (!parsed.success) {
      report({
        key: LOCAL_INDEX_KEY,
        id: undefined,
        reason: "wrong-shape",
        message: "The list of saved scenarios is damaged; it was rebuilt from the entries",
      });
      return scanIds();
    }
    found.delete(LOCAL_INDEX_KEY);
    return [...new Set(parsed.data.ids)];
  };

  const writeIndex = (ids: readonly string[]): void => {
    write(LOCAL_INDEX_KEY, JSON.stringify({ v: LOCAL_STORE_VERSION, ids }));
    found.delete(LOCAL_INDEX_KEY);
  };

  const readEntry = (id: string, listed: boolean): Entry | undefined => {
    const key = localEntryKey(id);
    const json = readJson(key, id);
    if (json.state !== "read") {
      if (json.state === "absent") {
        if (listed) {
          report({ key, id, reason: "missing", message: "The entry is listed but does not exist" });
        } else {
          found.delete(key);
        }
      }
      return undefined;
    }
    const envelope = envelopeSchema.safeParse(json.value);
    if (!envelope.success || envelope.data.id !== id) {
      report({ key, id, reason: "wrong-shape", message: "The entry has an unknown shape" });
      return undefined;
    }
    const scenario = parseScenario(envelope.data.scenario);
    if (!scenario.ok) {
      report({ key, id, reason: "invalid-scenario", message: scenario.message });
      return undefined;
    }
    found.delete(key);
    return { id, updatedAt: envelope.data.updatedAt, scenario: scenario.scenario };
  };

  const freshId = (title: string, taken: ReadonlySet<string>): string => {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = newScenarioId(title, options.fillRandom);
      if (!taken.has(id) && readRaw(localEntryKey(id)) === null) return id;
    }
    throw new StoreError("unavailable", "No free id was found for the scenario. Try again.");
  };

  const validate = (input: SaveScenarioInput): { scenario: Scenario; text: string } => {
    if (input.id !== undefined && !isValidId(input.id)) {
      throw new StoreError("invalid", "The scenario id is not valid.", {
        issues: [{ path: "id", message: "An id has 1 to 64 letters, digits, '-' or '_'" }],
      });
    }
    const parsed = parseScenario(input.scenario);
    if (!parsed.ok) {
      throw new StoreError("invalid", "The scenario is not valid and was not saved.", {
        issues: parsed.issues,
      });
    }
    const text = stableStringify(parsed.scenario);
    if (text.length > MAX_SCENARIO_JSON_LENGTH) {
      throw new StoreError(
        "too_large",
        `The scenario is larger than ${MAX_SCENARIO_JSON_LENGTH} characters and was not saved.`,
      );
    }
    return { scenario: parsed.scenario, text };
  };

  const get = (id: string): StoredScenario | null => {
    if (!isValidId(id)) return null;
    const entry = readEntry(id, false);
    return entry === undefined ? null : toStored(entry);
  };

  return {
    kind: "local",
    problems: () => [...found.values()],

    list: async (): Promise<StoredScenarioSummary[]> => {
      const entries = readIndex()
        .map((id) => readEntry(id, true))
        .filter((entry) => entry !== undefined);
      return entries.sort(byNewest).map(toSummary);
    },

    get: async (id) => get(id),
    getBySlug: async (slug) => get(slug),

    save: async (input): Promise<StoredScenario> => {
      const { scenario } = validate(input);
      const ids = readIndex();
      const id = input.id ?? freshId(scenario.title, new Set(ids));
      const entry: Entry = { id, updatedAt: now().toISOString(), scenario };
      const key = localEntryKey(id);
      const previous = readRaw(key);
      write(key, JSON.stringify({ v: LOCAL_STORE_VERSION, ...entry }));
      if (!ids.includes(id)) {
        try {
          writeIndex([...ids, id]);
        } catch (error) {
          // Never leave an entry the list cannot find.
          if (previous === null) erase(key);
          throw error;
        }
      }
      found.delete(key);
      return toStored(entry);
    },

    remove: async (id): Promise<void> => {
      if (!isValidId(id)) return;
      const ids = readIndex();
      if (ids.includes(id)) writeIndex(ids.filter((listed) => listed !== id));
      erase(localEntryKey(id));
      found.delete(localEntryKey(id));
    },
  };
}
