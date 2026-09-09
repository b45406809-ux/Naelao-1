Here is the complete, single, fully detailed Markdown specification file for **`specs/phase-7/chunk-04-queue-consumer-and-automation-resilience.md`**, ready to commit directly to your repository:

---

```markdown
---
chunk_id: "phase-7-chunk-04"
phase: 7
include_files:
  - workers/router/wrangler.toml
  - workers/agents/src/do/ConcurrencyDO.ts
  - workers/agents/src/workflows/WorkflowHarness.ts
  - packages/types/src/webhooks.ts
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "workers/router/wrangler.toml"
  - "workers/agents/src/do/ConcurrencyDO.ts"
  - "workers/agents/src/workflows/WorkflowHarness.ts"
  - "packages/types/src/webhooks.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - workers/router/src/queue-consumer.ts
  - workers/agents/src/do/ConcurrencyDO.ts
  - workers/spaces/src/do/SpaceDO.ts
  - workers/router/wrangler.toml
---

# Phase 7 — Chunk 04: Queue Consumer, Leaky-Bucket Pacing & Automation Resilience

## 1. Mental Model & Architectural Vision

Chunk 03 established the ingress gateway that validates inbound third-party webhooks at the edge and places them onto `AUTOMATIONS_QUEUE`. Chunk 04 implements the **Cloudflare Queue Consumer** that pulls these messages, applies strict enterprise resilience defenses, and dispatches them to **Dynamic Workflows**.

Allowing incoming webhook events to trigger external API calls or workflows without a protective consumer layer exposes the platform to four severe operational failure modes:
1. **Downstream API Rate-Limit Bans (The Concurrency Burst Problem):** If an e-commerce store receives 1,000 orders in 30 seconds, firing 1,000 unthrottled API requests to HubSpot, Instagram, or a CRM will trigger HTTP 429 lockouts and IP-level bans.
2. **Replay Storms & Duplicate Invocations:** Providers like Stripe and Shopify retry webhooks if network latency delays the response. Unchecked retries cause duplicate payments, multiple confirmation emails, or corrupt inventory tallies.
3. **The Ouroboros Self-Triggering Loop:** Automation A posts to a CRM, which triggers a webhook to Automation B, which updates a contact and triggers Automation A again. Without an edge circuit breaker, this burns through compute balances in minutes.
4. **Queue Head-of-Line Blocking:** A slow, failing tenant workflow can hold up processing for all other tenants in the queue.

To eliminate these hazards, Chunk 04 establishes a **4-Layer Resilience Defense Pipeline** directly inside the queue consumer:

```
[ AUTOMATIONS_QUEUE (Batch of up to 10 messages) ]
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 📬 QUEUE CONSUMER (`workers/router/src/queue-consumer.ts`)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Ouroboros Loop Circuit Breaker:                                          │
│    • Checks `x-avos-hop-count` in message envelope headers.                 │
│    • If `hop_count > 2` ──► Drop event immediately & log security alert.    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. Idempotency Deduplication (Hash Check):                                  │
│    • Evaluates `SHA-256(provider + eventId + payloadStr)` in SpaceDO SQLite.│
│    • If duplicate within 24 hours ──► Acknowledge (ack) and drop.           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. Leaky-Bucket Rate Pacer (`ConcurrencyDO`):                               │
│    • Controls downstream request rate per space & provider (max 5 req/sec). │
│    • Smooths spiky traffic bursts into steady, compliant dispatches.        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Dynamic Workflow Dispatch (`UniversalWorkflowHarness`):                  │
│    • Launches the target workflow with the verified, deduplicated payload.  │
│    • Increments `x-avos-hop-count` to prevent recursive re-triggering.      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update `workers/router/wrangler.toml`

Configure the queue consumer binding with dead-letter queue (DLQ) support:

```toml
# Cloudflare Queue Consumer for Inbound Webhooks
[[queues.consumers]]
queue = "naelao-inbound-automations"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
dead_letter_queue = "naelao-automations-dlq"
```

---

### B. Update `SpaceDO.ts` with Idempotency Storage & Hash Checking

