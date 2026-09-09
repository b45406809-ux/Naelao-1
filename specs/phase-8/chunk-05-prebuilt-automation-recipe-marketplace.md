Here is the complete, full, long, and ultra-detailed specification file for **Phase 8 — Chunk 05** (`specs/phase-8/chunk-05-prebuilt-automation-recipe-marketplace.md`). 

It provides the complete blueprint for bundling Inbound Edge Webhooks, Cloudflare Queues, Dynamic Workflows, and Stateful Gadgets into turn-key automation recipes that users can install in 1 click.

---

```markdown
---
chunk_id: "phase-8-chunk-05"
phase: 8
include_files:
  - workers/spaces/src/template-catalog.ts
  - packages/types/src/index.ts
  - packages/events/src/business-feature-kinds.ts
repomix_include:
  - "workers/spaces/src/template-catalog.ts"
  - "packages/types/src/index.ts"
  - "packages/events/src/business-feature-kinds.ts"
expected_outputs:
  - workers/spaces/src/template-catalog.ts
  - packages/types/src/recipe.ts
  - packages/types/src/index.ts
  - workers/agents/src/workflows/recipe-executors.ts
---

# Phase 8 — Chunk 05: Prebuilt Automation Recipe Marketplace

## 1. Mental Model & Architectural Vision

To demonstrate platform capabilities and eliminate blank-canvas paralysis, AVOS features a marketplace of **Ready-to-Deploy Automation Recipes**.

In traditional automation platforms (like Zapier or Make), building a multi-app bridge requires configuring triggers, setting up filters, writing mapping code, and provisioning external databases. In AVOS, an **Automation Recipe** packages an entire event-driven pipeline into a single installable capability pack:
* **The Inbound Edge Webhook Slug:** An automatic public endpoint (`https://webhooks.avos.app/v1/:spaceId/:slug`) that verifies cryptographic HMAC signatures (Stripe, Shopify, GitHub) in sub-2ms.
* **The Cloudflare Queue Buffer:** Buffers traffic spikes (e.g. 10,000 Shopify webhooks during a flash sale) into rate-limited worker batches.
* **The Dynamic Workflow Consumer (`WorkflowEntrypoint`):** Executes multi-step business logic with step retries and dormant sleeping.
* **The Stateful Gadget:** A private DO Facet SQLite database that retains state, customer data, and audit ledgers specific to that automation.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 PREBUILT AUTOMATION RECIPE ARCHITECTURE                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ [ External SaaS Webhook (Shopify / Stripe / GitHub) ]                       │
│                                    │                                        │
│                                    ▼                                        │
│ 1. 🌐 EDGE WEBHOOK INGRESS GATEWAY (`workers/router/src/webhooks.ts`)       │
│    • Verifies HMAC signatures in sub-2ms.                                   │
│    • Drops zombie webhooks or enqueues active payloads.                     │
├────────────────────────────────────┬────────────────────────────────────────┤
│ 2. 📬 CLOUDFLARE QUEUE BUFFER      │ Paces traffic spikes into batches.     │
├────────────────────────────────────┴────────────────────────────────────────┤
│ 3. 🔄 DYNAMIC WORKFLOW CONSUMER (`WorkflowEntrypoint`)                      │
│    • Executes multi-step logic with durable checkpoints & sleeps.           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. 🗄️ STATEFUL GADGET (DO Facet SQLite DB)                                   │
│    • Persists operational state, audit logs, and status trackers.           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Define Recipe Types (`packages/types/src/recipe.ts`)
Create `packages/types/src/recipe.ts` and re-export in `packages/types/src/index.ts`:

```typescript
export type RecipeCategory = "COMMERCE" | "FINANCE" | "ENGINEERING" | "SUPPORT" | "LOGISTICS";

export interface AutomationRecipeManifest {
  id: string; // e.g. "recipe_shopify_fulfillment_v1"
  name: string; // e.g. "Shopify Order-to-Fulfillment Pipeline"
  description: string;
  category: RecipeCategory;
  authorUserId: string;
  requiredConnectors: string[]; // e.g. ["shopify", "twilio"]
  
  webhookConfig: {
    provider: string; // e.g. "shopify"
    suggestedSlug: string; // e.g. "shopify-orders"
    signatureHeaderName: string; // e.g. "x-shopify-hmac-sha256"
  };

  bundledWorkflow: {
    id: string;
    name: string;
    scriptPath: string; // e.g. "/.avos/shared/workflows/shopify-fulfillment.ts"
  };

  bundledGadget?: {
    gadgetId: string; // e.g. "gadget_fulfillment_ledger"
    purpose: string;
    initialSqlSchema: string;
  };
}
```

---

### B. Standard System Recipes Catalogue (`workers/spaces/src/template-catalog.ts`)
Extend `workers/spaces/src/template-catalog.ts` to include production-ready prebuilt recipes:

```typescript
import { AutomationRecipeManifest } from "@naelao/types";

export const SYSTEM_AUTOMATION_RECIPES: AutomationRecipeManifest[] = [
  {
    id: "recipe_shopify_fulfillment_v1",
    name: "Shopify Order-to-Fulfillment Pipeline",
    description: "Automatically syncs new Shopify orders, verifies inventory in a private SQLite gadget, and dispatches SMS updates via Twilio.",
    category: "COMMERCE",
    authorUserId: "system_naelao",
    requiredConnectors: ["shopify", "twilio"],
    webhookConfig: {
      provider: "shopify",
      suggestedSlug: "shopify-order-created",
      signatureHeaderName: "x-shopify-hmac-sha256"
    },
    bundledWorkflow: {
      id: "wf_shopify_fulfill",
      name: "Shopify Fulfillment Workflow",
      scriptPath: "/.avos/shared/workflows/shopify-fulfillment.ts"
    },
    bundledGadget: {
      gadgetId: "gadget_fulfillment_ledger",
      purpose: "Tracks order processing states and fulfillment logs",
      initialSqlSchema: `
        CREATE TABLE IF NOT EXISTS fulfillment_records (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          customer_email TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING',
          tracking_number TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `
    }
  },
  {
    id: "recipe_stripe_dispute_sentinel_v1",
    name: "Stripe Dispute Evidence Compiler",
    description: "Listens for Stripe chargeback webhooks, pulls relevant contract records via Cohere Parse 5 R2 storage, and compiles evidentiary defense packets.",
    category: "FINANCE",
    authorUserId: "system_naelao",
    requiredConnectors: ["stripe"],
    webhookConfig: {
      provider: "stripe",
      suggestedSlug: "stripe-charge-dispute",
      signatureHeaderName: "stripe-signature"
    },
    bundledWorkflow: {
      id: "wf_stripe_dispute",
      name: "Stripe Dispute Workflow",
      scriptPath: "/.avos/shared/workflows/stripe-dispute.ts"
    },
    bundledGadget: {
      gadgetId: "gadget_dispute_audit_log",
      purpose: "Maintains timeline of submitted dispute evidence",
      initialSqlSchema: `
        CREATE TABLE IF NOT EXISTS dispute_packets (
          id TEXT PRIMARY KEY,
          dispute_id TEXT NOT NULL,
          charge_id TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          evidence_summary TEXT,
          status TEXT NOT NULL DEFAULT 'EVIDENCE_REQUIRED',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `
    }
  },
  {
    id: "recipe_github_issue_scaffolder_v1",
    name: "GitHub Issue-to-Branch Scaffolder",
    description: "When a new GitHub issue is labeled 'agent-task', spins up a Cloudflare Artifacts Git branch, runs DevOperator to patch code, and opens a Pull Request.",
    category: "ENGINEERING",
    authorUserId: "system_naelao",
    requiredConnectors: ["github"],
    webhookConfig: {
      provider: "github",
      suggestedSlug: "github-issue-labeled",
      signatureHeaderName: "x-hub-signature-256"
    },
    bundledWorkflow: {
      id: "wf_github_scaffold",
      name: "GitHub Issue Scaffolding Workflow",
      scriptPath: "/.avos/shared/workflows/github-scaffold.ts"
    }
  }
];
```

---

### C. Implement Recipe Execution Harness (`workers/agents/src/workflows/recipe-executors.ts`)
Implement the background workflow script for the Shopify fulfillment pipeline as a reference implementation for developers:

```typescript
import { WorkflowStep, WorkflowEvent } from "cloudflare:workers";

export async function executeShopifyFulfillmentRecipe(
  event: WorkflowEvent<{ payload: any; spaceId: string; projectId: string }>,
  step: WorkflowStep,
  ctx: any
) {
  const { payload, spaceId, projectId } = event.payload;

  // Step 1: Extract order details safely
  const orderInfo = await step.do("extract-order-details", async () => {
    return {
      orderId: payload.id?.toString() || "ord_unknown",
      customerEmail: payload.email || payload.customer?.email || "unknown@client.com",
      lineItems: payload.line_items || [],
      totalPrice: payload.total_price || "0.00"
    };
  });

  // Step 2: Query Stateful Gadget (DO Facet SQLite via MCP v2)
  const inventoryCheck = await step.do("verify-inventory", async () => {
    return await ctx.mcp.call("gadget_fulfillment_ledger", "app_fulfillment_ledger_list", {
      filter: `status = 'IN_STOCK'`
    });
  });

  // Step 3: Simulate Fulfillment & Generate Tracking Number
  const fulfillmentResult = await step.do("process-fulfillment", async () => {
    const trackingNum = `TRK_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    await ctx.mcp.call("gadget_fulfillment_ledger", "app_fulfillment_ledger_insert", {
      data: {
        order_id: orderInfo.orderId,
        customer_email: orderInfo.customerEmail,
        status: "FULFILLED",
        tracking_number: trackingNum
      }
    });
    return { trackingNumber: trackingNum };
  });

  // Step 4: Dispatch SMS Notification via Twilio Connector
  await step.do("send-sms-notification", async () => {
    const smsClient = await ctx.connectors.use("twilio");
    if (smsClient) {
      await smsClient.call("send_sms", {
        to: payload.shipping_address?.phone || "+13055550199",
        body: `Your AVOS order #${orderInfo.orderId} has shipped! Tracking: ${fulfillmentResult.trackingNumber}`
      });
    }
  });

  return { ok: true, orderId: orderInfo.orderId, trackingNumber: fulfillmentResult.trackingNumber };
}
```

---

## 
