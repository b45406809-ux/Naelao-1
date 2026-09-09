Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 7 — Chunk 04: Edge Ingress Webhook Router, Tombstone Filter & Cloudflare Queues Buffering**.

---

```markdown
---
chunk_id: "phase-7-chunk-04"
phase: 7
include_files:
  - workers/router/src/index.ts
  - workers/router/wrangler.toml
  - packages/types/src/index.ts
  - packages/security/src/index.ts
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "workers/router/src/index.ts"
  - "workers/router/wrangler.toml"
  - "packages/types/src/index.ts"
  - "packages/security/src/index.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - workers/router/src/webhooks.ts
  - workers/router/src/index.ts
  - workers/router/wrangler.toml
  - packages/types/src/webhooks.ts
  - packages/types/src/index.ts
  - packages/security/src/hmac.ts
---

# Phase 7 — Chunk 04: Edge Ingress Webhook Router, Tombstone Filter & Cloudflare Queues Buffering

## 1. Executive Summary & Architectural Vision

In AVOS, external SaaS platforms (Stripe, Shopify, GitHub, Twilio, HubSpot, Meta) trigger company automations and vertical extension workflows via **Inbound Webhooks**. 

Allowing third-party webhooks to hit Durable Objects or Dynamic Workflows directly creates three critical production hazards:
1. **The Zombie Webhook Flood:** When an automation is paused or uninstalled, third-party platforms (like Shopify or Stripe) continue sending thousands of webhooks a day. Waking Durable Objects or launching workflows on dead webhooks results in runaway infrastructure bills.
2. **Concurrency & Rate-Limit Spikes (Black Friday Storms):** An e-commerce burst of 10,000 orders in 10 seconds will trigger 10,000 concurrent workflow executions, instantly hitting downstream third-party rate limits (HTTP 429) and locking API accounts.
3. **Payload Spoofing & Replay Attacks:** Unverified webhook payloads can inject malicious data or trigger unauthorized workflows.

To resolve these hazards, AVOS implements a **3-Stage Edge Ingress Gateway**:
* **Stage 1 (Sub-1ms KV Tombstone & HMAC Validation):** `workers/router` evaluates incoming webhooks at Cloudflare's edge. Paused webhooks return `204 No Content` and deleted webhooks return `410 Gone` in <1ms without waking Durable Objects ($0 compute cost). Cryptographic HMAC-SHA256 signatures are verified before acceptance.
* **Stage 2 (Time-Travel R2 Archive):** Raw webhook bytes are archived into Cloudflare R2 (`webhooks/:spaceId/:year/:month/:day/:eventId.json`) with a 14-day TTL for 1-click debug replays.
* **Stage 3 (Cloudflare Queue Buffering):** Validated events enter `AUTOMATIONS_QUEUE`. Cloudflare Queues paces execution with controlled consumer batching (e.g. max concurrency 5, batch size 10) before dispatching to Dynamic Workflows.

```
[ External SaaS Webhook (Stripe / Shopify / GitHub / HubSpot) ]
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 🌐 EDGE INGRESS GATEWAY (`POST /v1/webhooks/:spaceId/:triggerSlug`)      │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Sub-1ms KV Tombstone Check (`WEBHOOKS_REGISTRY_KV`):                      │
│   - If status == 'DELETED' ──► Return `410 Gone` (Tells provider to stop).  │
│   - If status == 'PAUSED'  ──► Return `204 No Content` ($0 compute cost).   │
│ • Validates HMAC-SHA256 signature against registered webhook secret.        │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │
                            ▼ (If Active & Verified)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. 🗄️ TIME-TRAVEL REPLAY ARCHIVE (Cloudflare R2)                            │
│    Saves raw webhook JSON to `webhooks/:spaceId/:eventId.json` (14-day TTL)│
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. 📬 CLOUDFLARE QUEUE BUFFER (`AUTOMATIONS_QUEUE`)                         │
│    • Absorbs high-volume concurrency bursts.                                │
│    • Consumer batching: 10 messages/batch, max concurrency 5.               │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. ⚡ DYNAMIC WORKFLOW DISPATCH                                              │
│    Dequeues event, checks SQLite idempotency hash, executes business steps. │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Contracts & Types

### Create `packages/types/src/webhooks.ts` and re-export in `packages/types/src/index.ts`:

