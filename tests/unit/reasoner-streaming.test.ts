import { describe, it, expect, afterEach } from "vitest";
import { partialJsonString, parseUniversalStream } from "../../workers/agents/src/shared/ai-client.js";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";

/**
 * Real streaming of the reasoning call — the difference between a chat that sits silent for eight
 * seconds and one you can watch think.
 *
 * Two things are being proven here, and they are separable:
 *   1. The model's user-visible text arrives WHILE it is being generated (partialJsonString +
 *      parseUniversalStream), rather than only once the whole call has returned.
 *   2. The streaming path degrades honestly. Asking for a stream is a request, not a guarantee —
 *      a provider or gateway may answer with an ordinary JSON body, and reading that as SSE would
 *      find no frames and report an empty turn. That would silently break every interactive run
 *      against such a provider, so it is tested as carefully as the happy path.
 */

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(`data: ${f}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** One OpenAI-compatible tool-call argument fragment, as a provider actually emits it. */
function argFrame(fragment: string): string {
  return JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }] });
}

describe("partialJsonString — reading a value out of truncated JSON", () => {
  it("returns whatever of the value has arrived when the string is still open", () => {
    expect(partialJsonString('{"say":"Let me ch', "say")).toBe("Let me ch");
  });

  it("returns the whole value once the closing quote has arrived", () => {
    expect(partialJsonString('{"say":"Let me check","name":"x"}', "say")).toBe("Let me check");
  });

  it("distinguishes 'key not seen yet' (undefined) from 'seen but empty so far' ('')", () => {
    expect(partialJsonString('{"name":"x"', "say")).toBeUndefined();
    expect(partialJsonString('{"say":"', "say")).toBe("");
  });

  it("unescapes as it goes, so a newline arrives as a newline and not a literal backslash-n", () => {
    expect(partialJsonString('{"text":"line one\\nline two', "text")).toBe("line one\nline two");
    expect(partialJsonString('{"text":"he said \\"hi\\"', "text")).toBe('he said "hi"');
  });

  it("stops at a half-arrived escape rather than emitting a lone backslash the next chunk replaces", () => {
    // A trailing "\" is the escape itself still in flight — emitting it would show the user a
    // stray backslash that vanishes a moment later.
    expect(partialJsonString('{"text":"done\\', "text")).toBe("done");
    // Same for a \uXXXX that has only half arrived.
    expect(partialJsonString('{"text":"a\\u00', "text")).toBe("a");
    expect(partialJsonString('{"text":"a\\u0041b', "text")).toBe("aAb");
  });

  it("ignores a non-string value rather than guessing at it", () => {
    expect(partialJsonString('{"say":42}', "say")).toBeUndefined();
  });
});

describe("parseUniversalStream", () => {
  it("reports the growing text on every chunk, then returns the assembled tool call", async () => {
    const seen: string[] = [];
    const result = await parseUniversalStream(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "run", arguments: "" } }] } }] }),
        argFrame('{"say":"Let me '),
        argFrame('check your store"'),
        argFrame(',"name":"commerce.list_products","params":{}}'),
        JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 40 } }),
      ]),
      (p) => {
        const say = partialJsonString(p.toolArguments, "say");
        if (say !== undefined) seen.push(say);
      }
    );

    // The point of the whole exercise: the sentence was readable BEFORE the call finished.
    expect(seen).toContain("Let me ");
    expect(seen[seen.length - 1]).toBe("Let me check your store");
    expect(result.toolCall?.name).toBe("run");
    expect(result.toolCall?.arguments["name"]).toBe("commerce.list_products");
    expect(result.toolCall?.arguments["say"]).toBe("Let me check your store");
    // Usage must survive streaming — the loop's budget accounting and per-run billing depend on
    // real numbers, which is why stream_options.include_usage is requested.
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 40 });
  });

  it("accumulates plain assistant text for a provider that ignores the tool declaration", async () => {
    const result = await parseUniversalStream(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "2 + 2 " } }] }),
        JSON.stringify({ choices: [{ delta: { content: "is 4." } }] }),
      ])
    );
    expect(result.text).toBe("2 + 2 is 4.");
    expect(result.toolCall).toBeUndefined();
  });

  it("captures streamed chain-of-thought separately from the reply", async () => {
    const result = await parseUniversalStream(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning: "weighing options" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "here goes" } }] }),
      ])
    );
    expect(result.thinking).toBe("weighing options");
    expect(result.text).toBe("here goes");
  });

  it("falls back to whole-body JSON when the provider ignores stream:true", async () => {
    // The failure this guards against is silent and total: read as SSE, a plain JSON body yields
    // no frames, so every interactive run against such a provider would report an empty turn.
    const resp = new Response(
      JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "answer", arguments: '{"text":"done"}' } }] } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const result = await parseUniversalStream(resp);
    expect(result.toolCall?.name).toBe("answer");
    expect(result.toolCall?.arguments["text"]).toBe("done");
  });

  it("salvages a whole JSON body even when it is mislabelled as an event stream", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "plain reply" } }] });
    const resp = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const result = await parseUniversalStream(resp);
    expect(result.text).toBe("plain reply");
  });

  it("keeps what arrived when the stream dies mid-tool-call, rather than losing the turn", async () => {
    // Pull-based on purpose: controller.error() DISCARDS anything still queued, so enqueueing and
    // erroring in the same tick means the chunk never reaches the reader at all — which tests
    // nothing. Erroring on the second pull guarantees the first chunk was genuinely delivered.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "answer", arguments: '{"text":"partial ans' } }] } }] })}\n\n`));
          return;
        }
        controller.error(new Error("connection reset"));
      },
    });
    const result = await parseUniversalStream(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    // Truncated arguments are not valid JSON — the salvage path recovers the string fields so a
    // nearly-complete reply still becomes a usable decision.
    expect(result.toolCall?.name).toBe("answer");
    expect(result.toolCall?.arguments["text"]).toBe("partial ans");
  });

  it("recovers a final frame that never got its terminating blank line, even when the stream then dies", async () => {
    // Frames are delimited by a blank line, so a stream that stops right after the last `data:`
    // line leaves a complete, perfectly good frame sitting unprocessed in the buffer. Flushing the
    // tail is what keeps that reply instead of reporting an empty turn.
    //
    // The stream ERRORS rather than closing cleanly, and that is the whole point: a clean close
    // falls out of the read loop normally, so a flush on the success path alone would already
    // cover it. Only a throw proves the flush happens unconditionally — which is exactly the case
    // where losing the last frame costs a real answer.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "no trailing newline" } }] })}`));
          return;
        }
        controller.error(new Error("connection reset"));
      },
    });
    const result = await parseUniversalStream(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(result.text).toBe("no trailing newline");
  });

  it("survives a malformed frame instead of abandoning the rest of the stream", async () => {
    const result = await parseUniversalStream(
      sseResponse([
        "{not json at all",
        JSON.stringify({ choices: [{ delta: { content: "still here" } }] }),
      ])
    );
    expect(result.text).toBe("still here");
  });
});

