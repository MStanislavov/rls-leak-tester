import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ID,
  MAX_OUTPUT_TOKENS,
  createExplainModel,
  modelProviderOptions,
  resolveModelId,
} from "./model";

describe("the model id", () => {
  it("defaults, and ANTHROPIC_MODEL overrides it", () => {
    expect(resolveModelId({ anthropicModel: undefined })).toBe(DEFAULT_MODEL_ID);
    expect(resolveModelId({ anthropicModel: "another-model" })).toBe("another-model");
  });

  it("asks for a server-side fallback on the default model only", () => {
    expect(modelProviderOptions(DEFAULT_MODEL_ID)).toEqual({ anthropic: { fallbacks: "default" } });
    expect(modelProviderOptions("another-model")).toEqual({});
  });

  it("caps the answer", () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4_000);
    expect(MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(64_000);
  });
});

describe("createExplainModel", () => {
  it("gives no model without an API key", () => {
    expect(
      createExplainModel({ anthropicApiKey: undefined, anthropicModel: undefined }),
    ).toBeUndefined();
  });

  it("builds the provider model for the resolved id without calling anything", () => {
    const model = createExplainModel({ anthropicApiKey: "test-key", anthropicModel: "some-model" });

    expect(model).toMatchObject({ modelId: "some-model", provider: "anthropic.messages" });
    expect(
      createExplainModel({ anthropicApiKey: "test-key", anthropicModel: undefined }),
    ).toMatchObject({ modelId: DEFAULT_MODEL_ID });
  });
});
