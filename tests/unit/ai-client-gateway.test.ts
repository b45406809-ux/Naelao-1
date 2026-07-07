import { describe, it, expect } from "vitest";
import {
  gatewayUrl,
  gatewayHeaders,
  resolveAnthropicUrl,
  resolveAnthropicHeaders,
  buildPlatformLLMConfig,
} from "../../workers/agents/src/shared/ai-client.js";

// Cloudflare AI Gateway follow-up: this module was fully built (spec §15 — every LLM call
// routes through CF AI Gateway for per-tenant analytics, caching, and fallback routing) but had
// zero test coverage, and the wrangler.toml wiring that supplies its accountId/gatewayId had a
// real bug (staging/production silently dropped NAELAO_ACCOUNT_ID/NAELAO_GATEWAY_ID — see that
// file's own comment) that meant this code path never actually activated in any real
// deployment. These tests lock in the pure resolution logic itself.

describe("ai-client — Cloudflare AI Gateway resolution", () => {
  it("builds the documented CF AI Gateway URL shape for a real account/gateway id", () => {
    const url = gatewayUrl({ accountId: "abc123", gatewayId: "naelao-gateway" });
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/abc123/naelao-gateway/anthropic/v1/messages");
  });

  it("resolves to the gateway URL when a real (non-placeholder) accountId is configured", () => {
    const url = resolveAnthropicUrl({ accountId: "abc123", gatewayId: "naelao-gateway" });
    expect(url).toContain("gateway.ai.cloudflare.com");
  });

  it("degrades to the direct Anthropic API when accountId is the placeholder default", () => {
    const url = resolveAnthropicUrl({ accountId: "placeholder", gatewayId: "naelao-gateway" });
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("degrades to the direct Anthropic API when accountId is empty/unset", () => {
    const url = resolveAnthropicUrl({ accountId: "", gatewayId: "naelao-gateway" });
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("gateway headers carry cf-aig-metadata for per-tenant analytics and set cache TTL", () => {
    const headers = gatewayHeaders("sk-test-key", { spaceId: "space-1", agentId: "naelao-agent" });
    expect(headers["x-api-key"]).toBe("sk-test-key");
    expect(headers["cf-aig-cache-ttl"]).toBe("3600");
    const metadata = JSON.parse(headers["cf-aig-metadata"]!) as Record<string, string>;
    expect(metadata.spaceId).toBe("space-1");
    expect(metadata.agentId).toBe("naelao-agent");
  });

  it("skipCache disables gateway caching for real-time conversational calls (cache-ttl=0)", () => {
    const headers = gatewayHeaders("sk-test-key", { spaceId: "space-1", skipCache: true });
    expect(headers["cf-aig-cache-ttl"]).toBe("0");
  });

  it("direct-API headers (placeholder account) carry no gateway-specific headers at all", () => {
    const headers = resolveAnthropicHeaders("sk-test-key", { accountId: "placeholder", gatewayId: "naelao-gateway" }, { spaceId: "space-1" });
    expect(headers["cf-aig-metadata"]).toBeUndefined();
    expect(headers["cf-aig-cache-ttl"]).toBeUndefined();
    expect(headers["x-api-key"]).toBe("sk-test-key");
  });

  it("buildPlatformLLMConfig wires url+headers consistently for a real gateway config", () => {
    const cfg = buildPlatformLLMConfig("sk-test-key", { accountId: "abc123", gatewayId: "naelao-gateway" }, { spaceId: "space-1" });
    expect(cfg.provider).toBe("platform");
    expect(cfg.url).toContain("gateway.ai.cloudflare.com");
    expect(cfg.headers["cf-aig-metadata"]).toBeDefined();
  });
});
