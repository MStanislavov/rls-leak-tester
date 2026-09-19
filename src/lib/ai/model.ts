/**
 * The one module that names a Claude model (rules.yaml AI-001). The model id is part of the
 * explanation cache key, so the override variable, the cache and the documentation all read it
 * from here.
 *
 * `ANTHROPIC_MODEL` overrides the default. It arrives already parsed, through `src/lib/config`
 * (ARCH-002): this module never reads the environment. Cheaper overrides that work with the same
 * request: `claude-sonnet-5` and `claude-haiku-4-5`.
 *
 * The request deliberately sets no `thinking` and no `effort`: the default model thinks
 * adaptively when the parameter is omitted, and the cheapest override rejects `effort`, so
 * leaving both out is the one shape every override accepts.
 */
import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { LanguageModel, streamText } from "ai";

/** The most capable current model that suits a streaming, user-facing answer. */
export const DEFAULT_MODEL_ID = "claude-opus-5";

/**
 * Ceiling of one answer, thinking included. The object is small (see `schema.ts`); the ceiling is
 * a cost cap on a public endpoint. A truncated answer fails validation and is never cached.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

export interface ModelConfig {
  readonly anthropicApiKey: string | undefined;
  /** `ANTHROPIC_MODEL`, already validated by `src/lib/config`. */
  readonly anthropicModel: string | undefined;
}

/** Pure: the override when there is one, else the default. */
export function resolveModelId(config: Pick<ModelConfig, "anthropicModel">): string {
  return config.anthropicModel ?? DEFAULT_MODEL_ID;
}

type StreamTextProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

/**
 * Pure: provider options for a model id. Policy SQL is security-adjacent text, so the default
 * model may answer with a safety refusal; `fallbacks: "default"` lets the API retry that turn on
 * its recommended fallback model inside the same call. An override gets no fallback chain: which
 * models accept the parameter is not something this module can know for an arbitrary id.
 */
export function modelProviderOptions(modelId: string): StreamTextProviderOptions {
  if (modelId !== DEFAULT_MODEL_ID) {
    return {};
  }
  return { anthropic: { fallbacks: "default" } satisfies AnthropicLanguageModelOptions };
}

/** The provider model, or `undefined` without an API key (the feature is then off). */
export function createExplainModel(config: ModelConfig): LanguageModel | undefined {
  if (config.anthropicApiKey === undefined) {
    return undefined;
  }
  const provider = createAnthropic({ apiKey: config.anthropicApiKey });
  return provider(resolveModelId(config));
}
