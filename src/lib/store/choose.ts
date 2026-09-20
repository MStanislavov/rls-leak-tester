/**
 * Which store the lab saves to: the Supabase-backed one when it is configured AND somebody is
 * signed in, the browser's `localStorage` in every other case (brief 3.10, P4).
 */
import type { PublicConfig } from "@/lib/config/env";
import { getPublicConfig } from "@/lib/config/public";

import { getAuthClient, type AuthClient } from "./auth-client";
import { createLocalScenarioStore } from "./local";
import { createRemoteScenarioStore } from "./remote";
import type { ScenarioStore } from "./types";

export interface ScenarioStoreChoice {
  config?: Pick<PublicConfig, "supabaseEnabled"> | undefined;
  auth?: Pick<AuthClient, "getUser"> | undefined;
  local?: (() => ScenarioStore) | undefined;
  remote?: (() => ScenarioStore) | undefined;
}

/** Never throws: when the session cannot be read the answer is the local store. */
export async function getScenarioStore(choice: ScenarioStoreChoice = {}): Promise<ScenarioStore> {
  const local = choice.local ?? (() => createLocalScenarioStore());
  const config = choice.config ?? getPublicConfig();
  if (!config.supabaseEnabled) return local();
  try {
    const user = await (choice.auth ?? getAuthClient()).getUser();
    if (user === null) return local();
  } catch {
    return local();
  }
  return (choice.remote ?? (() => createRemoteScenarioStore()))();
}
