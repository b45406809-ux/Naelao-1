import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKING_MODEL,
  OPENROUTER_WORKING_MODEL,
} from "@naelao/billing-core";
import {
  resolveWorkerModel,
  selectWorkerModel,
  isWorkerPriceAllowed,
  mayDiscoverWorkerModelCatalog,
  isCloudModelForbiddenOnPrivateRoute,
  validateWorkerModelRequirements,
  workerModelMeetsRequirements,
  type WorkerModelCard,
} from "./worker-model-routing.js";

describe("automatic worker model routing", () => {
  it("never calls the external model catalog for private or local runs", () => {
    expect(
      mayDiscoverWorkerModelCatalog({
        privateRoute: true,
        hasPool: true,
        hasCredential: true,
      })
    ).toBe(false);
    expect(
      mayDiscoverWorkerModelCatalog({
        privateRoute: false,
        hasPool: false,
        hasCredential: true,
      })
    ).toBe(false);
    expect(
      mayDiscoverWorkerModelCatalog({
        privateRoute: false,
        hasPool: true,
        hasCredential: false,
      })
    ).toBe(false);
    expect(
      mayDiscoverWorkerModelCatalog({
        privateRoute: false,
        hasPool: true,
        hasCredential: true,
      })
    ).toBe(true);
  });
  it("rejects cloud model IDs before credentials and pricing on a private route", () => {
    expect(
      isCloudModelForbiddenOnPrivateRoute("openrouter/vendor/model", true)
    ).toBe(true);
    expect(isCloudModelForbiddenOnPrivateRoute("anthropic/claude", true)).toBe(
      true
    );
    expect(isCloudModelForbiddenOnPrivateRoute("local/qwen", true)).toBe(false);
    expect(
      isCloudModelForbiddenOnPrivateRoute("openrouter/vendor/model", false)
    ).toBe(false);
  });
  it("rejects missing or increased live prices for the pinned economy worker", () => {
    expect(isWorkerPriceAllowed(OPENROUTER_WORKING_MODEL, undefined)).toBe(
      false
    );
    expect(
      isWorkerPriceAllowed(OPENROUTER_WORKING_MODEL, {
        inputUsdPerToken: 0.05 / 1_000_000,
        outputUsdPerToken: 0.6 / 1_000_000,
      })
    ).toBe(true);
    expect(
      isWorkerPriceAllowed(OPENROUTER_WORKING_MODEL, {
        inputUsdPerToken: 1 / 1_000_000,
        outputUsdPerToken: 3 / 1_000_000,
      })
    ).toBe(false);
  });
  it("chooses the economy DeepSeek snapshot for an OpenRouter worker without switching payer/provider", () => {
    expect(
      resolveWorkerModel({
        plannerModel: "openrouter/vendor/expensive-planner",
        effort: "low",
        contextAffinity: "shared",
      }).model
    ).toBe(OPENROUTER_WORKING_MODEL);
  });
  it("rejects a System One suggestion outside its host-filtered effort candidates", async () => {
    const result = await selectWorkerModel(
      {
        plannerModel: "claude-sonnet-4-6",
        effort: "medium",
        contextAffinity: "isolated",
        goal: "simple lookup",
      },
      {
        choice: async () =>
          ({
            kind: "choice",
            value: "claude-opus-4-8",
            provider: "openrouter",
            policyCode: "test",
          }) as never,
      }
    );
    expect(result.model).toBe(DEFAULT_WORKING_MODEL);
  });
  it("keeps state-tethered work on the planner's verified model within the effort ceiling", () => {
    expect(
      resolveWorkerModel({
        plannerModel: DEFAULT_WORKING_MODEL,
        contextAffinity: "shared",
        effort: "medium",
      })
    ).toMatchObject({ model: DEFAULT_WORKING_MODEL, downgraded: false });
  });

  it("routes isolated work to the known platform model, not a planner-authored model id", () => {
    expect(
      resolveWorkerModel({
        plannerModel: "openai/gpt-6-luna",
        contextAffinity: "isolated",
        effort: "ultra",
      })
    ).toMatchObject({ model: DEFAULT_WORKING_MODEL, downgraded: false });
  });

  it("reduces a costly shared-context model when the selected effort ceiling is low", () => {
    const result = resolveWorkerModel({
      plannerModel: "claude-opus-4-8",
      contextAffinity: "shared",
      effort: "low",
    });
    expect(result.downgraded).toBe(true);
    expect(result.model).not.toBe("claude-opus-4-8");
  });

  it("retains local and private routes rather than falling back to cloud", () => {
    expect(
      resolveWorkerModel({
        plannerModel: "local/qwen-coder",
        contextAffinity: "isolated",
        effort: "low",
      })
    ).toMatchObject({
      model: "local/qwen-coder",
      downgraded: false,
    });
    expect(
      resolveWorkerModel({
        plannerModel: "openrouter/vendor/model",
        contextAffinity: "isolated",
        effort: "low",
        privateRoute: true,
      })
    ).toMatchObject({
      model: "openrouter/vendor/model",
      downgraded: false,
    });
  });
  const cards: WorkerModelCard[] = [
    {
      model: "openrouter/vendor/text",
      name: "Text",
      contextLength: 128000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
      promptPriceUsdPerToken: 0,
      completionPriceUsdPerToken: 0,
      catalogObservedAt: new Date().toISOString(),
    },
    {
      model: "openrouter/vendor/vision",
      name: "Vision",
      contextLength: 128000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
      promptPriceUsdPerToken: 0.02 / 1000000,
      completionPriceUsdPerToken: 0.5 / 1000000,
      catalogObservedAt: new Date().toISOString(),
    },
  ];
  const requirements = validateWorkerModelRequirements({
    inputModalities: ["image"],
    minContextTokens: 16000,
  })!;
  const visualInput = {
    plannerModel: "openrouter/vendor/planner",
    contextAffinity: "isolated" as const,
    effort: "low" as const,
    goal: "Read a browser screenshot",
    workerModelPool: {
      modelIds: cards.map((c) => c.model),
      selectionMode: "automatic" as const,
    },
    workerModelCandidates: cards,
    requirements,
  };
  it("selects the existing image-capable model instead of adding models or choosing a cheaper text-only model", async () => {
    const choice = async () => {
      throw new Error("not needed for one eligible model");
    };
    expect((await selectWorkerModel(visualInput, { choice })).model).toBe(
      cards[1]!.model
    );
    expect((await selectWorkerModel(visualInput)).model).toBe(cards[1]!.model);
  });
  it("rejects stale, sparse and insufficient-capacity cards rather than guessing from model names", () => {
    expect(workerModelMeetsRequirements(cards[0], requirements)).toBe(false);
    expect(
      workerModelMeetsRequirements(
        {
          ...cards[1]!,
          catalogObservedAt: new Date(Date.now() - 16 * 60000).toISOString(),
        },
        requirements
      )
    ).toBe(false);
    expect(
      workerModelMeetsRequirements(
        { ...cards[1]!, inputModalities: [] },
        requirements
      )
    ).toBe(false);
    expect(
      workerModelMeetsRequirements(
        { ...cards[1]!, supportedParameters: [] },
        requirements
      )
    ).toBe(false);
    expect(
      workerModelMeetsRequirements(
        { ...cards[1]!, contextLength: 8000 },
        requirements
      )
    ).toBe(false);
  });
  it("reports a capability gap within the configured price-filtered pool, never escapes to a frontier model", async () => {
    await expect(
      selectWorkerModel({
        ...visualInput,
        requirements: {
          inputModalities: ["text", "video"],
          minContextTokens: 16000,
        },
      })
    ).rejects.toThrow("capability_unavailable");
    await expect(
      selectWorkerModel({ ...visualInput, workerModelCandidates: [cards[0]!] })
    ).rejects.toThrow("capability_unavailable");
  });
  it("rejects a planner-selected model that does not support the task media", async () => {
    await expect(
      selectWorkerModel({
        ...visualInput,
        workerModelPool: {
          ...visualInput.workerModelPool,
          selectionMode: "planner",
        },
        requestedWorkerModel: cards[0]!.model,
      })
    ).rejects.toThrow("lacks_required_capability");
  });
  it("does not use a remote decider or catalog to solve private-route capability gaps", async () => {
    expect(
      (
        await selectWorkerModel({
          ...visualInput,
          plannerModel: "local/model",
          privateRoute: true,
        })
      ).model
    ).toBe("local/model");
  });
  it("bounds requirements and rejects unsupported modalities", () => {
    for (const value of [
      null,
      { inputModalities: [], minContextTokens: 16000 },
      { inputModalities: ["computer"], minContextTokens: 16000 },
      { inputModalities: ["image"], minContextTokens: 2000001 },
    ])
      expect(() => validateWorkerModelRequirements(value)).toThrow(
        "invalid_worker_model_requirements"
      );
    expect(requirements.inputModalities).toEqual(["text", "image"]);
  });
});
