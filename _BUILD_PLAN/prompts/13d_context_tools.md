# Prompt: workers/naelao-agents/src/context-manager.ts + tool-executor.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-agents/src/.

=== File 1: src/context-manager.ts ===

Manages token budget and message truncation for the agent context window.

  const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'meta-llama/Llama-3.3-70B-Instruct-Turbo': 128000,
    'Qwen/Qwen2.5-72B-Instruct-Turbo': 128000,
    'deepseek-ai/DeepSeek-R1': 65536,
    'default': 32768,
  }

  function getContextLimit(model: string): number
  function estimateMessageTokens(messages: Message[]): number  // rough: JSON.stringify.length / 4
  function fitMessagesToBudget(messages: Message[], model: string, reserveForOutput?: number): Message[]
  // Keep systemPrompt (index 0) always
  // Binary search for how many messages fit
  // ALWAYS keep: first message (system) + last N messages
  // truncateMiddle pattern: [messages[0], ...messages.slice(-(n-1))]

  interface ContextWindow {
    messages: Message[];
    estimatedInputTokens: number;
    truncated: boolean;
    droppedCount: number;
  }

  function buildContextWindow(systemPrompt: string, history: Message[], model: string): ContextWindow

=== File 2: src/tool-executor.ts ===

Dispatches built-in tool calls. MCP app tools go through naelao-mcp-hub.

Built-in tools to implement:
  read_file     { path: string } -> { content: string; size: number }
  write_file    { path: string; content: string } -> { ok: true; bytes: number }
  append_to_file { path: string; content: string } -> { ok: true }  (G-E16 fix: atomic R2 with ETag)
  list_files    { path?: string } -> { files: Array<{ name; size; updatedAt }> }
  delete_file   { path: string } -> { ok: true }
  web_search    { query: string; numResults?: number } -> { results: [...] }
  create_thread { title?: string } -> { threadId: string }
  add_message   { threadId: string; content: string } -> { messageId: string }

append_to_file MUST be atomic (G-E16 fix):
  async function atomicAppend(r2: R2Bucket, key: string, content: string, retries = 5): Promise<void>
    for i in 0..retries:
      const obj = await r2.get(key)
      const existing = obj ? await obj.text() : ''
      const etag = obj?.etag
      const result = await r2.put(key, existing + content, etag ? { onlyIf: { etagMatches: etag } } : {})
      if (result) return
    throw new Error('append_to_file: concurrent modification, max retries exceeded')

  interface ToolExecutorEnv {
    NAELAO_WORKSPACE: R2Bucket;
    NAELAO_THREADS_DO: DurableObjectNamespace;
    NAELAO_MCP_HUB: Service;
    NAELAO_JWT_SECRET: string;
  }

  async function executeTool(name: string, args: Record<string,unknown>, runContext: RunContext, env: ToolExecutorEnv): Promise<unknown>
  // Routes to built-in handler or to naelao-mcp-hub for app tools
  // Pass X-Naelao-Idempotency-Key: runId:walEntryId header to MCP hub (G-F13 fix)

