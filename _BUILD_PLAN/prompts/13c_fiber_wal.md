# Prompt: workers/naelao-agents/src/fiber.ts + wal.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-agents/src/.

=== File 1: src/fiber.ts ===

Fiber management utilities (pure functions, no DO references):

  interface Fiber {
    id: string; runId: string; status: FiberStatus;
    agentId: string; spaceId: string; threadId: string;
    model: string; systemPrompt: string;
    toolBudget: number; toolsUsed: number;
    createdAt: string; updatedAt: string;
  }

  type FiberStatus = 'idle'|'running'|'waiting_tool'|'paused'|'done'|'error';

  createFiber(params: Partial<Fiber> & { runId: string; spaceId: string }): Fiber
  updateFiberStatus(fiber: Fiber, status: FiberStatus): Fiber
  isTerminal(fiber: Fiber): boolean  // done or error
  hasToolBudget(fiber: Fiber): boolean  // toolsUsed < toolBudget

  function truncateMessages(messages: Message[], targetCount: number): Message[]
  // CRITICAL (G-N44 fix): keep FIRST message + last (targetCount-1) messages
  // [messages[0], ...messages.slice(-(targetCount-1))]
  // NOT a splice loop (which reverses messages)

  function buildSystemPrompt(basePrompt: string, context: { spaceId: string; agentId: string; tools: string[] }): string

=== File 2: src/wal.ts ===

Write-Ahead Log for tool calls (ensures exactly-once tool execution on fiber recovery):

  interface WALEntry {
    id: string; runId: string; toolName: string; toolArgs: string;
    toolResult: string | null; status: 'pending'|'running'|'complete'|'failed'|'timeout';
    startedAt: string; completedAt: string | null; error: string | null;
  }

  function createWALEntry(sql: SqlStorage, entry: Omit<WALEntry, 'id'|'startedAt'|'completedAt'|'error'>): WALEntry
  function markWALRunning(sql: SqlStorage, entryId: string): void
  function markWALComplete(sql: SqlStorage, entryId: string, result: unknown): void
  function markWALFailed(sql: SqlStorage, entryId: string, error: string): void
  function markWALTimeout(sql: SqlStorage, entryId: string): void

  function getPendingWALEntries(sql: SqlStorage, runId: string): WALEntry[]
  // CRITICAL: uses index idx_wal_run_status (G-F07 fix)
  // SELECT * FROM run_wal WHERE run_id=? AND status='pending' ORDER BY started_at ASC

  function cleanOldWALEntries(sql: SqlStorage): void
  // DELETE FROM run_wal WHERE status IN ('complete','failed') AND started_at < datetime('now','-7 days')

All functions take sql: SqlStorage as first parameter and use sql.exec<T>().