In `workers/spaces/src/do/SpaceDO.ts`, add the deduplication table to `ensureInit()`:

```sql
-- SQLite Table for Webhook Event Deduplication in SpaceDO
CREATE TABLE IF NOT EXISTS webhook_idempotency_records (
  hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wir_time ON webhook_idempotency_records(processed_at);
```

Add the atomic deduplication check method to `SpaceDO`:

```typescript
/**
 * Atomic deduplication check using SHA-256 payload hash.
 * Returns true if the event is fresh, or false if it is a duplicate replay.
 */
async checkAndRecordIdempotency(provider: string, eventId: string, payloadStr: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${provider}:${eventId}:${payloadStr}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hash = [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Clean entries older than 24 hours to prevent unbounded table growth
  this.ctx.storage.sql.exec(`
    DELETE FROM webhook_idempotency_records 
    WHERE processed_at < datetime('now', '-1 day')
  `);

  // Check if hash was already processed
  const existing = this.ctx.storage.sql.exec(
    `SELECT 1 FROM webhook_idempotency_records WHERE hash = ?`, 
    hash
  ).toArray();

  if (existing.length > 0) {
    return false; // Duplicate replay detected
  }

  // Insert fresh hash record
  this.ctx.storage.sql.exec(
    `INSERT INTO webhook_idempotency_records (hash, provider, event_id, space_id) VALUES (?, ?, ?, ?)`,
    hash, 
    provider, 
    eventId, 
    this.spaceId
  );

  return true; // Fresh event, execution permitted
}
```

Add internal HTTP route handler in `SpaceDO.fetch`:
```typescript
if (url.pathname === "/idempotency/check") {
  const body = await request.json() as { provider: string; eventId: string; payloadStr: string };
  const isFresh = await this.checkAndRecordIdempotency(body.provider, body.eventId, body.payloadStr);
  return Response.json({ isFresh });
}
```

---

### C. Update `ConcurrencyDO.ts` with Leaky-Bucket Rate Pacing

In `workers/agents/src/do/ConcurrencyDO.ts`, add the token bucket / leaky bucket algorithm:

```typescript
export class ConcurrencyDO extends DurableObject {
  private lastLeakTime = Date.now();
  private availableTokens = 5;
  private readonly maxCapacity = 5;
  private readonly fillRatePerSecond = 5; // Enforces a ceiling of 5 requests/second

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/pacer/permit") {
      const permit = await this.acquireRatePermit();
      return Response.json(permit);
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Evaluates available tokens and grants or delays requests to downstream APIs.
   */
  async acquireRatePermit(): Promise<{ granted: boolean; retryAfterMs?: number }> {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastLeakTime) / 1000;
    
    // Replenish tokens based on elapsed time
    this.availableTokens = Math.min(
      this.maxCapacity, 
      this.availableTokens + elapsedSeconds * this.fillRatePerSecond
    );
    this.lastLeakTime = now;

    if (this.availableTokens >= 1) {
      this.availableTokens -= 1;
      return { granted: true };
    }

    // Calculate time until next token becomes available
    const waitMs = Math.ceil(((1 - this.availableTokens) / this.fillRatePerSecond) * 1000);
    return { granted: false, retryAfterMs: Math.max(waitMs, 100) };
  }
}
```

---

### D. Implement Queue Consumer (`workers/router/src/queue-consumer.ts`)

Create `workers/router/src/queue-consumer.ts` to process message batches from `AUTOMATIONS_QUEUE`:

