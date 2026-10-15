import { describe, expect, it } from "vitest";
import {
  byokKeyFieldForModel,
  byokProviderForModel,
  canAuthenticateLlm,
  compatGatewayHeaders,
  compatGatewayUrl,
  compatProviderModelId,
  isCompatProviderModel,
  isOpenRouterModel,
  type GatewayOpts,
} from "./ai-client";

const gateway: GatewayOpts = { accountId: "account", gatewayId: "gateway", openRouterApiKey: "or-secret", aigToken: "gateway-secret" };

describe("OpenRouter BYOK routing", () => {
  it("maps the model prefix to the Space-owned key without rewriting provider model ids", () => {
    expect(byokKeyFieldForModel("openrouter/vendor/model-id")).toBe("openRouterApiKey");
    expect(byokProviderForModel("openrouter/vendor/model-id")).toBe("openrouter");
    expect(isCompatProviderModel("openrouter/vendor/model-id")).toBe(true);
    expect(isOpenRouterModel("openrouter/vendor/model-id")).toBe(true);
    expect(compatProviderModelId("openrouter/vendor/model-id")).toBe("openrouter/vendor/model-id");
  });

  it("requires the OpenRouter credential and uses the existing compat gateway auth boundary", () => {
    expect(canAuthenticateLlm({ accountId: "account", gatewayId: "gateway", cfApiToken: "cf-token" }, "", "openrouter/vendor/model-id")).toBe(false);
    expect(canAuthenticateLlm(gateway, "", "openrouter/vendor/model-id")).toBe(true);
    expect(compatGatewayUrl(gateway)).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions");
    expect(compatGatewayHeaders(gateway, "openrouter/vendor/model-id")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer or-secret",
      "cf-aig-authorization": "Bearer gateway-secret",
      "cf-aig-no-wholesale": "true",
    });
  });
});
