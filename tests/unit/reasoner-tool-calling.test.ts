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

// Model switcher capability config (billing-core's MODEL_CAPABILITIES) — a chosen reasoning level
// gets wired into the actual request body differently per model family; see that file's own doc
// header for what's confirmed vs. inferred.
describe("buildUniversalBody — reasoning-effort/thinking wiring", () => {
  it("sends a plain reasoning_effort field for the reasoning_effort shape", () => {
    const body = JSON.parse(
      buildUniversalBody({
        apiKey: "k", gatewayOpts: GATEWAY, ctx: CTX,
        query: { model: "@cf/openai/gpt-oss-120b", max_tokens: 100, system: "s", messages: [] },
        reasoning: { param: "reasoning_effort", level: "high" },
      })
    );
    expect(body.reasoning_effort).toBe("high");
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it("sends chat_template_kwargs.thinking as a boolean for the kimi_thinking shape", () => {
    const on = JSON.parse(
      buildUniversalBody({
        apiKey: "k", gatewayOpts: GATEWAY, ctx: CTX,
        query: { model: "@cf/moonshotai/kimi-k2.6", max_tokens: 100, system: "s", messages: [] },
        reasoning: { param: "kimi_thinking", level: "on" },
      })
    );
    expect(on.chat_template_kwargs).toEqual({ thinking: true });
    expect(on.reasoning_effort).toBeUndefined();

    const off = JSON.parse(
      buildUniversalBody({
        apiKey: "k", gatewayOpts: GATEWAY, ctx: CTX,
        query: { model: "@cf/moonshotai/kimi-k2.6", max_tokens: 100, system: "s", messages: [] },
        reasoning: { param: "kimi_thinking", level: "off" },
      })
    );
    expect(off.chat_template_kwargs).toEqual({ thinking: false });
  });

  it("sends nothing reasoning-related when no reasoning option is given (unchanged for every non-reasoning-capable model)", () => {
    const body = JSON.parse(
      buildUniversalBody({
        apiKey: "k", gatewayOpts: GATEWAY, ctx: CTX,
        query: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", max_tokens: 100, system: "s", messages: [] },
      })
    );
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
  });
});

describe("normalizeUniversalResponse — a reasoning-capable model's chain-of-thought", () => {
  it("captures `thinking` from the OpenAI-shaped choices[].message.reasoning field", () => {
    const r = normalizeUniversalResponse({
      choices: [{ message: { content: "4", reasoning: "2+2 is a basic addition." } }],
    });
    expect(r.thinking).toBe("2+2 is a basic addition.");
  });

  it("prefers the fuller `reasoning` field over `reasoning_content` when a model sends both — the real captured gpt-oss-120b payload below shows this happens", () => {
    const r = normalizeUniversalResponse({
      choices: [{
        message: {
          content: null,
          reasoning: "User asks what is 2+2. Use the answer function.",
          reasoning_content: "User asks what is 2+2.",
          tool_calls: [{ function: { name: "answer", arguments: '{"text":"4"}' } }],
        },
      }],
    });
    expect(r.thinking).toBe("User asks what is 2+2. Use the answer function.");
  });

  it("falls back to reasoning_content when reasoning itself is absent", () => {
    const r = normalizeUniversalResponse({
      choices: [{ message: { content: "4", reasoning_content: "only this field is set" } }],
    });
    expect(r.thinking).toBe("only this field is set");
  });

  it("Workers AI native shape: same reasoning/reasoning_content preference on `result`", () => {
    const r = normalizeUniversalResponse({
      result: { response: "4", reasoning: "thinking out loud", usage: { prompt_tokens: 1, completion_tokens: 1 } },
    });
    expect(r.thinking).toBe("thinking out loud");
  });

  it("is absent (not fabricated) for a model that never reports one", () => {
    const r = normalizeUniversalResponse({ choices: [{ message: { content: "hello" } }] });
    expect(r.thinking).toBeUndefined();
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

  // Live-reported bug (2026-07-29): "search the web for polsia ai and tell me what it's about"
  // produced a bare "unparseable reasoner output: no JSON object in reasoner output" as the
  // agent's own reply — no tool_calls at all AND no {..} JSON in the text, because
  // tool_choice:"required" isn't always honored by every Workers AI model. Plain, non-empty
  // prose with no tool call and no JSON braces is a real model behavior (it just answered), not
  // a parse failure, and must become the actual answer rather than leak an internal error string.
  it("plain prose with no tool call and no JSON braces becomes the answer, not a give_up", async () => {
    const d = await decideWith({
      content: [{ type: "text", text: "Polsia AI is an autonomous business operator that runs online businesses for you." }],
    });
    expect(d).toMatchObject({ action: "answer", text: "Polsia AI is an autonomous business operator that runs online businesses for you." });
  });

  it("still gives up honestly when the model returns truly nothing", async () => {
    const d = await decideWith({ content: [{ type: "text", text: "   " }] });
    expect(d.action).toBe("give_up");
    expect((d as { reason: string }).reason).toMatch(/unparseable reasoner output/);
  });
});

// Live-reported: "our API doesn't support programmatic thread creation or direct in-thread chat
// messaging" — the capability existed (project-coordination's thread.create/thread.send_message)
// and was in `available_operations`, but only as a bare name among 60+ others with zero
// description, so the model had no way to recognize it as the answer. Pin the request body itself
// — the exact thing the model reads — not just that the reasoner accepts the new field.
describe("GatewayReasoner — grouped available_operations reach the actual request body", () => {
  async function decideCapturingBody(input: unknown): Promise<Record<string, unknown>> {
    let capturedBody: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "answer", input: { text: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
      await reasoner.decide(input as never);
      const body = JSON.parse(capturedBody!) as { messages: Array<{ role: string; content: string }> };
      const userMsg = body.messages.find((m) => m.role === "user")!;
      return JSON.parse(userMsg.content) as Record<string, unknown>;
    } finally {
      globalThis.fetch = original;
    }
  }

  it("sends the grouped shape, with descriptions, when the loop supplies operationGroups", async () => {
    const payload = await decideCapturingBody({
      goal: "g", level: 2, snapshot: {}, candidates: [],
      availableOperations: ["thread.create", "thread.send_message", "notify.email"],
      operationGroups: [
        { script: "project-coordination", description: "Work with a project's threads and its agents.", operations: ["thread.create", "thread.send_message"] },
        { script: "notifications", description: "Send outbound notifications.", operations: ["notify.email"] },
      ],
    });
    const ops = payload["available_operations"] as Array<{ script: string; description: string; operations: string[] }>;
    expect(Array.isArray(ops)).toBe(true);
    const coordination = ops.find((g) => g.script === "project-coordination");
    expect(coordination).toBeDefined();
    expect(coordination!.description).toContain("threads and its agents");
    expect(coordination!.operations).toContain("thread.send_message");
  });

  it("falls back to the bare flat list when no operationGroups are supplied", async () => {
    const payload = await decideCapturingBody({
      goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: ["read_file", "notify.email"],
    });
    expect(payload["available_operations"]).toEqual(["read_file", "notify.email"]);
  });

  // Live-reported: with only a bare op name and a script-level description, the model called
  // thread.create({}) — no project_id, since nothing said that field existed — and never attempted
  // thread.send_message at all. Pin that param_hints actually reaches the request body the model
  // reads, and that a group with no hints omits the field rather than sending an empty one.
  it("forwards param_hints as param_hints (snake_case) in the request body, only for a group that has them", async () => {
    const payload = await decideCapturingBody({
      goal: "g", level: 2, snapshot: {}, candidates: [],
      availableOperations: ["thread.create", "thread.send_message", "notify.email"],
      operationGroups: [
        {
          script: "project-coordination",
          description: "Work with a project's threads and its agents.",
          operations: ["thread.create", "thread.send_message"],
          paramHints: {
            "thread.create": "project_id (optional but almost always wanted), title (optional).",
            "thread.send_message": "thread_id (REQUIRED), message (REQUIRED), agent_id (optional).",
          },
        },
        { script: "notifications", description: "Send outbound notifications.", operations: ["notify.email"] },
      ],
    });
    const ops = payload["available_operations"] as Array<{
      script: string; param_hints?: Record<string, string>;
    }>;
    const coordination = ops.find((g) => g.script === "project-coordination")!;
    expect(coordination.param_hints).toBeDefined();
    expect(coordination.param_hints!["thread.create"]).toMatch(/project_id/);
    expect(coordination.param_hints!["thread.send_message"]).toMatch(/thread_id/);

    const notify = ops.find((g) => g.script === "notifications")!;
    expect(notify.param_hints).toBeUndefined();
  });
});

describe("GatewayReasoner — reasoning-effort request + lastThinking capture", () => {
  it("forwards a configured reasoning option into the actual gateway request body", async () => {
    let capturedBody: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"answer","text":"ok"}' } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const reasoner = new GatewayReasoner({
        apiKey: "k", gateway: GATEWAY, ctx: CTX,
        reasoning: { param: "reasoning_effort", level: "high" },
      });
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
    } finally {
      globalThis.fetch = original;
    }
    expect(JSON.parse(capturedBody!).reasoning_effort).toBe("high");
  });

  it("captures the model's own chain-of-thought onto lastThinking, mirroring lastUsage's contract", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, reasoning: "thinking about it", tool_calls: [{ function: { name: "answer", arguments: '{"text":"ok"}' } }] } }],
    }), { status: 200 })) as typeof fetch;
    try {
      expect(reasoner.lastThinking).toBeUndefined();
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(reasoner.lastThinking).toBe("thinking about it");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("resets lastThinking to undefined at the start of a new decide() call that reports none", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const body = call === 1
        ? { choices: [{ message: { content: null, reasoning: "first call thought", tool_calls: [{ function: { name: "answer", arguments: '{"text":"a"}' } }] } }] }
        : { choices: [{ message: { content: null, tool_calls: [{ function: { name: "answer", arguments: '{"text":"b"}' } }] } }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(reasoner.lastThinking).toBe("first call thought");
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(reasoner.lastThinking).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Mid-run narration — Claude Code's own "the agent talks to me, THEN runs a tool" pattern. A
// model can attach a real text block alongside its tool_use with tool_choice:"required" (this is
// exactly what a live capture already showed happening — normalizeUniversalResponse already
// returned it, it was just discarded once the tool call itself resolved). Captured separately
// from lastThinking (raw chain-of-thought, kept collapsed) because this is prose written to be
// read, shown as a real reply line at the point it happened.
describe("GatewayReasoner — lastNarration capture (mid-run reply alongside a tool call)", () => {
  it("captures prose alongside a non-terminal (run) tool call", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        { type: "text", text: "I'll check the order list first." },
        { type: "tool_use", name: "run", input: { name: "commerce.list_orders" } },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      expect(reasoner.lastNarration).toBeUndefined();
      const d = await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(d).toMatchObject({ action: "run", name: "commerce.list_orders" });
      expect(reasoner.lastNarration).toBe("I'll check the order list first.");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("also captures narration on the coerced-operation near-miss path (a direct op call, not wrapped in run)", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        { type: "text", text: "Let me search for that." },
        { type: "tool_use", name: "web-search.search", input: { q: "polsia ai" } },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      const d = await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: ["web-search.search"] } as never);
      expect(d).toMatchObject({ action: "run", name: "web-search.search" });
      expect(reasoner.lastNarration).toBe("Let me search for that.");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does NOT capture narration alongside a terminal answer — the answer text itself already covers that turn", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        { type: "text", text: "Here's my final answer:" },
        { type: "tool_use", name: "answer", input: { text: "42" } },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      const d = await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(d).toMatchObject({ action: "answer", text: "42" });
      expect(reasoner.lastNarration).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does NOT capture narration alongside give_up either", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        { type: "text", text: "I can't do this." },
        { type: "tool_use", name: "give_up", input: { reason: "blocked" } },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(reasoner.lastNarration).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("resets to undefined at the start of a decide() call whose response carries no accompanying text", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const body = call === 1
        ? { content: [{ type: "text", text: "first call narration" }, { type: "tool_use", name: "run", input: { name: "x" } }] }
        : { content: [{ type: "tool_use", name: "run", input: { name: "y" } }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(reasoner.lastNarration).toBe("first call narration");
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(reasoner.lastNarration).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

// The `doing` / `say` split. These are two different things with different lifetimes: `doing` is a
// per-action STATUS the next action replaces, `say` is a real MESSAGE that stays in the
// conversation. Conflating them into one field is what produced the reported wall of fifteen
// near-identical italic lines on a single multi-step run — every action contributed one, and none
// of them was a message anyone wanted to keep.
describe("GatewayReasoner — `doing` is a status, `say` is a message, and they stay separate", () => {
  const runWith = async (input: Record<string, unknown>) => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "run", input: { name: "commerce.list_orders", ...input } }],
    }), { status: 200 })) as typeof fetch;
    try {
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      return reasoner;
    } finally {
      globalThis.fetch = original;
    }
  };

  it("routes each field to its own slot", async () => {
    const r = await runWith({ doing: "Reading your orders", say: "Let me look at what's sold so far." });
    expect(r.lastNarration).toBe("Reading your orders");
    expect(r.lastMessage).toBe("Let me look at what's sold so far.");
  });

  it("leaves lastMessage unset when the model wrote only a status — the common case", async () => {
    const r = await runWith({ doing: "Reading your orders" });
    expect(r.lastNarration).toBe("Reading your orders");
    expect(r.lastMessage).toBeUndefined();
  });

  it("prefers the declared `doing` over prose the model attached beside the call", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        { type: "text", text: "some incidental prose" },
        { type: "tool_use", name: "run", input: { name: "x", doing: "Reading your orders" } },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      // The declared parameter is schema-constrained and therefore reliable; loose prose is only
      // the fallback for providers that emit it at all under tool_choice:"required".
      expect(reasoner.lastNarration).toBe("Reading your orders");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not carry a message across turns — a later status-only turn must not re-show it", async () => {
    const reasoner = new GatewayReasoner({ apiKey: "k", gateway: GATEWAY, ctx: CTX });
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const input = call === 1
        ? { name: "x", doing: "Checking", say: "Here's what I'm starting with." }
        : { name: "y", doing: "Creating it" };
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "run", input }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      expect(reasoner.lastMessage).toBe("Here's what I'm starting with.");
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [], availableOperations: [] } as never);
      // Without the reset, every subsequent step would re-render the same message — the exact
      // duplication this split exists to remove.
      expect(reasoner.lastMessage).toBeUndefined();
      expect(reasoner.lastNarration).toBe("Creating it");
    } finally {
      globalThis.fetch = original;
    }
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

// Real wire payloads captured from the live gateway during the model-matrix run. Keeping the
// actual shapes here — rather than shapes we assume — is what caught the Workers AI
// `response: null` case originally; these two providers differ again in ways worth pinning.
describe("captured live payloads — the parser handles what these models actually send", () => {
  it("@cf/openai/gpt-oss-120b: tool_calls alongside a populated `reasoning` field and null content", () => {
    const r = normalizeUniversalResponse({
      id: "id-1",
      object: "chat.completion",
      model: "@cf/openai/gpt-oss-120b",
      choices: [{
        finish_reason: "tool_calls",
        index: 0,
        message: {
          annotations: null,
          audio: null,
          content: null,
          function_call: null,
          // This model emits its chain-of-thought in a sibling field. It must not be mistaken
          // for the answer, and its presence must not stop the tool call being read.
          reasoning: "User asks what is 2+2. Use the answer function.",
          reasoning_content: "User asks what is 2+2.",
          refusal: null,
          role: "assistant",
          tool_calls: [{ function: { arguments: '{"text": "4"}', name: "answer" }, id: "chatcmpl-tool-abc", type: "function" }],
        },
      }],
    });
    expect(r.toolCall).toEqual({ name: "answer", arguments: { text: "4" } });
  });

  it("@cf/meta/llama-3.3-70b: standard OpenAI tool_calls with a usage block carrying neurons", () => {
    const r = normalizeUniversalResponse({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "answer", arguments: '{"text":"The answer to 2+2 is 4."}' } }],
          refusal: null,
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 153, completion_tokens: 32, total_tokens: 185, neurons: 10.63 },
    });
    expect(r.toolCall?.name).toBe("answer");
    expect(r.usage).toEqual({ input_tokens: 153, output_tokens: 32 });
  });
});

