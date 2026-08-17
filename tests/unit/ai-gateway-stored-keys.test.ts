import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";
import {
  buildUniversalBody,
  universalGatewayUrl,
  universalGatewayHeaders,
  canAuthenticateLlm,
} from "../../workers/agents/src/shared/ai-client.js";
import { callLlm, resolveAnthropicEndpoint } from "../../packages/llm-gateway/src/gateway.js";
import type { ObserveSnapshot } from "../../workers/agents/src/script-engine/types.js";

// Vendor cutover: the CF AI Gateway can hold the Anthropic key itself (Authenticated Gateway /
// BYOK). A deployment sets NAELAO_AIG_TOKEN instead of ANTHROPIC_API_KEY; the gateway token
// travels as the cf-aig-authorization header and the gateway injects the real provider key, so
// the worker never sends one. These tests lock in: (1) the token becomes a header, not body;
// (2) an empty provider apiKey omits the x-api-key/Authorization header rather than blanking it;
// (3) the callLlm path routes through the gateway URL; (4) honest failure when neither is set.

const AIG = "aig-token-abc";

describe("universalGatewayHeaders — gateway auth travels as a header", () => {
  it("adds cf-aig-authorization when aigToken is set", () => {
    const h = universalGatewayHeaders({ accountId: "acct", gatewayId: "gw", aigToken: AIG });
    expect(h["cf-aig-authorization"]).toBe(`Bearer ${AIG}`);
    expect(h["content-type"]).toBe("application/json");
  });
  it("omits it when no aigToken", () => {
    const h = universalGatewayHeaders({ accountId: "acct", gatewayId: "gw" });
    expect(h["cf-aig-authorization"]).toBeUndefined();
  });
});

describe("canAuthenticateLlm", () => {
  it("true when the gateway holds the key (aigToken), even with no provider apiKey", () => {
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g", aigToken: AIG }, "")).toBe(true);
  });
  it("true when a provider apiKey is supplied directly", () => {
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g" }, "sk-ant-real")).toBe(true);
  });
  it("true when only the CF API token is set (the AI REST API's own credential)", () => {
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g", cfApiToken: "cf-token" }, "")).toBe(true);
  });
  it("false when none is configured", () => {
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g" }, "")).toBe(false);
  });
});

// AI Gateway migrated (2026-05-21) to the AI REST API: one flat, OpenAI-shaped body against
// /ai/v1/chat/completions, with the Cloudflare API token as the credential. The per-provider
// request translation these tests used to assert (an ordered `providers` array with an
// Anthropic-style x-api-key header per entry) no longer exists — the old endpoint returns 401 and
// the old body shape returns {"code":2008,"message":"Invalid provider"}, both confirmed live.
describe("buildUniversalBody — flat OpenAI-shaped body for the AI REST API", () => {
  const base = {
    gatewayOpts: { accountId: "a", gatewayId: "g", aigToken: AIG },
    ctx: { spaceId: "s1" },
    query: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", max_tokens: 100, system: "sys", messages: [{ role: "user", content: "hi" }] },
  };

  it("sends model/messages/max_tokens flat — never a providers array", () => {
    const body = JSON.parse(buildUniversalBody({ apiKey: "", ...base }));
    expect(body.providers).toBeUndefined();
    expect(body.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(body.max_tokens).toBe(100);
  });

  it("prepends the system prompt as a system message", () => {
    const body = JSON.parse(buildUniversalBody({ apiKey: "", ...base }));
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("never puts any credential in the BODY — auth is header-only", () => {
    const body = JSON.parse(buildUniversalBody({ apiKey: "sk-ant-real", cfApiToken: "cf-token", ...base }));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("sk-ant-real");
    expect(serialized).not.toContain("cf-token");
    expect(serialized).not.toContain(AIG);
  });
});

describe("universalGatewayUrl / headers — the AI REST API contract", () => {
  it("targets the account's /ai/v1/chat/completions endpoint", () => {
    expect(universalGatewayUrl({ accountId: "acct-1", gatewayId: "gw" })).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions"
    );
  });

  it("authenticates with the CF API token and routes through OUR named gateway", () => {
    const h = universalGatewayHeaders({ accountId: "a", gatewayId: "naelao-gateway", cfApiToken: "cf-token" });
    expect(h["authorization"]).toBe("Bearer cf-token");
    // Without this the call silently uses the account's DEFAULT gateway, losing our logging,
    // caching and rate-limiting config.
    expect(h["cf-aig-gateway-id"]).toBe("naelao-gateway");
  });
});

describe("resolveAnthropicEndpoint (callLlm path)", () => {
  it("routes through the CF AI Gateway anthropic endpoint when a real account is configured", () => {
    const r = resolveAnthropicEndpoint({ accountId: "acct-1", gatewayId: "naelao-gateway", aigToken: AIG });
    expect(r.url).toBe("https://gateway.ai.cloudflare.com/v1/acct-1/naelao-gateway/anthropic/v1/messages");
    expect(r.headers["cf-aig-authorization"]).toBe(`Bearer ${AIG}`);
  });
  it("falls back to calling Anthropic directly when account is the placeholder default", () => {
    const r = resolveAnthropicEndpoint({ accountId: "placeholder", gatewayId: "naelao-gateway" });
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.headers["cf-aig-authorization"]).toBeUndefined();
  });
  it("falls back to Anthropic directly when no gateway config at all", () => {
    expect(resolveAnthropicEndpoint().url).toBe("https://api.anthropic.com/v1/messages");
  });
});

describe("callLlm — gateway routing + stored-key auth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hits the gateway URL with cf-aig-authorization and NO x-api-key when only aigToken is set", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }));
    await callLlm(
      "", // no provider key
      { model: "claude-haiku-4-5-20251001", system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], max_tokens: 50 },
      undefined,
      { accountId: "acct-1", gatewayId: "naelao-gateway", aigToken: AIG }
    );
    expect(capturedUrl).toContain("gateway.ai.cloudflare.com/v1/acct-1/naelao-gateway/anthropic");
    expect(capturedHeaders["cf-aig-authorization"]).toBe(`Bearer ${AIG}`);
    expect(capturedHeaders["x-api-key"]).toBeUndefined();
  });

  it("throws a clear no_llm_credentials error when neither a key nor a gateway token is set", async () => {
    await expect(
      callLlm("", { model: "claude-haiku-4-5-20251001", system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], max_tokens: 50 })
    ).rejects.toMatchObject({ code: "no_llm_credentials" });
  });
});

describe("GatewayReasoner — gives up honestly when it cannot authenticate", () => {
  const SNAPSHOT: ObserveSnapshot = { type: "compute", timestamp: Date.now(), fingerprint: "fp1" };
  const input = { goal: "g", level: "L2" as const, snapshot: SNAPSHOT, candidates: [], availableOperations: ["script.run"] };

  it("no provider key AND no gateway token → give_up without firing a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const reasoner = new GatewayReasoner({
      apiKey: "",
      gateway: { accountId: "acct", gatewayId: "gw" }, // no aigToken
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(input);
    expect(decision.action).toBe("give_up");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("gateway token present → proceeds to fire the request (no local key needed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ action: "answer", text: "done" }) }],
      usage: { input_tokens: 5, output_tokens: 5 },
    }), { status: 200 })));
    const reasoner = new GatewayReasoner({
      apiKey: "",
      gateway: { accountId: "acct", gatewayId: "gw", aigToken: AIG },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(input);
    expect(decision).toEqual({ action: "answer", text: "done" });
    vi.restoreAllMocks();
  });
});
