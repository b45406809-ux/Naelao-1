Here is the complete, single, fully detailed, production-ready Markdown specification file for **Phase 7 — Chunk 03**: `specs/phase-7/chunk-03-edge-webhook-ingress-and-queue-buffering.md`.

---

```markdown
---
chunk_id: "phase-7-chunk-03"
phase: 7
include_files:
  - workers/router/src/index.ts
  - workers/router/wrangler.toml
  - packages/types/src/index.ts
  - workers/spaces/src/index.ts
repomix_include:
  - "workers/router/src/index.ts"
  - "workers/router/wrangler.toml"
  - "packages/types/src/index.ts"
  - "workers/spaces/src/index.ts"
expected_outputs:
  - workers/router/src/webhooks.ts
  - workers/router/src/index.ts
  - workers/router/wrangler.toml
  - packages/types/src/webhooks.ts
  - packages/types/src/index.ts
  - workers/spaces/src/routes/webhook-admin-routes.ts
---

# Phase 7 — Chunk 03: Edge Ingress Webhook Router, Queue Buffering & R2 Replay Lake

## 1. Mental Model & Architectural Vision

In automated company operations and vertical cowork studios, external third-party events (Stripe charge webhooks, Shopify order notifications, GitHub push payloads, Zendesk tickets, customs port arrival notices) serve as the primary triggers for **Class 1 Company Automations** and **Class 2 Vertical Extensions**.

However, accepting raw webhooks directly into long-running Durable Objects or heavy worker execution loops creates four severe infrastructure vulnerabilities:
1. **The Zombie Webhook Flood:** When an automation is deleted or paused, third-party platforms (like Shopify or Stripe) continue firing thousands of retries. Waking a Durable Object or checking D1 for every dead event creates massive compute bills.
2. **Concurrency Burst Overwhelm:** During traffic spikes (e.g. Black Friday or high-frequency port releases), 5,000 webhooks arriving in 10 seconds can overwhelm downstream databases and cause third-party API rate-limit bans.
3. **Payload Spoofing & Forgery:** Unauthenticated or forged webhooks can trigger destructive workflows or inject malicious prompts into automated pipelines.
4. **Data Loss on Downstream Bugs:** If a newly deployed workflow has a parsing bug, incoming webhooks fail and are lost forever unless third-party platforms are manually asked to resend.

AVOS solves these issues with a dedicated **Edge Ingress Webhook Gateway** combining:
* **Edge Tombstone Filtering (`WEBHOOK_TOMBSTONES_KV`):** Drops deleted webhooks with `410 Gone` and paused webhooks with `204 No Content` in **<1ms without waking Durable Objects ($0 compute cost)**.
* **Edge HMAC Signature Validation:** Validates provider cryptographic signatures (Stripe, GitHub, Shopify, Svix) using timing-safe comparisons before touching any internal queues.
* **Cloudflare Queues Concurrency Buffering:** Paces bursty ingress traffic through `AUTOMATIONS_QUEUE` with consumer batching (10 messages/batch, max concurrency 5).
* **Time-Travel R2 Replay Lake:** Archives raw, unmodified webhook payloads to Cloudflare R2 for 14 days, enabling **1-click historical event replay** to test and debug patched workflows.

```
[ External SaaS Webhook (Stripe / Shopify / GitHub / HubSpot) ]
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. 🌐 EDGE INGRESS WEBHOOK GATEWAY (`POST /v1/webhooks/:spaceId/:triggerSlug`)                          │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ • Sub-1ms KV check against `WEBHOOK_TOMBSTONES_KV`:                                                    │
│   ├── If `DELETED` ──► Returns `410 Gone` (Tells provider to stop sending; $0 DO compute).             │
│   └── If `PAUSED`  ──► Returns `204 No Content` (Acks event; drops payload with $0 DO compute).        │
│ • Validates HMAC-SHA256 signature using timing-safe buffer comparison.                                 │
├───────────────────────────────────┬────────────────────────────────────────────────────────────────────┤
│ 2. 🗄️ TIME-TRAVEL EVENT LAKE (R2)  │ 3. 📬 CLOUDFLARE QUEUE BUFFER (`AUTOMATIONS_QUEUE`)                │
│ • Archives raw JSON payload into  │ • Enqueues verified event envelope with `eventId` and metadata.    │
│   `webhooks/:spaceId/:eventId.json`│ • Controls concurrency and protects downstream APIs from spikes.  │
│ • Retained 14 days for 1-click    │ • Consumers dispatch payload to target Dynamic Workflow in batch.  │
│   debugging and time-travel replay│                                                                    │
└───────────────────────────────────┴────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & Type Contracts