describe("a tool call naming an operation instead of an action", () => {
  // Observed live: the model emitted a tool call named `knowledge.search` — not one of the five
  // actions — and the whole run died with "unusable tool call ... and no parseable text". Models
  // trained to emit direct tool calls reach for the operation name constantly, and the intent is
  // unambiguous. Losing a turn (and at the end of a budget, the run) over a forgotten wrapper is
  // the wrong trade.
  it("reads a dotted operation name as a run of that operation", async () => {
    const { coerceOperationToolCall } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const d = coerceOperationToolCall({ name: "knowledge.search", arguments: { query: "pricing" } });
    expect(d).toEqual({ action: "run", name: "knowledge.search", params: { query: "pricing" } });
  });

  it("parses stringified arguments, which is how most providers send them", async () => {
    const { coerceOperationToolCall } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const d = coerceOperationToolCall({ name: "commerce.list_products", arguments: '{"limit":5}' });
    expect(d).toEqual({ action: "run", name: "commerce.list_products", params: { limit: 5 } });
  });

  it("unwraps arguments the model nested under params/arguments/input", async () => {
    const { coerceOperationToolCall } = await import("../../workers/agents/src/script-engine/reasoner.js");
    expect(coerceOperationToolCall({ name: "project.create", arguments: { params: { name: "Q3" } } }))
      .toEqual({ action: "run", name: "project.create", params: { name: "Q3" } });
  });

  it("leaves a real decision action alone", async () => {
    const { coerceOperationToolCall } = await import("../../workers/agents/src/script-engine/reasoner.js");
    // `answer` has no dot and IS an action — coercing it to a `run` would be catastrophic.
    expect(coerceOperationToolCall({ name: "answer", arguments: { text: "hi" } })).toBeNull();
  });

  it("does not guess at an undotted name it cannot recognise", async () => {
    const { coerceOperationToolCall } = await import("../../workers/agents/src/script-engine/reasoner.js");
    // An unrecognisable action should still fail visibly rather than be invented into a run.
    expect(coerceOperationToolCall({ name: "frobnicate", arguments: {} })).toBeNull();
  });
});

