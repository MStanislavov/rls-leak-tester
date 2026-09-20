/**
 * What the scenarios API does, without HTTP: list, read, create, update, remove. The caller has
 * already verified the session (`userId` comes from `auth.getUser()`, never from the request);
 * the repository runs under that user's JWT, so row level security is the second line of
 * defence behind the explicit owner filters here.
 *
 * Shared scenarios are read through a cache by slug (brief 4.5, use 4). Only rows that anybody
 * with the slug may read are cached (`public`, `unlisted`): a private row is never written to
 * the shared cache. The cache never holds whose row it is: the database does not tell
 * (`get_scenario_by_slug` returns `is_owner`, not the owner id), and `ownedByMe` is answered per
 * request, for a signed-in caller of a cached row by a query without the payload.
 *
 * Invalidation. A write through this module, AFTER the database accepted it, first sets a
 * "changed" marker for the slug and then deletes the entry. A reader that loaded the row before
 * the write and fills the cache after the delete would otherwise bring the old row back for a
 * whole TTL, which matters when the owner just made the scenario private or deleted it. So a
 * reader caches nothing while the marker exists, and looks for the marker once more AFTER its
 * own cache write, deleting what it wrote when the marker appeared in between. Whatever the
 * interleaving, either the writer's delete or the reader's own removes the old row. The marker
 * lives as long as an entry would (`SCENARIO_CACHE_TTL_SECONDS`), far longer than a load takes.
 * A change made directly through PostgREST is not seen here; it shows after at most that TTL.
 */
import { z } from "zod";

import {
  SCENARIO_CACHE_TTL_SECONDS,
  isRedisUnavailable,
  readThrough,
  type Cache,
  type KeyBuilder,
  type RedisKey,
  type RedisUnavailableError,
} from "@/lib/redis";
import { createScenarioId, randomIdSuffix, type FillRandom } from "@/lib/scenario";

import { StoreError, type StoredScenario, type StoredScenarioSummary } from "../types";
import { remoteIdSchema, scenarioFieldSchema, slugSchema } from "../wire";
import type { CreateScenarioInput, UpdateScenarioInput } from "./body";
import { SLUG_MAX_ATTEMPTS, SLUG_SUFFIX_LENGTH, UNAVAILABLE_RETRY_AFTER_SECONDS } from "./policy";
import type {
  ScenarioRepository,
  ScenarioRow,
  ScenarioRowPatch,
  SharedScenarioRow,
} from "./repository";

export interface ScenarioServiceDeps {
  readonly repository: ScenarioRepository;
  readonly cache: Cache;
  readonly keys: KeyBuilder;
  readonly fillRandom?: FillRandom;
  /** Told when the cache is down. The request goes on without it. */
  readonly onCacheUnavailable?: (error: RedisUnavailableError) => void;
}

/** What the shared cache holds: never a private row, never whose row it is. */
const cachedRowSchema = z.object({
  id: remoteIdSchema,
  slug: slugSchema,
  title: z.string().min(1),
  visibility: z.enum(["public", "unlisted"]),
  updatedAt: z.iso.datetime(),
  scenario: scenarioFieldSchema,
});

type CachedRow = z.infer<typeof cachedRowSchema>;

function parseCachedRow(text: string | undefined): CachedRow | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = cachedRowSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(row: Omit<ScenarioRow, "scenario" | "owner">): StoredScenarioSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    visibility: row.visibility,
    updatedAt: row.updatedAt,
  };
}

function toStored(row: ScenarioRow, userId: string | undefined): StoredScenario {
  return { ...toSummary(row), scenario: row.scenario, ownedByMe: row.owner === userId };
}

/** The key of the "changed" marker of a slug. The dot keeps it apart from every slug's own key. */
function changedKey(deps: ScenarioServiceDeps, slug: string): RedisKey {
  return deps.keys.build("scenario", `${slug}.changed`);
}

/** `<slug of the title>-<80 random bits>`: valid for the check constraint, not guessable. */
export function newSlug(title: string, fillRandom?: FillRandom): string {
  return createScenarioId(title, randomIdSuffix(SLUG_SUFFIX_LENGTH, fillRandom));
}

/** After a write: the marker first, then the delete (see the header). Each step fails open. */
async function invalidate(deps: ScenarioServiceDeps, slug: string): Promise<void> {
  const steps = [
    () => deps.cache.set(changedKey(deps, slug), "1", SCENARIO_CACHE_TTL_SECONDS),
    () => deps.cache.delete(deps.keys.scenario(slug)),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!isRedisUnavailable(error)) throw error;
      deps.onCacheUnavailable?.(error);
    }
  }
}

