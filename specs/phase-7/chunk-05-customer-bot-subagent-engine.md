Here is the complete, full, and unabridged Markdown specification file for **`specs/phase-7/chunk-05-customer-bot-subagent-engine.md`**:

```markdown
---
chunk_id: "phase-7-chunk-05"
phase: 7
include_files:
  - packages/types/src/index.ts
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/workflows/WorkflowHarness.ts
  - packages/events/src/business-feature-kinds.ts
repomix_include:
  - "packages/types/src/index.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/agents/src/workflows/WorkflowHarness.ts"
  - "packages/events/src/business-feature-kinds.ts"
expected_outputs:
  - packages/types/src/customer-bot.ts
  - packages/types/src/index.ts
  - workers/agents/src/workflows/CustomerSubagentWorkflow.ts
  - workers/spaces/src/do/SpaceDO.ts
---

# Phase 7 — Chunk 05: Quarantined Customer-Facing Subagent Workflow & Analytics Engine

## 1. Mental Model & Architectural Vision

Main project agents (`@SupportOpsAgent`) must **NEVER speak directly to external public customers**. Exposing a developer or management agent directly to public callers opens the project to prompt-injection attacks that could exfiltrate internal code, system directives, or credentials.

Instead, AVOS decouples customer-facing operations into **two isolated architectural planes**:

1. **Management Plane (Internal):** The business owner or support lead chats with the Main Project Agent in `apps/shell` to configure intake rules, update service FAQs, adjust calendar booking buffers, and inspect customer metrics.
2. **Customer Ingress Plane (External):** Inbound messages from external channels (WhatsApp, Telegram, Discord, or Web chat) are routed to an ephemeral **Customer Subagent Workflow**. This subagent receives a strictly quarantined **`CustomerBotContext`** (`reply`, `saveMessage`, `searchKnowledge`, `bookAppointment`). It has **zero access** to `Bash`, filesystem edits (`Edit`, `Write`), Git Artifacts, or internal vault credentials.
3. **Parent Analytics & Telemetry Loop:** All customer interactions are saved into `customer_conversations` in `SpaceDO` SQLite. The Main Project Agent periodically analyzes these logs in the background to detect customer sentiment, identify recurring complaints, extract bugs into the Project Journal, and trigger mobile alerts for urgent escalations.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🛠️ INTERNAL MANAGEMENT PLANE                                                │
│ Owner ◄══► Main Project Agent (@SupportOpsAgent)                             │
│ • Configures intake rules, FAQs, and business hours.                        │
│ • Synthesizes and updates the Customer Subagent Workflow.                   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼ (Deploys & Registers)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🌐 QUARANTINED CUSTOMER INGRESS PLANE                                       │
│ Public Customer (WhatsApp / Discord) ◄══► Customer Subagent Workflow        │
│ • Executes `CustomerSubagentWorkflow.ts` in an ephemeral V8 Isolate.        │
│ • Bounded by `CustomerBotContext` (Zero Bash, Zero File Edit, Zero Vault).  │
│ • Emits responses and logs conversations to SQLite for parent analytics.    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Type Contracts (`packages/types/src/customer-bot.ts`)

Create `packages/types/src/customer-bot.ts` and re-export in `packages/types/src/index.ts`:

```typescript
import { WorkflowStep } from "cloudflare:workers";

export interface CustomerMessageRecord {
  id: string;
  spaceId: string;
  projectId: string;
  sessionId: string;
  customerIdentifier: string; // Phone number (E.164), Telegram ID, or Email
  channel: "whatsapp" | "telegram" | "discord" | "web";
  role: "customer" | "bot" | "human_agent";
  content: string;
  metadataJson: Record<string, any>;
  createdAt: string;
}

