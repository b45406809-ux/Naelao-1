# Prompt: workers/naelao-agents/src/NaelaoAgentDO.ts (LARGEST FILE)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-agents/src/NaelaoAgentDO.ts

This is the agent brain - the most complex DO in the system. Read carefully.

RULES:
- import { DurableObject } from 'cloudflare:workers'
- ALL data uses this.ctx.storage.sql.exec<T>()
- WebSocket hibernation: MUST call this.ctx.acceptWebSocket(server, tags) (G-F19 fix)
- JSON.parse in webSocketMessage MUST be in try/catch (G-G07 fix)
- token_buffer MUST be cleaned up after replay (G-F15 fix)
- run_wal MUST have index on (run_id, status) (G-F07 fix)

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_WALLET_DO: DurableObjectNamespace
  NAELAO_CONCURRENCY_DO: DurableObjectNamespace
  NAELAO_THREADS_DO: DurableObjectNamespace
  NAELAO_MCP_HUB: Service  (Service Binding)
  NAELAO_KNOWLEDGE: Service
  NAELAO_CREDENTIALS: Service
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_WORKFLOW_DISPATCH: Queue
  NAELAO_JWT_SECRET: string
  TOGETHER_AI_API_KEY: string
  PLATFORM_DAILY_CREDIT_CEILING: string

Schema (with migrations):
  schema_version (version INTEGER PK DEFAULT 0)
  
  fibers (
    id TEXT PK, run_id TEXT NOT NULL, status TEXT CHECK(IN 'idle','running','waiting_tool','paused','done','error'),
    agent_id TEXT, space_id TEXT, thread_id TEXT, model TEXT, system_prompt TEXT,
    tool_budget INTEGER DEFAULT 50, tools_used INTEGER DEFAULT 0,
    token_buffer_watermark INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT
  )

  run_wal (
    id TEXT PK, run_id TEXT NOT NULL, tool_name TEXT, tool_args TEXT, tool_result TEXT,
    status TEXT CHECK(IN 'pending','running','complete','failed','timeout'),
    started_at TEXT, completed_at TEXT, error TEXT
  )
  INDEX (CRITICAL G-F07): CREATE INDEX IF NOT EXISTS idx_wal_run_status ON run_wal(run_id, status)
  INDEX: CREATE INDEX IF NOT EXISTS idx_wal_started ON run_wal(started_at)

  token_buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL, delta TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()*1000)
  )
  INDEX: CREATE INDEX IF NOT EXISTS idx_tbuf_run ON token_buffer(run_id, id)

  active_websockets (run_id TEXT PK, connected_at TEXT)

HTTP routes (fetch handler):
  POST /runs/start   { threadId; model; systemPrompt; tools; spaceId; agentId } -> { runId }
  POST /runs/cancel  { runId } -> { ok: true }
  GET  /runs/:runId  -> { run }
  POST /runs/:runId/tool-result { callId; output; error? } -> { ok: true }
  GET  /ws           WebSocket upgrade (hibernation API)

WebSocket handler (CRITICAL G-F19 fix):
  async handleWebSocketUpgrade(request):
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [spaceId, runId]);  // MUST call this
    return new Response(null, { status: 101, webSocket: client });

  webSocketMessage(ws, message):  
    // CRITICAL (G-G07): wrap in try/catch
    try {
      if (typeof message !== 'string') { ws.send(JSON.stringify({ type:'error', message:'binary not supported' })); return; }
      const data = JSON.parse(message);
      // handle: { type: 'ping' } -> ws.send('{"type":"pong"}')
      // handle: { type: 'cancel', runId } -> cancelRun(runId)
    } catch (e) { ws.send(JSON.stringify({ type:'error', message:'invalid json' })); }

  webSocketClose(ws, code, reason):
    // clean up active_websockets entry
    // do NOT kill the run - it continues headlessly

Agent loop (called from startRun, runs in background via ctx.waitUntil):
  async runAgentLoop(runId, fiber):
    // Check kill switch: env.NAELAO_CONFIG_KV.get('emergency:kill-all-agents')
    // Check KillSwitchDO via Service Binding (faster, <1ms vs 60s KV propagation)
    // Truncate messages if needed (keep first + last N to fit token budget)
    // Call LLM via fetch to Together AI with AbortController timeout (G-E17 fix, 25s)
    // Stream response, buffer in token_buffer
    // On tool_calls finish reason: write pending WAL entries, execute tools
    // On stop: update fiber to done
    // CRITICAL: clean token_buffer after use: DELETE FROM token_buffer WHERE run_id=? AND id NOT IN (SELECT id FROM token_buffer WHERE run_id=? ORDER BY id DESC LIMIT 500)

Fiber recovery (called on DO restart if run was in-progress):
  async onFiberRecovered(runId):
    // Query run_wal WHERE run_id=? AND status='pending' (uses the index G-F07)
    // Re-execute pending tool calls
    // Resume loop

Generate the complete class. This is production code - no TODOs, no stubs.

