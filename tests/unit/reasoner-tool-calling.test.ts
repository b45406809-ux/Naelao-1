// Native tool calling in the reasoner — replaces "ask for JSON in prose, then regex it out".
//
// Published production figures put prompted-JSON parsing at roughly 70-85% action success vs
// 95-99% for native tool calling, and the gap is widest on the small/cheap models a free-tier
// business runs on. The reasoner now declares its five actions as real provider tools and reads a
// real tool call back, keeping the text parse ONLY as a fallback so this is strictly additive.

import { describe, it, expect } from "vitest";
import { buildUniversalBody, normalizeUniversalResponse } from "../../workers/agents/src/shared/ai-client.js";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";
import { contextWindowForModel, computeTokenCostMicro } from "../../packages/billing-core/src/index.js";

const GATEWAY = { accountId: "acct", gatewayId: "gw", aigToken: "aig-token" };
const CTX = { spaceId: "space-1" };

function bodyFor(model: string) {
  return JSON.parse(
    buildUniversalBody({
      apiKey: "k",
      gatewayOpts: GATEWAY,
      ctx: CTX,
      query: { model, max_tokens: 1500, system: "sys", messages: [{ role: "user", content: "hi" }] },
      tools: [{ name: "run", description: "Run a script", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
    })
  );
}

// The AI REST API (2026-05-21 migration) uses ONE tool schema — OpenAI's function shape — for
// every model, Workers AI and third-party alike. There is no per-provider translation any more.
describe("buildUniversalBody — tool declaration", () => {
  it("declares tools in the OpenAI function shape and forces a call", () => {
    const b = bodyFor("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(b.tools[0]).toMatchObject({ type: "function", function: { name: "run" } });
    expect(b.tools[0].function.parameters.required).toEqual(["name"]);
    // The reasoner's action space is exhaustive (answer/give_up cover every terminal case), so a
    // prose reply is never the right output — forcing a tool call is the whole point.
    expect(b.tool_choice).toBe("required");
  });

  it("uses the SAME shape for a third-party model — no per-provider branch", () => {
    const cf = bodyFor("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    const anthropic = bodyFor("anthropic/claude-sonnet-4");
    expect(anthropic.tools).toEqual(cf.tools);
    expect(anthropic.tool_choice).toBe(cf.tool_choice);
    // ...and specifically NOT Anthropic's native input_schema form, which this endpoint rejects.
    expect(anthropic.tools[0].input_schema).toBeUndefined();
  });

  it("omits tools entirely when none are declared (unchanged for non-reasoner callers)", () => {
    const body = JSON.parse(
      buildUniversalBody({
        apiKey: "k", gatewayOpts: GATEWAY, ctx: CTX,
        query: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", max_tokens: 100, system: "s", messages: [] },
      })
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe("normalizeUniversalResponse — parsing tool calls back out of each provider's shape", () => {
  it("Anthropic tool_use block", () => {
    const r = normalizeUniversalResponse({
      content: [{ type: "tool_use", name: "run", input: { name: "notifications.notify" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(r.toolCall).toEqual({ name: "run", arguments: { name: "notifications.notify" } });
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("Workers AI tool_calls WITH a null response — the real live shape", () => {
    // Verified against the live model: when it makes a tool call, `response` is null. An earlier
    // guard that required a string response would have dropped the tool call entirely.
    const r = normalizeUniversalResponse({
      result: {
        response: null,
        tool_calls: [{ name: "run", arguments: { name: "notifications.notify", params: { channel: "email" } } }],
        usage: { prompt_tokens: 259, completion_tokens: 39 },
      },
    });
    expect(r.toolCall?.name).toBe("run");
    expect(r.toolCall?.arguments).toEqual({ name: "notifications.notify", params: { channel: "email" } });
    expect(r.usage).toEqual({ input_tokens: 259, output_tokens: 39 });
  });

  it("OpenAI tool_calls, whose arguments arrive as a JSON STRING not an object", () => {
    const r = normalizeUniversalResponse({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: "answer", arguments: '{"text":"done"}' } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    expect(r.toolCall).toEqual({ name: "answer", arguments: { text: "done" } });
  });

  it("malformed tool arguments degrade to {} rather than throwing", () => {
    const r = normalizeUniversalResponse({
      choices: [{ message: { tool_calls: [{ function: { name: "answer", arguments: "{not json" } }] } }],
    });
    expect(r.toolCall).toEqual({ name: "answer", arguments: {} });
  });

  it("plain text responses still parse exactly as before (no tool call present)", () => {
    const r = normalizeUniversalResponse({ content: [{ type: "text", text: "hello" }] });
    expect(r.text).toBe("hello");
    expect(r.toolCall).toBeUndefined();
  });
});

/** Drive the real GatewayReasoner against a stubbed gateway returning `payload`. */
async function decideWith(payload: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  try {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    return await reasoner.decide({
      goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [],
    } as never);
  } finally {
    globalThis.fetch = original;
  }
}

describe("GatewayReasoner.decide — tool call preferred, text kept as fallback", () => {
  it("turns a real tool call into a decision", async () => {
    const d = await decideWith({
      result: { response: null, tool_calls: [{ name: "run", arguments: { name: "web-search.search", params: { q: "x" } } }] },
    });
    expect(d).toMatchObject({ action: "run", name: "web-search.search", params: { q: "x" } });
  });

  it("handles each declared action", async () => {
    expect(await decideWith({ content: [{ type: "tool_use", name: "answer", input: { text: "42" } }] }))
      .toMatchObject({ action: "answer", text: "42" });
    expect(await decideWith({ content: [{ type: "tool_use", name: "give_up", input: { reason: "blocked" } }] }))
      .toMatchObject({ action: "give_up", reason: "blocked" });
    expect(await decideWith({ content: [{ type: "tool_use", name: "distill", input: { name: "s", code: "export default 1" } }] }))
      .toMatchObject({ action: "distill", name: "s", code: "export default 1" });
    expect(await decideWith({ content: [{ type: "tool_use", name: "patch", input: { name: "s", code: "c", reason: "r" } }] }))
      .toMatchObject({ action: "patch", name: "s", code: "c", reason: "r" });
  });

  it("still parses prose JSON when a model ignores the tool declaration (the fallback path)", async () => {
    const d = await decideWith({
      content: [{ type: "text", text: '```json\n{"action":"answer","text":"from prose"}\n```' }],
    });
    expect(d).toMatchObject({ action: "answer", text: "from prose" });
  });

  it("rejects a tool call naming an action we never declared", async () => {
    const d = await decideWith({ content: [{ type: "tool_use", name: "delete_everything", input: {} }] });
    expect(d.action).toBe("give_up");
  });

  it("rejects a tool call missing the field that action needs, rather than passing a half-formed decision on", async () => {
    // 'run' with no script name can't do anything — better to fail with a real reason here than
    // to surface obscurely deeper in the loop.
    const d = await decideWith({ content: [{ type: "tool_use", name: "run", input: {} }] });
    expect(d.action).toBe("give_up");
    expect((d as { reason: string }).reason).toMatch(/unusable tool call/);
  });

  it("falls back to usable prose even when the tool call itself is unusable", async () => {
    const d = await decideWith({
      content: [
        { type: "tool_use", name: "run", input: {} },
        { type: "text", text: '{"action":"answer","text":"recovered"}' },
      ],
    });
    expect(d).toMatchObject({ action: "answer", text: "recovered" });
  });
});

describe("Workers AI as a selectable model — pricing and context are real, not defaults", () => {
  const M = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  it("carries its own REAL 24k context window, not the 200k default", () => {
    expect(contextWindowForModel(M)).toBe(24_000);
    expect(contextWindowForModel(M)).not.toBe(contextWindowForModel("claude-sonnet-4-6"));
  });

  it("is priced from its measured neuron cost, not the generic fallback", () => {
    const cost = computeTokenCostMicro(1_000_000, 0, M);
    const fallback = computeTokenCostMicro(1_000_000, 0, "totally-unknown-model");
    expect(cost).not.toBe(fallback);
    // ~$0.293 per 1M input tokens, in USD micros.
    expect(cost).toBeGreaterThan(280_000);
    expect(cost).toBeLessThan(310_000);
  });

  it("costs MORE than Haiku on output — a long-answer workload is not automatically cheaper", () => {
    expect(computeTokenCostMicro(0, 1_000_000, M)).toBeGreaterThan(
      computeTokenCostMicro(0, 1_000_000, "claude-haiku-4-5-20251001")
    );
  });
});
