# Prompt: workers/naelao-agents/src/remote-loop.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-agents/src/remote-loop.ts

CRITICAL FIX (G-I06): This file MUST NOT call the Together AI API directly.
All LLM calls MUST go through the naelao-together-ai Service Binding (env.NAELAO_TOGETHER_AI).
Direct Together AI calls bypass the credit reservation/settlement system in WalletDO.
The naelao-agents wrangler config does NOT include TOGETHER_AI_API_KEY.

This calls the LLM API via the naelao-together-ai Service Binding, which handles credit charging and streaming passthrough.

  interface RemoteLoopOptions {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    spaceId: string;
    runId: string;
    togetherAiService: Service;  // NAELAO_TOGETHER_AI service binding — NOT an apiKey string
    timeoutMs?: number;  // default 25000 (G-E17 fix)
  }

  interface StreamChunk {
    delta: string;
    finishReason: 'stop' | 'tool_calls' | 'length' | null;
    toolCalls?: ToolCallDelta[];
    usage?: { promptTokens: number; completionTokens: number };
  }

CRITICAL (G-E17 fix + G-I06 fix) - MUST call via Service Binding, MUST implement stream timeout:
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('stream_timeout'), options.timeoutMs ?? 25_000);
  try {
    // CORRECT: Use Service Binding, not direct fetch to api.together.xyz
    const resp = await options.togetherAiService.fetch(
      new Request('https://placeholder/v1/ai/chat', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Space-Id': options.spaceId,
          'X-Run-Id': options.runId,
        },
        body: JSON.stringify({ model: options.model, messages: options.messages, tools: options.tools, stream: true, max_tokens: 4096 }),
      })
    );
    // parse SSE stream line by line
    // each line: 'data: {...}' or 'data: [DONE]'
  } finally { clearTimeout(timer); }
  // The naelao-together-ai worker handles credit reservation before the call and settlement after [DONE]

  async function* streamCompletion(options: RemoteLoopOptions): AsyncGenerator<StreamChunk>
  // Yields StreamChunk for each SSE event
  // On AbortController abort: yield { delta: '', finishReason: 'timeout', toolCalls: undefined }
  // Handles SSE parsing: split by newline, parse 'data: ' prefix

  async function runRemoteLoop(options: RemoteLoopOptions, onChunk: (chunk: StreamChunk) => void): Promise<FinishReason>
  // Calls streamCompletion, invokes onChunk for each chunk
  // Returns the finish reason

Export both the generator and the high-level runRemoteLoop function.

