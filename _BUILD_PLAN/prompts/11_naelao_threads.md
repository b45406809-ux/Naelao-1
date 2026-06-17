# Prompt: workers/naelao-threads/src/ (2 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-threads/src/.

Env:
  NAELAO_THREADS_DO: DurableObjectNamespace
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_JWT_SECRET: string
  ThreadsDO: DurableObjectNamespace  (export the DO class)

=== File 1: src/ThreadsDO.ts ===

Durable Object for thread + message storage. One DO per thread.

class ThreadsDO extends DurableObject<Env> using SQLite.

Schema:
  schema_version (version INTEGER PK DEFAULT 0)
  
  threads (id TEXT PK, space_id TEXT NOT NULL, project_id TEXT, title TEXT,
           created_at TEXT, updated_at TEXT, archived_at TEXT)
  
  messages (id TEXT PK, thread_id TEXT NOT NULL, role TEXT CHECK(IN 'user','assistant','tool','system'),
            content TEXT NOT NULL, tool_call_id TEXT, seq INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')))
  INDEX: idx_msg_thread_seq ON messages(thread_id, seq ASC)

  device_tokens used via SpaceDO - do not duplicate here

CRITICAL FIX (G-E01): The addMessage handler MUST use 'this.sql' not an undefined 'db' variable.
  this.sql.exec('INSERT INTO messages ...', ...)   -- CORRECT
  db.exec(...)                                      -- WRONG - throws ReferenceError

CRITICAL FIX (G-E21): Messages use seq for pagination (NOT created_at cursor - timestamps not unique):
  seq is a monotonically increasing integer per thread
  Assign: SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE thread_id=?

Fetch routes:
  POST /threads/create     { spaceId; projectId?; title? } -> { thread }
  GET  /threads/:id        -> { thread }
  DELETE /threads/:id      -> { ok: true }
  POST /messages/add       { threadId; role; content; toolCallId? } -> { message }
  GET  /messages/:threadId { limit?:100; cursor?: seq_number } -> { messages; nextCursor }
    CURSOR PAGINATION: WHERE thread_id=? AND seq > ? ORDER BY seq ASC LIMIT ?
    (NOT offset, NOT created_at)
  DELETE /messages/:id     -> { ok: true }

=== File 2: src/index.ts ===

Hono Worker.

Env:
  NAELAO_THREADS_DO: DurableObjectNamespace
  NAELAO_JWT_SECRET: string

Helper: getThreadsDO(threadId, env) -> DO stub keyed by threadId

Routes:
  POST /v1/threads                      { projectId?; title? } -> thread
  GET  /v1/threads/:threadId            -> thread
  DELETE /v1/threads/:threadId          -> ok
  POST /v1/threads/:threadId/messages   { role; content; toolCallId? } -> message
  GET  /v1/threads/:threadId/messages   ?cursor=&limit= -> { messages; nextCursor }
  GET  /v1/threads/:threadId/stream     SSE stream of new messages

SSE stream (G-E06 fix): Use the CORRECT agentId from jwt (not hardcoded '_'):
  const agentId = c.req.query('agentId') ?? c.get('jwt').sub;
  // Never use idFromName('_')

All routes require authMiddleware. Import it from './middleware' (stub).