// Live-reported: on the SAME business, across two separate runs of the same goal, the model
// guessed a namespaced op name — "workspace-admin:project.list", then "project-coordination:
// thread.create" — always with the exact right, real op name after the colon. The first time it
// self-corrected on the next turn (a wasted step); the second time it never self-corrected at
// all, because the resulting "did you mean" suggestion list happened to omit the real answer.
// Both are now resolved at the source: a colon-prefixed guess resolves directly, before the loop's
// gate/repeat-guard/ledger or ScriptToolSurface ever see the raw, wrong-shaped name.
describe("stripNamespacePrefix — a colon-namespaced op guess resolves to the real op", () => {
  it("strips everything up to and including the LAST colon", async () => {
    const { stripNamespacePrefix } = await import("../../workers/agents/src/script-engine/reasoner.js");
    expect(stripNamespacePrefix("project-coordination:thread.create")).toBe("thread.create");
    expect(stripNamespacePrefix("workspace-admin:project.list")).toBe("project.list");
  });

  it("leaves a bare name (no colon) untouched", async () => {
    const { stripNamespacePrefix } = await import("../../workers/agents/src/script-engine/reasoner.js");
    expect(stripNamespacePrefix("thread.create")).toBe("thread.create");
  });

  it("falls back to the original string when nothing survives the colon", async () => {
    const { stripNamespacePrefix } = await import("../../workers/agents/src/script-engine/reasoner.js");
    // An edge case a real model would be unlikely to produce, but the function must never return
    // an empty op name — that would just move the "Unknown script or operation" failure to a
    // worse, less legible name.
    expect(stripNamespacePrefix("project-coordination:")).toBe("project-coordination:");
  });

  it("coerceOperationToolCall resolves a colon-namespaced direct tool call to the real op", async () => {
    const { coerceOperationToolCall } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const d = coerceOperationToolCall({
      name: "project-coordination:thread.create",
      arguments: { project_id: "p1" },
    });
    expect(d).toEqual({ action: "run", name: "thread.create", params: { project_id: "p1" } });
  });

  it("coerceDecision resolves a colon-namespaced name inside a real run action call", async () => {
    const { coerceDecision } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const d = coerceDecision({
      action: "run",
      name: "project-coordination:thread.create",
      params: { project_id: "p1" },
    });
    expect(d).toEqual({ action: "run", name: "thread.create", params: { project_id: "p1" } });
  });
});

