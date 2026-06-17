# Prompt 13a — naelao-agents Worker Entry Point

## File to Generate
`workers/naelao-agents/src/index.ts`

## Context
Naelao runs entirely on Cloudflare Workers + Durable Objects. The `naelao-agents` worker is
the HTTP entry point for agent operations. It routes requests to Durable Objects:
- `NaelaoAgentDO` — the core agent brain (WebSocket + HTTP)
- `ConcurrencyDO` — gating concurrent agent runs per space
- `WalletDO` — credit checks before allowing new runs

The worker uses Hono for routing and authenticates via a shared JWT middleware (Service Binding
to `naelao-auth`). All inter-worker calls use Service Bindings, never fetch().

## Environment Bindings (wrangler.jsonc)
```
NAELAO_AGENT_DO    — DurableObjectNamespace (NaelaoAgentDO)
NAELAO_CONCURRENCY_DO — DurableObjectNamespace (ConcurrencyDO)
NAELAO_WALLET_DO   — DurableObjectNamespace (WalletDO)
AUTH_SERVICE       — Service<AuthWorkerEnv>      (naelao-auth worker)
SPACES_SERVICE     — Service<SpacesWorkerEnv>    (naelao-spaces worker)
CREDENTIALS_SERVICE — Service<CredentialsWorkerEnv>
KV_SESSIONS        — KVNamespace
JWT_SECRET         — string
AGENT_RUN_TIMEOUT_MS — string (default "300000" = 5 min)
```

## Durable Object ID Patterns
- `NaelaoAgentDO`: named by `runId` (UUID v4, generated at run-start)
- `ConcurrencyDO`: named by `spaceId` (one gate per space)
- `WalletDO`: named by `userId`

## Routes

### POST /agents/run/start
Start a new agent run.

**Auth:** Require valid JWT (userId, spaceId must be in token).

**Body:**
```typescript
{ spaceId: string; nodeId: string; instructions: string; model?: string; }
```

**Logic:**
1. Verify user is member of spaceId (call `SPACES_SERVICE.fetch('/internal/members/check')`
   with `{ userId, spaceId }` in JSON body — expect `{ isMember: boolean }`)
2. Check concurrency gate: call `ConcurrencyDO` stub `.fetch('/acquire', { method:'POST',
   body: JSON.stringify({ runId, maxConcurrent: 3 }) })` — 429 if gate returns 429
3. Generate `runId = crypto.randomUUID()`
4. Stub `NaelaoAgentDO` by name `runId`, call `.fetch('/init', { method:'POST', body:
   JSON.stringify({ spaceId, nodeId, userId, instructions, model, runId }) })`
5. Return `{ runId, wsUrl: '/agents/run/' + runId + '/ws' }`

### GET /agents/run/:runId/ws
Upgrade to WebSocket for a live agent run.

**Auth:** Accept `?token=<jwt>` query param OR `Authorization: Bearer` header (browsers
can't set headers on WebSocket upgrades).

**Logic:**
1. Validate JWT from query param or header
2. Look up `NaelaoAgentDO` stub by name `runId`
3. Forward the entire request (including Upgrade headers) to the DO:
   ```typescript
   return doStub.fetch(request);
   ```
   The DO handles the WebSocket upgrade internally via `acceptWebSocket`.

### GET /agents/run/:runId/status
Poll run status without WebSocket.

**Auth:** JWT required.

**Logic:** Forward to `NaelaoAgentDO.fetch('/status')`, return response.

### POST /agents/run/:runId/cancel
Cancel an in-flight run.

**Auth:** JWT required. Must be run owner (check via DO `/status` which returns `userId`).

**Logic:**
1. Fetch DO `/status` → verify `status.userId === tokenUserId`
2. Call DO `POST /cancel`
3. Release concurrency gate: `ConcurrencyDO.fetch('/release', { method:'POST',
   body: JSON.stringify({ runId }) })`
4. Return `{ cancelled: true }`

### GET /agents/runs (list user's recent runs)
**Auth:** JWT required.
**Query:** `?spaceId=<id>&limit=20&cursor=<runId>`

**Logic:** Call `SPACES_SERVICE.fetch('/internal/agents/runs', ...)` which queries
SpaceDO for run metadata. Return paginated list.

### DELETE /agents/run/:runId
Delete run artifacts (R2 transcript, etc.).

**Auth:** JWT required, must be run owner.

**Logic:** Call DO `DELETE /` → DO cleans up its state and returns `{ deleted: true }`.

## Error Handling
- 401 if JWT missing/invalid
- 403 if not space member
- 404 if DO returns 404 (run not found)
- 429 if concurrency gate full (include `Retry-After: 5` header)
- 500 with `{ error: 'internal_error', traceId }` for unexpected errors

## Middleware
```typescript
// Extract traceId from X-Trace-ID header (set by naelao-router), or generate one
const traceId = c.req.header('X-Trace-ID') ?? crypto.randomUUID();
c.set('traceId', traceId);
c.header('X-Trace-ID', traceId);
```

## DO Stub Helper
```typescript
function agentStub(env: Env, runId: string) {
  return env.NAELAO_AGENT_DO.get(env.NAELAO_AGENT_DO.idFromName(runId));
}
function concurrencyStub(env: Env, spaceId: string) {
  return env.NAELAO_CONCURRENCY_DO.get(env.NAELAO_CONCURRENCY_DO.idFromName(spaceId));
}
```

## Output
Generate the complete `workers/naelao-agents/src/index.ts` using Hono. Export:
- Named `NaelaoAgentDO` class re-export from `./NaelaoAgentDO`
- Named `ConcurrencyDO` class re-export from `./ConcurrencyDO`
- Named `WalletDO` class re-export from `./WalletDO`
- Default export: Hono app wrapped in `{ fetch: app.fetch }`

The file must also export the `Env` interface used by the worker and all DOs.

Keep the total file under 250 lines. All JWT verification must call the shared
`naelao-auth` package, not re-implement it.