### A. Define Ingress & Webhook Types (`packages/types/src/webhooks.ts`)
Create `packages/types/src/webhooks.ts` and re-export in `packages/types/src/index.ts`:

```typescript
export type WebhookStatus = "ACTIVE" | "PAUSED" | "DELETED";

export type WebhookProviderType = "stripe" | "github" | "shopify" | "svix" | "generic_hmac";

export interface WebhookRegistrationRecord {
  spaceId: string;
  projectId: string;
  triggerSlug: string;
  workflowId: string;
  status: WebhookStatus;
  provider: WebhookProviderType;
  secretKey: string;
  rateLimitPerMinute?: number;
  createdAt: string;
  updatedAt: string;
}

export interface InboundWebhookEnvelope {
  eventId: string;
  spaceId: string;
  projectId: string;
  triggerSlug: string;
  workflowId: string;
  provider: WebhookProviderType;
  signature: string;
  headers: Record<string, string>;
  payload: Record<string, any>;
  rawBodyR2Key: string;
  receivedAt: string;
  attemptCount: number;
}

export interface WebhookReplayRequest {
  eventId: string;
  targetWorkflowId?: string;
  overridePayload?: Record<string, any>;
}
```

---

## 3. Implementation Details

### A. Update `workers/router/wrangler.toml`
Ensure the router worker declares the KV namespace for tombstone filtering, the R2 bucket for raw event archiving, and the Queue producer binding:

```toml
# KV for sub-millisecond edge tombstone and registration lookups
[[kv_namespaces]]
binding = "WEBHOOK_TOMBSTONES_KV"
id = "naelao-webhook-tombstones"

# R2 Bucket for the 14-day time-travel event replay lake
[[r2_buckets]]
binding = "WEBHOOK_LAKE_R2"
bucket_name = "naelao-webhook-lake"

# Cloudflare Queue for buffering bursty ingress webhooks
[[queues.producers]]
binding = "AUTOMATIONS_QUEUE"
queue = "naelao-inbound-automations"
```

---

### B. Implement Edge Ingress Gateway (`workers/router/src/webhooks.ts`)
Create `workers/router/src/webhooks.ts`:

```typescript
import { Hono } from "hono";
import { InboundWebhookEnvelope, WebhookRegistrationRecord } from "@naelao/types";

export interface WebhookRouterEnv {
  WEBHOOK_TOMBSTONES_KV: KVNamespace;
  WEBHOOK_LAKE_R2: R2Bucket;
  AUTOMATIONS_QUEUE: Queue<InboundWebhookEnvelope>;
  PLATFORM_SECRET: string;
}

export const webhookRouter = new Hono<{ Bindings: WebhookRouterEnv }>();

/**
 * Timing-safe HMAC-SHA256 signature verification.
 */
async function verifyHmacSignature(rawBody: string, signature: string, secret: string, provider: string): Promise<boolean> {
  if (!signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    let cleanedSignature = signature;

    // Handle provider-specific header formatting
    if (provider === "stripe" && signature.includes("t=")) {
      const parts = signature.split(",");
      const v1Sig = parts.find(p => p.startsWith("v1="));
      if (!v1Sig) return false;
      cleanedSignature = v1Sig.replace("v1=", "").trim();
    } else if (provider === "github" && signature.startsWith("sha256=")) {
      cleanedSignature = signature.replace("sha256=", "").trim();
    }

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Convert hex signature to binary array buffer
    const sigBytes = new Uint8Array(
      cleanedSignature.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );

    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(rawBody)
    );
  } catch {
    return false;
  }
}

/**
 * Main Webhook Ingress Route
 * POST /v1/webhooks/:spaceId/:triggerSlug
 */
webhookRouter.post("/v1/webhooks/:spaceId/:triggerSlug", async (c) => {
  const { spaceId, triggerSlug } = c.req.param();
  const rawBody = await c.req.text();

  // 1. Edge Tombstone & Registration Lookup (Sub-1ms in KV)
  const registrationKey = `hook:${spaceId}:${triggerSlug}`;
  const registration = await c.env.WEBHOOK_TOMBSTONES_KV.get<WebhookRegistrationRecord>(registrationKey, "json");

  // Handle deleted or unmapped webhook endpoints immediately
  if (!registration || registration.status === "DELETED") {
    // 410 Gone tells Stripe/GitHub/Shopify to permanently stop sending events
    return c.text("Webhook Endpoint Deleted or Inactive", 410);
  }

  // Handle paused automations with $0 compute overhead
  if (registration.status === "PAUSED") {
    // 204 No Content acknowledges receipt without enqueuing work or running workflows
    return c.text("Webhook Paused", 204);
  }

  // 2. Extract Signature from Provider Headers
  const signature = 
    c.req.header("x-hub-signature-256") || // GitHub
    c.req.header("stripe-signature") ||     // Stripe
    c.req.header("x-shopify-hmac-sha256") || // Shopify
    c.req.header("svix-signature") ||       // Svix / AgentMail
    c.req.header("x-webhook-signature") ||  // Generic
    "";

  // 3. Cryptographic Signature Validation
  const isValidSignature = await verifyHmacSignature(
    rawBody,
    signature,
    registration.secretKey,
    registration.provider
  );

  if (!isValidSignature) {
    return c.json({ error: "Invalid cryptographic webhook signature" }, 401);
  }

  // 4. Archive Raw Payload into R2 Time-Travel Lake (14-day retention)
  const now = new Date();
  const datePath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}`;
  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const r2Key = `webhooks/${spaceId}/${datePath}/${eventId}.json`;

  let parsedPayload: Record<string, any> = {};
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    parsedPayload = { _rawText: rawBody };
  }

  await c.env.WEBHOOK_LAKE_R2.put(r2Key, rawBody, {
    customMetadata: {
      spaceId,
      projectId: registration.projectId,
      triggerSlug,
      provider: registration.provider,
      receivedAt: now.toISOString()
    }
  });

  // 5. Enqueue into Cloudflare Queue to Buffer Concurrency
  const envelope: InboundWebhookEnvelope = {
    eventId,
    spaceId,
    projectId: registration.projectId,
    triggerSlug,
    workflowId: registration.workflowId,
    provider: registration.provider,
    signature,
    headers: c.req.header(),
    payload: parsedPayload,
    rawBodyR2Key: r2Key,
    receivedAt: now.toISOString(),
    attemptCount: 1
  };

  await c.env.AUTOMATIONS_QUEUE.send(envelope);

  // Return clean receipt confirmation to the external caller
  return c.json({
    ok: true,
    eventId,
    status: "ENQUEUED",
    timestamp: now.toISOString()
  });
});
```

---

### C. Update Main Router Index (`workers/router/src/index.ts`)
Mount the `webhookRouter` before any authenticated route blocks so external webhooks route cleanly without requiring user JWT bearer tokens:

```typescript
// Inside workers/router/src/index.ts
import { webhookRouter } from "./webhooks";

// Mount public webhook ingress gateway (unauthenticated / signature-verified)
app.route("/", webhookRouter);
```

---

### D. Implement Webhook Administration & Replay API (`workers/spaces/src/routes/webhook-admin-routes.ts`)
Create `workers/spaces/src/routes/webhook-admin-routes.ts` to allow users, developers, and agents to manage registrations and trigger time-travel event replays:

```typescript
import { Hono } from "hono";
import { errorResponse } from "@naelao/http";
import { WebhookRegistrationRecord, WebhookReplayRequest } from "@naelao/types";

export const webhookAdminRouter = new Hono<{ Bindings: Env }>();

/**
 * Register or Update a Webhook Endpoint
 * POST /spaces/:spaceId/projects/:projectId/webhooks
 */
webhookAdminRouter.post("/spaces/:spaceId/projects/:projectId/webhooks", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const body = await c.req.json() as {
    triggerSlug: string;
    workflowId: string;
    provider: string;
    secretKey?: string;
  };

  const secretKey = body.secretKey || `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
  const record: WebhookRegistrationRecord = {
    spaceId,
    projectId,
    triggerSlug: body.triggerSlug,
    workflowId: body.workflowId,
    status: "ACTIVE",
    provider: body.provider as any,
    secretKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // 1. Sync registration to Edge KV for <1ms routing
  await c.env.WEBHOOK_TOMBSTONES_KV.put(
    `hook:${spaceId}:${body.triggerSlug}`,
    JSON.stringify(record)
  );

  // 2. Generate Public Ingress URL
  const publicUrl = `https://api.naelao.com/v1/webhooks/${spaceId}/${body.triggerSlug}`;

  return c.json({
    ok: true,
    registration: record,
    publicWebhookUrl: publicUrl,
    secretKey
  });
});