```typescript
import { MessageBatch } from "cloudflare:workers";
import { QueuedAutomationEvent } from "@naelao/types";

export async function processAutomationsQueue(
  batch: MessageBatch<QueuedAutomationEvent>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const event = message.body;

    try {
      // 1. Ouroboros Loop Circuit Breaker
      const rawHopCount = event.rawHeaders?.["x-avos-hop-count"] || "0";
      const hopCount = parseInt(rawHopCount, 10);

      if (hopCount > 2) {
        console.warn(`[Queue Consumer] Ouroboros recursive loop detected for event ${event.eventId} (hop count: ${hopCount}). Dropping.`);
        message.ack(); // Acknowledge to drop from queue
        continue;
      }

      // 2. Idempotency Check in SpaceDO
      const spaceDO = env.SPACE_DO.get(env.SPACE_DO.idFromName(event.spaceId));
      const idempotencyRes = await spaceDO.fetch("http://internal/idempotency/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: event.provider,
          eventId: event.eventId,
          payloadStr: JSON.stringify(event.payload)
        })
      });

      if (!idempotencyRes.ok) {
        console.error(`[Queue Consumer] Failed to verify idempotency for event ${event.eventId}. Retrying later.`);
        message.retry();
        continue;
      }

      const { isFresh } = await idempotencyRes.json() as { isFresh: boolean };
      if (!isFresh) {
        console.log(`[Queue Consumer] Dropping duplicate replay event ${event.eventId} for provider ${event.provider}.`);
        message.ack();
        continue;
      }

      // 3. Leaky-Bucket Rate Pacer (Prevents hitting downstream API rate limits)
      const pacerKey = `pacer:${event.provider}:${event.spaceId}`;
      const pacerDO = env.CONCURRENCY_DO.get(env.CONCURRENCY_DO.idFromName(pacerKey));
      
      const permitRes = await pacerDO.fetch("http://internal/pacer/permit");
      const permit = await permitRes.json() as { granted: boolean; retryAfterMs?: number };

      if (!permit.granted) {
        const sleepDuration = Math.min(permit.retryAfterMs || 1000, 3000);
        await new Promise(resolve => setTimeout(resolve, sleepDuration));
      }

      // 4. Dispatch to Target Dynamic Workflow
      await env.AGENT_WORKFLOW.create({
        id: `wf_${event.eventId}`,
        params: {
          spaceId: event.spaceId,
          projectId: event.projectId,
          workflowId: event.targetWorkflowId,
          scriptPath: `/.avos/shared/workflows/${event.targetWorkflowId}.ts`,
          workflowClass: "COMPANY_AUTOMATION",
          payload: {
            ...event.payload,
            _metadata: {
              eventId: event.eventId,
              provider: event.provider,
              triggerSlug: event.triggerSlug,
              receivedAt: event.receivedAt
            },
            _headers: {
              ...event.rawHeaders,
              "x-avos-hop-count": (hopCount + 1).toString()
            }
          }
        }
      });

      // Acknowledge successful dispatch
      message.ack();
    } catch (err) {
      console.error(`[Queue Consumer] Unhandled error processing event ${event.eventId}:`, err);
      // Let Cloudflare Queue retry the message up to max_retries
      message.retry();
    }
  }
}
```

---

### E. Wire the Queue Handler in the Router Entrypoint (`workers/router/src/index.ts`)

Export the `queue` handler from `workers/router/src/index.ts`:

```typescript
import { processAutomationsQueue } from "./queue-consumer";

export default {
  // Existing HTTP fetch handler
  fetch: app.fetch,

  // Cloudflare Queue Consumer Handler
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    if (batch.queue === "naelao-inbound-automations") {
      await processAutomationsQueue(batch, env);
    }
  }
};
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. **Update `workers/router/wrangler.toml`:**
   * Add the `[[queues.consumers]]` block for `naelao-inbound-automations`.
2. **Update `workers/spaces/src/do/SpaceDO.ts`:**
   * Add `webhook_idempotency_records` table to `ensureInit()`.
   * Implement `checkAndRecordIdempotency()` with 24-hour cleanup.
   * Add `/idempotency/check` route in `SpaceDO.fetch()`.
3. **Update `workers/agents/src/do/ConcurrencyDO.ts`:**
   * Implement the leaky-bucket rate limiter with `acquireRatePermit()` and `/pacer/permit`.
4. **Create `workers/router/src/queue-consumer.ts`:**
   * Implement `processAutomationsQueue` with the Ouroboros loop check, idempotency check, rate-pacer delay, and workflow dispatch.
5. **Update `workers/router/src/index.ts`:**
   * Export the `queue` handler consuming `batch: MessageBatch<any>`.
6. Run `node --check` syntax verification across all modified files.
```
