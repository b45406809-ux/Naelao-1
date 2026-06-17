# Prompt: workers/naelao-agents/src/LocalTunnelDO.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-agents/src/LocalTunnelDO.ts

LocalTunnelDO bridges a local running agent (on developer's machine) to the cloud agent loop.
Uses WebSocket hibernation API.

CRITICAL FIXES:
1. G-F05: Pending calls MUST be stored in SQLite, NOT in a JS Map (Map is lost on DO eviction)
2. LocalTunnelDO MUST use ctx.acceptWebSocket(server, ['local-agent']) (correct, already in spec)
3. Use ctx.storage.setAlarm for timeouts (NOT setTimeout - alarm survives eviction)

class LocalTunnelDO extends DurableObject<Env>:

Schema:
  pending_calls (call_id TEXT PK, agent_run_id TEXT, tool_name TEXT, tool_args TEXT,
                 started_at INTEGER, timeout_ms INTEGER DEFAULT 30000)

HTTP routes:
  GET /ws -> WebSocket upgrade for local agent connection
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['local-agent']);
    return new Response(null, { status: 101, webSocket: server });

  POST /exec { callId; toolName; toolArgs; agentRunId; timeoutMs? }
    -> Store in pending_calls table
    -> Send JSON message to connected local agent WebSocket
    -> Set alarm for timeout: ctx.storage.setAlarm(Date.now() + (timeoutMs ?? 30000))
    -> Wait for response via DO storage poll (use storage.get/waitForResponse pattern)
    -> Return { result: unknown }

  POST /result { callId; result; error? }
    -> Store result in DO storage: storage.put('result:' + callId, { result, error })
    -> Delete from pending_calls

webSocketMessage(ws, message):
  Parse { type: 'result', callId, result, error }
  Store in storage, delete from pending_calls

alarm():
  Sweep pending_calls older than timeout_ms
  For each expired: store timeout error in storage
  Reschedule alarm if more pending calls remain

Generate the complete class.