```typescript
export type WebhookStatus = "ACTIVE" | "PAUSED" | "DELETED";

export type WebhookProvider = "stripe" | "shopify" | "github" | "twilio" | "svix" | "generic";

export interface WebhookRegistration {
  id: string; // e.g. "hook_stripe_disputes_01"
  spaceId: string;
  projectId: string;
  triggerSlug: string; // e.g. "stripe-charge-dispute"
  provider: WebhookProvider;
  status: WebhookStatus;
  secretKey: string; // HMAC secret used for signature verification
  targetWorkflowId: string; // e.g. "wf_dispute_evidence_compiler"
  createdAt: string;
  updatedAt: string;
}

export interface QueuedAutomationEvent {
  eventId: string;
  spaceId: string;
  projectId: string;
  triggerSlug: string;
  provider: WebhookProvider;
  targetWorkflowId: string;
  receivedAt: string;
  payload: Record<string, any>;
  rawHeaders: Record<string, string>;
}

export interface WebhookTombstoneRecord {
  status: WebhookStatus;
  secretKey: string;
  projectId: string;
  provider: WebhookProvider;
  targetWorkflowId: string;
}
```

---

## 3. Cryptographic Signature Verification Helper

### Create `packages/security/src/hmac.ts` and re-export in `packages/security/src/index.ts`:

```typescript
/**
 * Verifies standard HMAC-SHA256 signatures across webhook payloads.
 */
export async function verifyHmacSha256(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  if (!rawBody || !signatureHeader || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Normalize hex or base64 signatures
    let signatureBytes: Uint8Array;
    const cleanSig = signatureHeader.replace(/^sha256=/, "").trim();

    if (/^[0-9a-fA-F]+$/.test(cleanSig)) {
      // Hex representation
      const match = cleanSig.match(/.{1,2}/g);
      signatureBytes = new Uint8Array(match ? match.map((byte) => parseInt(byte, 16)) : []);
    } else {
      // Base64 representation
      const binary = atob(cleanSig);
      signatureBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        signatureBytes[i] = binary.charCodeAt(i);
      }
    }

    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      encoder.encode(rawBody)
    );
  } catch (err) {
    console.error("HMAC verification error:", err);
    return false;
  }
}

/**
 * Verifies Stripe-specific t=timestamp,v1=signature webhook headers.
 */
export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): Promise<boolean> {
  if (!rawBody || !signatureHeader || !secret) return false;

  const parts = signatureHeader.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {} as Record<string, string>);

  const timestamp = parts["t"];
  const signature = parts["v1"];

  if (!timestamp || !signature) return false;

  // Verify timestamp freshness (prevent replay attacks)
  const now = Math.floor(Date.now() / 1000);
  const eventTime = parseInt(timestamp, 10);
  if (isNaN(eventTime) || Math.abs(now - eventTime) > toleranceSeconds) {
    return false;
  }

  const payloadToSign = `${timestamp}.${rawBody}`;
  return await verifyHmacSha256(payloadToSign, signature, secret);
}
```

---

## 4. Router Worker Configuration & Queue Bindings

### Update `workers/router/wrangler.toml`:

```toml
# Bindings for Inbound Webhooks & Event Queueing
[[kv_namespaces]]
binding = "WEBHOOKS_REGISTRY_KV"
id = "naelao-webhooks-registry"

[[queues.producers]]
binding = "AUTOMATIONS_QUEUE"
queue = "naelao-inbound-automations"

[[r2_buckets]]
binding = "WEBHOOK_LAKE_R2"
bucket_name = "naelao-webhook-lake"
```

---

## 5. Implementation of Edge Inbound Webhook Router

### Create `workers/router/src/webhooks.ts`:

```typescript
import { Hono } from "hono";
import { 
  WebhookTombstoneRecord, 
  QueuedAutomationEvent, 
  WebhookProvider 
} from "@naelao/types";
import { 
  verifyHmacSha256, 
  verifyStripeWebhookSignature 
} from "@naelao/security";

export const webhookRouter = new Hono<{ Bindings: Env }>();

/**
 * Inbound Webhook Ingress Endpoint
 * POST /v1/webhooks/:spaceId/:triggerSlug
 */
webhookRouter.post("/v1/webhooks/:spaceId/:triggerSlug", async (c) => {
  const { spaceId, triggerSlug } = c.req.param();
  const rawBody = await c.req.text();

  // Extract signature from standard headers
  const signatureHeader = 
    c.req.header("x-hub-signature-256") || // GitHub
    c.req.header("stripe-signature") ||    // Stripe
    c.req.header("x-shopify-hmac-sha256") ||// Shopify
    c.req.header("x-webhook-signature") || // Generic
    c.req.header("x-signature") || "";

  // 1. Edge Tombstone & Registration Check via Sub-1ms KV
  const registrationKey = `hook:${spaceId}:${triggerSlug}`;
  const registration = await c.env.WEBHOOKS_REGISTRY_KV.get<WebhookTombstoneRecord>(
    registrationKey,
    "json"
  );

  // 410 Gone: Explicitly tells external provider the webhook was permanently deleted
  if (!registration || registration.status === "DELETED") {
    return c.text("Endpoint Gone (Webhook Unregistered)", 410);
  }

  // 204 No Content: Acknowledges receipt without queuing or spending compute
  if (registration.status === "PAUSED") {
    return c.text("Webhook Paused", 204);
  }

  // 2. Validate Cryptographic Signature
  let isSignatureValid = false;
  const provider = registration.provider as WebhookProvider;

  if (provider === "stripe") {
    isSignatureValid = await verifyStripeWebhookSignature(
      rawBody,
      signatureHeader,
      registration.secretKey
    );
  } else {
    isSignatureValid = await verifyHmacSha256(
      rawBody,
      signatureHeader,
      registration.secretKey
    );
  }

  if (!isSignatureValid) {
    console.warn(`[Webhook Ingress] Invalid signature for ${registrationKey}`);
    return c.json({ error: "Invalid cryptographic signature", ok: false }, 401);
  }

  // Parse JSON Payload safely
  let parsedPayload: Record<string, any> = {};
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    parsedPayload = { rawContent: rawBody };
  }

  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const nowIso = new Date().toISOString();

  // 3. Time-Travel Archive to R2 (14-Day Debug Lake)
  const datePath = nowIso.slice(0, 10).replace(/-/g, "/"); // YYYY/MM/DD
  const r2Key = `webhooks/${spaceId}/${datePath}/${eventId}.json`;

  try {
    await c.env.WEBHOOK_LAKE_R2.put(r2Key, rawBody, {
      customMetadata: {
        spaceId,
        triggerSlug,
        provider,
        targetWorkflowId: registration.targetWorkflowId,
        receivedAt: nowIso
      }
    });
  } catch (err) {
    console.error("[Webhook Ingress] Failed to archive to R2 lake:", err);
    // Non-fatal: proceed to queue even if archiving logs an error
  }

  // 4. Enqueue into Cloudflare Queue (Buffer Concurrency Spikes)
  const queueEvent: QueuedAutomationEvent = {
    eventId,
    spaceId,
    projectId: registration.projectId,
    triggerSlug,
    provider,
    targetWorkflowId: registration.targetWorkflowId,
    receivedAt: nowIso,
    payload: parsedPayload,
    rawHeaders: {
      "user-agent": c.req.header("user-agent") || "",
      "content-type": c.req.header("content-type") || "application/json"
    }
  };

  await c.env.AUTOMATIONS_QUEUE.send(queueEvent);

  return c.json({
    ok: true,
    status: "ENQUEUED",
    eventId,
    trigger: triggerSlug
  }, 202);
});
```

---

## 6. Mount in Main Router (`workers/router/src/index.ts`)

Update `workers/router/src/index.ts` to mount `webhookRouter` before any authenticated route groups:

```typescript
import { webhookRouter } from "./webhooks";

// Mount public webhook ingress router (Unauthenticated at router, validated via HMAC)
app.route("/", webhookRouter);
```

---

## 7. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/webhooks.ts` with `WebhookRegistration`, `QueuedAutomationEvent`, and `WebhookTombstoneRecord`. Re-export from `packages/types/src/index.ts`.
2. Create `packages/security/src/hmac.ts` with `verifyHmacSha256` and `verifyStripeWebhookSignature`. Re-export from `packages/security/src/index.ts`.
3. Update `workers/router/wrangler.toml` to declare `WEBHOOKS_REGISTRY_KV`, `AUTOMATIONS_QUEUE`, and `WEBHOOK_LAKE_R2`.
4. Create `workers/router/src/webhooks.ts` with the edge tombstone check (`410`/`204`), HMAC verification, R2 time-travel archiving, and Cloudflare Queue dispatch.
5. Mount `webhookRouter` in `workers/router/src/index.ts`.
6. Run `node --check` syntax checks across all modified and created files.
```