export interface CustomerBotContext {
  customer: {
    reply: (text: string, options?: { quickReplies?: string[] }) => Promise<void>;
    escalateToHuman: (reason: string, urgency: "LOW" | "HIGH" | "EMERGENCY") => Promise<{ ticketId: string }>;
  };
  conversation: {
    sessionId: string;
    customerIdentifier: string;
    getHistory: (limit?: number) => Promise<Array<{ role: string; content: string }>>;
    saveMessage: (role: "customer" | "bot", content: string, metadata?: Record<string, any>) => Promise<void>;
  };
  tools: {
    searchKnowledge: (query: string) => Promise<Array<{ title: string; snippet: string }>>;
    checkCalendar: (isoTime: string) => Promise<{ available: boolean }>;
    bookAppointment: (details: { name: string; timeIso: string; service: string }) => Promise<{ success: boolean; eventId: string }>;
  };
  analytics: {
    recordSentiment: (sentiment: "POSITIVE" | "NEUTRAL" | "FRUSTRATED" | "ANGRY") => Promise<void>;
  };
  step: WorkflowStep;
}
```

---

## 3. Database Schema for Customer Conversations (`SpaceDO.ts` SQLite)

In `workers/spaces/src/do/SpaceDO.ts`, add the customer conversation logging table in `ensureInit()`:

```sql
CREATE TABLE IF NOT EXISTS customer_conversations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  customer_identifier TEXT NOT NULL,
  channel TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'bot', 'human_agent')),
  content TEXT NOT NULL,
  sentiment TEXT CHECK (sentiment IN ('POSITIVE', 'NEUTRAL', 'FRUSTRATED', 'ANGRY')),
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cc_session ON customer_conversations(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cc_cust ON customer_conversations(customer_identifier);
```

Add these methods to `SpaceDO.ts`:

```typescript
async appendCustomerMessage(record: {
  spaceId: string;
  projectId: string;
  sessionId: string;
  customerIdentifier: string;
  channel: string;
  role: "customer" | "bot";
  content: string;
  sentiment?: string;
  metadata?: Record<string, any>;
}): Promise<{ ok: boolean; id: string }> {
  const id = `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  this.ctx.storage.sql.exec(`
    INSERT INTO customer_conversations (
      id, space_id, project_id, session_id, customer_identifier, channel, role, content, sentiment, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `,
    id,
    record.spaceId,
    record.projectId,
    record.sessionId,
    record.customerIdentifier,
    record.channel,
    record.role,
    record.content,
    record.sentiment || null,
    JSON.stringify(record.metadata || {})
  );
  return { ok: true, id };
}

async getCustomerConversationHistory(sessionId: string, limit: number = 10): Promise<Array<{ role: string; content: string }>> {
  const rows = this.ctx.storage.sql.exec<{ role: string; content: string }>(`
    SELECT role, content FROM customer_conversations
    WHERE session_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `, sessionId, limit).toArray();
  return rows;
}
```

---

## 4. Quarantined Customer Subagent Workflow (`workers/agents/src/workflows/CustomerSubagentWorkflow.ts`)

Create the execution engine for customer-facing messaging:

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { CustomerBotContext } from "@naelao/types";

interface CustomerSubagentPayload {
  spaceId: string;
  projectId: string;
  channel: "whatsapp" | "telegram" | "discord";
  customerIdentifier: string;
  incomingText: string;
  sessionId: string;
}

export class CustomerSubagentWorkflow extends WorkflowEntrypoint<Env, CustomerSubagentPayload> {
  async run(event: WorkflowEvent<CustomerSubagentPayload>, step: WorkflowStep) {
    const { spaceId, projectId, channel, customerIdentifier, incomingText, sessionId } = event.payload;

    // 1. Step: Save incoming customer message to SQLite
    await step.do("save-customer-message", async () => {
      const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
      await spaceDO.fetch("http://internal/customer-conversations/append", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceId,
          projectId,
          sessionId,
          customerIdentifier,
          channel,
          role: "customer",
          content: incomingText
        })
      });
    });

    // 2. Step: Assemble Quarantined CustomerBotContext
    const ctx: CustomerBotContext = {
      step,
      customer: {
        reply: async (text) => {
          await this.env.CHANNELS_GATEWAY.sendOutboundMessage({
            channel,
            recipient: customerIdentifier,
            text
          });
        },
        escalateToHuman: async (reason, urgency) => {
          const ticketId = `tkt_${Date.now()}`;
          // Pings space assistant / project channel
          await this.env.NOTIFICATIONS_SERVICE.sendAlert({
            spaceId,
            title: `Customer Escalation (${urgency})`,
            body: `Customer ${customerIdentifier} escalated: ${reason}`
          });
          return { ticketId };
        }
      },
      conversation: {
        sessionId,
        customerIdentifier,
        getHistory: async (limit = 10) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          const res = await spaceDO.fetch(`http://internal/customer-conversations/history?session_id=${sessionId}&limit=${limit}`);
          return await res.json() as any;
        },
        saveMessage: async (role, content) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          await spaceDO.fetch("http://internal/customer-conversations/append", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spaceId, projectId, sessionId, customerIdentifier, channel, role, content })
          });
        }
      },
      tools: {
        searchKnowledge: async (query) => {
          const res = await this.env.KNOWLEDGE_SERVICE.search(spaceId, query, { projectId });
          return res.results;
        },
        checkCalendar: async (timeIso) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          const res = await spaceDO.fetch(`http://internal/calendar/availability?time=${encodeURIComponent(timeIso)}`);
          return await res.json() as any;
        },
        bookAppointment: async (details) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          const res = await spaceDO.fetch("http://internal/calendar/book", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...details, spaceId, projectId, clientContact: customerIdentifier })
          });
          return await res.json() as any;
        }
      },
      analytics: {
        recordSentiment: async (sentiment) => {
          // Updates conversation sentiment in SQLite
        }
      }
    };

    // 3. Step: Execute Conversational Turn in V8 Isolate
    await step.do("execute-customer-turn", async () => {
      // 1. Search knowledge base
      const knowledge = await ctx.tools.searchKnowledge(incomingText);

      // 2. Run constrained generation (Tier 1 Safe RAG)
      const aiResponse = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        prompt: `You are an automated support receptionist. Answer politely using only the provided context.
Context:
${JSON.stringify(knowledge)}

Customer message:
${incomingText}`
      });

      const replyText = (aiResponse as any).response.trim();

      // 3. Send reply to customer and log to database
      await ctx.customer.reply(replyText);
      await ctx.conversation.saveMessage("bot", replyText);
    });

    return { completed: true };
  }
}
```

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

1. Create `packages/types/src/customer-bot.ts` with `CustomerMessageRecord` and `CustomerBotContext`.
2. Re-export `customer-bot.ts` in `packages/types/src/index.ts`.
3. In `workers/spaces/src/do/SpaceDO.ts`:
   * Add the `customer_conversations` table to `ensureInit()`.
   * Add `appendCustomerMessage` and `getCustomerConversationHistory` methods.
4. Create `workers/agents/src/workflows/CustomerSubagentWorkflow.ts` implementing the quarantined subagent flow.
5. Run `npx turbo run typecheck` across the monorepo to ensure type consistency.
```
