/**
 * The Supabase-backed `ScenarioStore`, as the browser sees it: a client of the app's own
 * `/api/scenarios` routes. It never talks to Supabase tables; the session travels in the
 * same-origin cookie and the server verifies it. Every answer is parsed with zod (SEC-002), and
 * every failure is a `StoreError`.
 *
 * `getBySlug` needs no session: it is how `/s/[slug]` opens a public or unlisted scenario.
 */
import { z } from "zod";

import {
  StoreError,
  type SaveScenarioInput,
  type ScenarioStore,
  type StoredScenario,
  type StoredScenarioSummary,
} from "./types";
import {
  SCENARIOS_API_PATH,
  remoteIdSchema,
  scenarioListResponseSchema,
  scenarioResponseSchema,
  slugSchema,
  storeErrorBodySchema,
} from "./wire";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const retryAfterSchema = z
  .string()
  .regex(/^\d{1,6}$/)
  .transform(Number);

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function toStoreError(response: Response): Promise<StoreError> {
  const body = storeErrorBodySchema.safeParse(await readJson(response));
  if (!body.success) {
    return new StoreError(
      "invalid_response",
      `The server answered ${response.status} without a readable reason.`,
    );
  }
  const retryAfter = retryAfterSchema.safeParse(response.headers.get("retry-after") ?? "");
  return new StoreError(body.data.error.code, body.data.error.message, {
    issues: body.data.error.issues,
    retryAfterSeconds: retryAfter.success ? retryAfter.data : undefined,
  });
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new StoreError("invalid_response", "The server sent a scenario this app cannot read.");
}

export function createRemoteScenarioStore(fetchImpl?: FetchLike): ScenarioStore {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const send: FetchLike = fetchImpl ?? ((input, options) => globalThis.fetch(input, options));
    try {
      return await send(`${SCENARIOS_API_PATH}${path}`, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
        headers: { Accept: "application/json", ...init.headers },
      });
    } catch (error) {
      throw new StoreError("network", "The server could not be reached. Check the connection.", {
        cause: error,
      });
    }
  };

  const writeInit = (method: "POST" | "PATCH", body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  /** One scenario, or `null` for a 404. */
  const readOne = async (path: string): Promise<StoredScenario | null> => {
    const response = await call(path);
    if (response.status === 404) return null;
    if (!response.ok) throw await toStoreError(response);
    return parseBody(scenarioResponseSchema, await readJson(response)).scenario;
  };

  return {
    kind: "supabase",

    list: async (): Promise<StoredScenarioSummary[]> => {
      const response = await call("");
      if (!response.ok) throw await toStoreError(response);
      return parseBody(scenarioListResponseSchema, await readJson(response)).scenarios;
    },

    get: async (id) => (remoteIdSchema.safeParse(id).success ? readOne(`/${id}`) : null),

    getBySlug: async (slug) =>
      slugSchema.safeParse(slug).success ? readOne(`/by-slug/${slug}`) : null,

    save: async (input: SaveScenarioInput): Promise<StoredScenario> => {
      if (input.id !== undefined && !remoteIdSchema.safeParse(input.id).success) {
        throw new StoreError("not_found", "There is no such scenario.");
      }
      const body = { scenario: input.scenario, visibility: input.visibility };
      const response =
        input.id === undefined
          ? await call("", writeInit("POST", body))
          : await call(`/${input.id}`, writeInit("PATCH", body));
      if (!response.ok) throw await toStoreError(response);
      return parseBody(scenarioResponseSchema, await readJson(response)).scenario;
    },

    remove: async (id): Promise<void> => {
      if (!remoteIdSchema.safeParse(id).success) return;
      const response = await call(`/${id}`, { method: "DELETE" });
      // Already gone is what the caller wanted.
      if (response.ok || response.status === 404) return;
      throw await toStoreError(response);
    },
  };
}