const ORIGINAL_FETCH = globalThis.fetch;

describe("GatewayReasoner — streaming is opt-in per call", () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  function captureBody(respond: () => Response): { bodies: string[] } {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return respond();
    }) as unknown as typeof fetch;
    return { bodies };
  }

  const baseInput = {
    goal: "what do I sell?",
    level: "L4" as const,
    snapshot: { type: "none" } as never,
    candidates: [],
    availableOperations: ["commerce.list_products"],
  };

  it("does NOT ask for a stream when nobody is watching", async () => {
    // A cron wake, a channel drain and a sub-agent all pass no onDelta — paying for a held-open
    // connection there buys nothing, since the output is only read once it is finished.
    const { bodies } = captureBody(() => new Response(
      JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "answer", arguments: '{"text":"hi"}' } }] } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const reasoner = new GatewayReasoner({
      apiKey: "k",
      gateway: { accountId: "a", gatewayId: "g" },
      ctx: { tenantId: "t", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as never,
    });
    const decision = await reasoner.decide(baseInput);
    expect(decision).toEqual({ action: "answer", text: "hi" });
    expect(JSON.parse(bodies[0]!).stream).toBeUndefined();
  });

  it("asks for a stream and reports the answer as it is written when onDelta is passed", async () => {
    const { bodies } = captureBody(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "answer", arguments: "" } }] } }] }),
      argFrame('{"text":"You sell '),
      argFrame('websites."}'),
    ]));
    const reasoner = new GatewayReasoner({
      apiKey: "k",
      gateway: { accountId: "a", gatewayId: "g" },
      ctx: { tenantId: "t", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as never,
    });
    const answers: string[] = [];
    const decision = await reasoner.decide({
      ...baseInput,
      onDelta: (p) => { if (p.answer !== undefined) answers.push(p.answer); },
    });
    expect(JSON.parse(bodies[0]!).stream).toBe(true);
    expect(answers).toContain("You sell ");
    expect(answers[answers.length - 1]).toBe("You sell websites.");
    expect(decision).toEqual({ action: "answer", text: "You sell websites." });
  });

  it("reports a mid-run `say` as it is written, and keeps it as the turn's narration", async () => {
    captureBody(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "run", arguments: "" } }] } }] }),
      argFrame('{"say":"Let me check '),
      argFrame('your store first","name":"commerce.list_products","params":{}}'),
    ]));
    const reasoner = new GatewayReasoner({
      apiKey: "k",
      gateway: { accountId: "a", gatewayId: "g" },
      ctx: { tenantId: "t", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as never,
    });
    const says: string[] = [];
    const decision = await reasoner.decide({
      ...baseInput,
      onDelta: (p) => { if (p.say !== undefined) says.push(p.say); },
    });
    expect(says).toContain("Let me check ");
    expect(decision).toEqual({ action: "run", name: "commerce.list_products", params: {} });
    // `say` is the declared parameter, so it survives as the narration rendered in the thread —
    // it is not merely a transient streaming artifact.
    expect(reasoner.lastNarration).toBe("Let me check your store first");
  });
});