/** Fills the cache unless the slug changed recently, and takes the entry back if it just did. */
async function cacheShared(deps: ScenarioServiceDeps, row: SharedScenarioRow): Promise<void> {
  if (row.visibility === "private") return;
  const key = deps.keys.scenario(row.slug);
  const marker = changedKey(deps, row.slug);
  if ((await deps.cache.get(marker)) !== undefined) return;
  // Field by field: whose row it is (`isOwner` is the loader's answer) never enters the cache.
  const shared: CachedRow = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    visibility: row.visibility,
    updatedAt: row.updatedAt,
    scenario: row.scenario,
  };
  await deps.cache.set(key, JSON.stringify(shared), SCENARIO_CACHE_TTL_SECONDS);
  if ((await deps.cache.get(marker)) !== undefined) await deps.cache.delete(key);
}

export async function listMine(
  deps: ScenarioServiceDeps,
  userId: string,
): Promise<StoredScenarioSummary[]> {
  return (await deps.repository.listByOwner(userId)).map(toSummary);
}

/** The caller's own scenario or a public one. Not cached: this is the owner's editing path. */
export async function getById(
  deps: ScenarioServiceDeps,
  id: string,
  userId: string | undefined,
): Promise<StoredScenario | undefined> {
  const row = await deps.repository.findById(id);
  return row === undefined ? undefined : toStored(row, userId);
}

/** A public or unlisted scenario by its exact slug, or the caller's own private one. */
export async function getBySlug(
  deps: ScenarioServiceDeps,
  slug: string,
  userId: string | undefined,
): Promise<StoredScenario | undefined> {
  const key = deps.keys.scenario(slug);
  let loaded: SharedScenarioRow | undefined;
  const row = await readThrough<CachedRow | SharedScenarioRow>({
    read: async () => parseCachedRow(await deps.cache.get(key)),
    load: async () => {
      loaded = await deps.repository.findBySlug(slug);
      return loaded;
    },
    store: async () => {
      if (loaded !== undefined) await cacheShared(deps, loaded);
    },
    onUnavailable: deps.onCacheUnavailable,
  });
  if (row === undefined) return undefined;
  const ownedByMe =
    loaded?.isOwner ?? (userId !== undefined && (await deps.repository.ownerOf(row.id)) === userId);
  return { ...toSummary(row), scenario: row.scenario, ownedByMe };
}

export async function create(
  deps: ScenarioServiceDeps,
  userId: string,
  input: CreateScenarioInput,
): Promise<StoredScenario> {
  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt += 1) {
    const slug = newSlug(input.scenario.title, deps.fillRandom);
    const row = await deps.repository.insert({
      slug,
      title: input.scenario.title,
      scenario: input.scenario,
      visibility: input.visibility,
    });
    if (row !== "slug-taken") {
      await invalidate(deps, row.slug);
      return toStored(row, userId);
    }
  }
  throw new StoreError("unavailable", "No free link was found for the scenario. Try again.", {
    retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
  });
}

/** A write that reached no row: the row is not the caller's (`forbidden`) or not visible at all. */
async function refusal(deps: ScenarioServiceDeps, id: string, userId: string): Promise<StoreError> {
  const owner = await deps.repository.ownerOf(id);
  return owner === undefined || owner === userId
    ? new StoreError("not_found", "There is no such scenario.")
    : new StoreError("forbidden", "Only the owner can change or delete this scenario.");
}

export async function update(
  deps: ScenarioServiceDeps,
  userId: string,
  id: string,
  input: UpdateScenarioInput,
): Promise<StoredScenario> {
  const patch: ScenarioRowPatch = {};
  if (input.scenario !== undefined) {
    patch.scenario = input.scenario;
    patch.title = input.scenario.title;
  }
  if (input.visibility !== undefined) patch.visibility = input.visibility;

  const row = await deps.repository.update(id, userId, patch);
  if (row === undefined) throw await refusal(deps, id, userId);
  await invalidate(deps, row.slug);
  return toStored(row, userId);
}

export async function remove(deps: ScenarioServiceDeps, userId: string, id: string): Promise<void> {
  const slug = await deps.repository.remove(id, userId);
  if (slug === undefined) throw await refusal(deps, id, userId);
  await invalidate(deps, slug);
}
