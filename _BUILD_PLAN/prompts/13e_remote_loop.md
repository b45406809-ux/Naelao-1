# Prompt: workers/naelao-agents/src/remote-loop.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-agents/src/remote-loop.ts

This calls the LLM API and streams the response. It uses Together AI's OpenAI-compatible API.

  interface RemoteLoopOptions {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    spaceId: string;
    runId: string;
    apiKey: string;
    timeoutMs?: number;  // default 25000 (G-E17 fix)
  }

  interface StreamChunk {
    delta: string;
    finishReason: 'stop' | 'tool_calls' | 'length' | null;
    toolCalls?: ToolCallDelta[];
    usage?: { promptTokens: number; completionTokens: number };
  }

CRITICAL (G-E17 fix) - MUST implement stream timeout:
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('stream_timeout'), options.timeoutMs ?? 25_000);
  try {
    const resp = await fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Authorization': 'Bearer ' + options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: true, max_tokens: 4096 }),
    });
    // parse SSE stream line by line
    // each line: 'data: {...}' or 'data: [DONE]'
  } finally { clearTimeout(timer); }

  async function* streamCompletion(options: RemoteLoopOptions): AsyncGenerator<StreamChunk>
  // Yields StreamChunk for each SSE event
  // On AbortController abort: yield { delta: '', finishReason: 'timeout', toolCalls: undefined }
  // Handles SSE parsing: split by newline, parse 'data: ' prefix

  async function runRemoteLoop(options: RemoteLoopOptions, onChunk: (chunk: StreamChunk) => void): Promise<FinishReason>
  // Calls streamCompletion, invokes onChunk for each chunk
  // Returns the finish reason

Export both the generator and the high-level runRemoteLoop function.