/**
 * The `params` argument reaches the model as a JSON STRING, not a property-less object.
 *
 * This is the fix for the failure that made the assistant look incapable of basic multi-step
 * work. `{type:"object"}` with no `properties` gives a schema-constrained decoder no permitted
 * keys, so the only value it can emit is `{}` — which is exactly what two full live traces show,
 * on every single tool call, without one exception, including calls where the model demonstrably
 * held the value it needed (its own closing answer quoted a project id it had looked up a step
 * earlier and could never pass in). It then repeated the same argument-less call five more times,
 * because the one action the grammar let it express was the wrong one.
 *
 * The wire-shape assertion below is the real regression guard: reverting PARAMS_PARAM to an
 * object schema fails it immediately, at the point the schema is actually sent.
 */
describe("run.params is expressible by a constrained decoder", () => {
  const GATEWAY = { accountId: "acct", gatewayId: "gw" };
  const CTX = { spaceId: "s", agentId: "a" };

  async function capturedTools(model?: string): Promise<Array<Record<string, any>>> {
    let body: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return new Response(
        JSON.stringify({ content: [{ type: "tool_use", name: "answer", input: { text: "ok" } }] }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      // A BYOK model (Gemini/Groq) needs its own key present in gateway or canAuthenticateLlm
      // refuses before ever calling fetch — see byokKeyFieldForModel.
      const gateway =
        model?.startsWith("google-ai-studio/") ? { ...GATEWAY, googleAiStudioApiKey: "g-key" }
        : model?.startsWith("groq/") ? { ...GATEWAY, groqApiKey: "grok-key" }
        : GATEWAY;
      const reasoner = new GatewayReasoner({ apiKey: "k", gateway, ctx: CTX, ...(model ? { model } : {}) });
      await reasoner.decide({ goal: "g", level: 2, snapshot: {}, candidates: [] } as never);
      return (JSON.parse(body!) as { tools: Array<Record<string, any>> }).tools;
    } finally {
      globalThis.fetch = original;
    }
  }

  // The precise defect this whole describe block guards against: an object type whose keys are
  // unenumerable to a schema-constrained decoder — neither declared `properties` nor
  // `additionalProperties`, so the only value it can legally emit is `{}`.
  const isUnenumerableObject = (params: Record<string, any>) =>
    params.type === "object" && !params.properties && params.additionalProperties === undefined;

  it("Gemini gets the JSON-string schema — the one shape its own decoder is proven to accept", async () => {
    const tools = await capturedTools("google-ai-studio/gemini-flash-lite-latest");
    const run = tools.find((t) => t.function?.name === "run");
    expect(run).toBeDefined();
    const params = run!.function.parameters.properties.params;
    expect(isUnenumerableObject(params)).toBe(false);
    expect(params.type).toBe("string");
  });

  // Groq's own server validates a model's tool-call output against the DECLARED schema and
  // REJECTS the call outright when they mismatch — observed live, on a real heartbeat wake:
  // "tool call validation failed: parameters for tool run did not match schema: errors:
  // [`/params`: expected string, but got object]", on both the streamed attempt and its
  // non-streamed retry. Groq's own model naturally wants to emit a real object; the string
  // schema that fixed Gemini is precisely what a Groq-dispatched run must NOT declare.
  it("Groq (and every non-Gemini provider) gets a real object schema, not a string", async () => {
    const tools = await capturedTools("groq/llama-3.3-70b-versatile");
    const run = tools.find((t) => t.function?.name === "run");
    const params = run!.function.parameters.properties.params;
    expect(params.type).toBe("object");
    // additionalProperties:true is what keeps this SAFE despite having no properties — the same
    // enumerability defect the Gemini fix exists to avoid, closed a different, more portable way.
    expect(params.additionalProperties).toBe(true);
    expect(isUnenumerableObject(params)).toBe(false);
  });

  it("an unset model defaults to the object schema (every non-Gemini caller today)", async () => {
    const tools = await capturedTools();
    const run = tools.find((t) => t.function?.name === "run");
    const params = run!.function.parameters.properties.params;
    expect(params.type).toBe("object");
    expect(isUnenumerableObject(params)).toBe(false);
  });

  it("requires params on both schema variants, so the decoder must emit it either way", async () => {
    for (const model of [undefined, "google-ai-studio/gemini-flash-lite-latest", "groq/llama-3.3-70b-versatile"]) {
      const tools = await capturedTools(model);
      const run = tools.find((t) => t.function?.name === "run");
      expect(run!.function.parameters.required).toContain("params");
    }
  });

  it("parses a JSON-string params into the real arguments the loop will act on", async () => {
    const { coerceDecision } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const d = coerceDecision({
      action: "run",
      name: "thread.create",
      params: '{"project_id":"9d67a69a-981a-4c3e-b50d-83c3f51c679c","title":"Kickoff"}',
    });
    expect(d).toEqual({
      action: "run",
      name: "thread.create",
      params: { project_id: "9d67a69a-981a-4c3e-b50d-83c3f51c679c", title: "Kickoff" },
    });
  });

  it("still accepts a real object, so providers that send one do not regress", async () => {
    const { coerceDecision } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const d = coerceDecision({ action: "run", name: "thread.create", params: { project_id: "p1" } });
    expect(d).toEqual({ action: "run", name: "thread.create", params: { project_id: "p1" } });
  });

  it("degrades to no arguments for an unusable params rather than throwing mid-run", async () => {
    const { coerceDecision } = await import("../../workers/agents/src/script-engine/reasoner.js");
    for (const bad of ['{"unclosed', "[1,2,3]", '"just a string"', ""]) {
      const d = coerceDecision({ action: "run", name: "agent.list", params: bad });
      expect(d).toEqual({ action: "run", name: "agent.list", params: {} });
    }
  });

  it("reads a JSON-string params from a direct operation tool call too", async () => {
    const { coerceOperationToolCall } = await import("../../workers/agents/src/script-engine/reasoner.js");
    const d = coerceOperationToolCall({
      name: "thread.send_message",
      arguments: { params: '{"thread_id":"t1","message":"hello"}' },
    });
    expect(d).toEqual({
      action: "run",
      name: "thread.send_message",
      params: { thread_id: "t1", message: "hello" },
    });
  });
});