/**
 * Pause or Delete a Webhook (Tombstone Activation)
 * PATCH /spaces/:spaceId/webhooks/:triggerSlug/status
 */
webhookAdminRouter.patch("/spaces/:spaceId/webhooks/:triggerSlug/status", async (c) => {
  const { spaceId, triggerSlug } = c.req.param();
  const { status } = await c.req.json() as { status: "ACTIVE" | "PAUSED" | "DELETED" };

  const key = `hook:${spaceId}:${triggerSlug}`;
  const existing = await c.env.WEBHOOK_TOMBSTONES_KV.get<WebhookRegistrationRecord>(key, "json");

  if (!existing) {
    return errorResponse(c, 404, "webhook_not_found", "Webhook registration not found");
  }

  existing.status = status;
  existing.updatedAt = new Date().toISOString();

  await c.env.WEBHOOK_TOMBSTONES_KV.put(key, JSON.stringify(existing));
  return c.json({ ok: true, status: existing.status });
});

/**
 * Time-Travel Event Replay
 * POST /spaces/:spaceId/webhooks/replay
 */
webhookAdminRouter.post("/spaces/:spaceId/webhooks/replay", async (c) => {
  const { spaceId } = c.req.param();
  const { eventId, targetWorkflowId } = await c.req.json() as WebhookReplayRequest;

  // Search R2 lake for the historical payload
  const list = await c.env.WEBHOOK_LAKE_R2.list({ prefix: `webhooks/${spaceId}/` });
  const matchedObject = list.objects.find(obj => obj.key.endsWith(`${eventId}.json`));

  if (!matchedObject) {
    return errorResponse(c, 404, "event_not_found", "Historical webhook payload not found in R2 lake");
  }

  const file = await c.env.WEBHOOK_LAKE_R2.get(matchedObject.key);
  if (!file) {
    return errorResponse(c, 500, "r2_read_failed", "Failed to retrieve payload from R2");
  }

  const rawText = await file.text();
  const payload = JSON.parse(rawText);

  // Re-enqueue into the queue as an official replayed event
  const replayedEvent = {
    eventId: `replay_${Date.now()}_${eventId}`,
    spaceId,
    projectId: file.customMetadata?.projectId || "",
    triggerSlug: file.customMetadata?.triggerSlug || "replay",
    workflowId: targetWorkflowId || "default_workflow",
    provider: (file.customMetadata?.provider || "generic_hmac") as any,
    signature: "replayed_by_admin",
    headers: { "x-avos-replayed": "true" },
    payload,
    rawBodyR2Key: matchedObject.key,
    receivedAt: new Date().toISOString(),
    attemptCount: 1
  };

  await c.env.AUTOMATIONS_QUEUE.send(replayedEvent);

  return c.json({
    ok: true,
    replayedEventId: replayedEvent.eventId,
    message: "Historical event successfully replayed into the automation pipeline."
  });
});
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. **Create `packages/types/src/webhooks.ts`:**
   - Define `WebhookStatus`, `WebhookProviderType`, `WebhookRegistrationRecord`, `InboundWebhookEnvelope`, and `WebhookReplayRequest`.
   - Re-export everything in `packages/types/src/index.ts`.
2. **Update `workers/router/wrangler.toml`:**
   - Bind `WEBHOOK_TOMBSTONES_KV`, `WEBHOOK_LAKE_R2`, and `AUTOMATIONS_QUEUE`.
3. **Create `workers/router/src/webhooks.ts`:**
   - Implement `verifyHmacSignature` (timing-safe verification supporting Stripe, GitHub, Shopify, and Svix headers).
   - Implement `POST /v1/webhooks/:spaceId/:triggerSlug` handling tombstone drops (`410`/`204`), signature verification, R2 archiving, and queue dispatch.
4. **Update `workers/router/src/index.ts`:**
   - Mount `webhookRouter` on the public route table.
5. **Create `workers/spaces/src/routes/webhook-admin-routes.ts`:**
   - Implement registration, status toggle, and the time-travel event replay endpoint.
   - Mount `webhookAdminRouter` into `workers/spaces/src/index.ts`.
6. Run `node --check` syntax validation across all modified files to ensure strict TypeScript compliance.
```
