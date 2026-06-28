// G-L01: Together AI worker — alternative LLM provider (OpenAI-compatible API)
import { badRequest, errorResponse, internalError, requestId } from "@naelao/http";
import { Hono } from "hono";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface TogetherAiEnv {
  ENVIRONMENT: string;
  TOGETHER_API_KEY: string;
  TOGETHER_API_URL: string;
}

function validateEnv(env: TogetherAiEnv): void {
  if (!env.TOGETHER_API_KEY) throw new Error("Missing required secret: TOGETHER_API_KEY");
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LlmRequest {
  model: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface TogetherChoice {
  message: {
    role: string;
    content: string;
  };
  finish_reason: string | null;
}

interface TogetherUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface TogetherResponse {
  id: string;
  model: string;
  choices: TogetherChoice[];
  usage: TogetherUsage;
}

interface LlmResponse {
  id: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  content: Array<{ type: "text"; text: string }>;
}

// ── Model mapping ─────────────────────────────────────────────────────────────

const CLAUDE_FALLBACK_MODEL = "meta-llama/Llama-3-70b-chat-hf";

function mapModel(model: string): string {
  if (model.startsWith("claude-")) {
    return CLAUDE_FALLBACK_MODEL;
  }
  return model;
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: TogetherAiEnv }>();

app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

// POST /chat
app.post("/chat", async (c) => {
  let body: LlmRequest;
  try {
    body = await c.req.json<LlmRequest>();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.model) throw badRequest("model is required");
  if (!body.messages || body.messages.length === 0) {
    throw badRequest("messages array is required and must not be empty");
  }

  const togetherModel = mapModel(body.model);
  const isStream = body.stream === true;

  const requestPayload = {
    model: togetherModel,
    messages: body.messages,
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    stream: isStream,
  };

  const upstreamRes = await fetch(`${c.env.TOGETHER_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.env.TOGETHER_API_KEY}`,
    },
    body: JSON.stringify(requestPayload),
  });

  if (!upstreamRes.ok) {
    let errText = "";
    try {
      errText = await upstreamRes.text();
    } catch {
      errText = "unknown upstream error";
    }
    console.error(
      `[together-ai] upstream error status=${upstreamRes.status} body=${errText}`
    );
    throw internalError(`Together AI returned ${upstreamRes.status}: ${errText}`);
  }

  // Streaming: pipe SSE stream directly through
  if (isStream) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

    if (!upstreamRes.body) {
      throw internalError("Together AI returned empty streaming body");
    }

    // Pipe upstream response body through our transform stream
    upstreamRes.body.pipeTo(writable).catch((err) => {
      console.error("[together-ai] stream pipe error:", err);
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Request-Id": c.get("requestId") ?? "",
      },
    });
  }

  // Non-streaming: translate response to LlmResponse format
  let togetherData: TogetherResponse;
  try {
    togetherData = (await upstreamRes.json()) as TogetherResponse;
  } catch {
    throw internalError("Failed to parse Together AI response");
  }

  const firstChoice = togetherData.choices[0];
  const text = firstChoice?.message?.content ?? "";

  const llmResponse: LlmResponse = {
    id: togetherData.id,
    model: togetherData.model,
    usage: {
      input_tokens: togetherData.usage.prompt_tokens,
      output_tokens: togetherData.usage.completion_tokens,
    },
    content: [{ type: "text", text }],
  };

  return c.json(llmResponse);
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── Export ────────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<TogetherAiEnv>;
