# Prompt: workers/naelao-together-ai/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-together-ai/src/index.ts

Proxy + fine-tuning integration for Together AI. All LLM calls route through here.

CRITICAL FIX (G-E12): Streaming billing MUST use reservation pattern:
  1. Reserve credits BEFORE streaming: walletDO /reserve { amount: maxCredits }
  2. Stream response
  3. Settle AFTER with actual usage: walletDO /settle { reservationId; actual: actualCredits }
  4. Use ctx.waitUntil(settle()) - ensures settlement runs even if client disconnects

Env:
  TOGETHER_AI_API_KEY: string
  NAELAO_WALLET_DO: DurableObjectNamespace
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_JWT_SECRET: string

Routes (all require authMiddleware):

  POST /v1/ai/chat
    { model: string; messages: ChatMessage[]; stream?: boolean; tools?: ToolDef[]; spaceId: string; runId?: string }
    
    Implementation:
    1. Look up credit rate for model (credits per 1000 tokens)
    2. Reserve max credits: walletDO /reserve { amount: maxCredits }
    3. Forward to Together AI: fetch('https://api.together.xyz/v1/chat/completions', { ... signal: abortController.signal })
    4. Stream response to client
    5. Count actual tokens from usage field in final chunk
    6. ctx.waitUntil(walletDO.settle(reservationId, actualCredits))
    7. Log to analytics

  POST /v1/ai/finetune/start
    { model: string; dataset: string[]; epochs?: number; spaceId: string }
    -> Submit fine-tune job to Together AI
    -> Store job in SpaceDO (FinetuneJobDO pattern - but use SpaceDO Service Binding, NOT db.query())
    -> Return { jobId; status: 'queued' }

  GET /v1/ai/finetune/:jobId/status
    -> Fetch job status from Together AI API
    -> Update SpaceDO if status changed
    -> Return { status; resultModel? }

Together AI model credit rates (credits per 1000 tokens):
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': 10
  'Qwen/Qwen2.5-72B-Instruct-Turbo': 15
  'deepseek-ai/DeepSeek-R1': 25
  default: 20

