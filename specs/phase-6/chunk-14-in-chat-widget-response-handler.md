Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 6 — Chunk 14**: `specs/phase-6/chunk-14-in-chat-widget-response-handler.md`.

---

```markdown
---
chunk_id: "phase-6-chunk-14"
phase: 6
include_files:
  - workers/agents/src/index.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - apps/shell/src/components/Chat.tsx
repomix_include:
  - "workers/agents/src/index.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "apps/shell/src/components/Chat.tsx"
expected_outputs:
  - workers/agents/src/index.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - apps/shell/src/components/Chat.tsx
  - packages/types/src/widget-response.ts
---

# Phase 6 — Chunk 14: In-Chat Widget Response Handling & Observation Injection

## 1. Executive Summary & Architectural Vision

In Chunk 08, AVOS introduced **Generative In-Chat Dynamic UI Widgets** (Google Search AI Mode style)—allowing AI agents to stream interactive components (date pickers, range sliders, multi-select chip lists, approval cards) directly into chat bubbles.

**Chunk 14 completes the two-way interaction loop.** 

When a user interacts with a widget in `apps/shell` (e.g. selects a 3:00 PM appointment slot or adjusts a budget slider to $500), the widget emits a structured event. Chunk 14 implements the backend API route and Durable Object observation handler that injects this response directly into `NaelaoAgentDO`'s active reasoning loop, waking the agent to execute the next logical step without requiring the user to type a single word.

```
[ User interacts with widget in Chat bubble (e.g., Clicks "Select 3:00 PM Thursday") ]
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. FRONTEND WIDGET DISPATCH (`apps/shell/src/components/Chat.tsx`)           │
│    Dispatches `POST /spaces/:spaceId/sessions/:sessionId/widget-response`   │
│    Payload: `{ widgetId: "w_102", action: "SLOT_SELECTED", data: {...} }`   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. AGENT WORKER API ROUTE (`workers/agents/src/index.ts`)                   │
│    • Validates session ownership & user authorization.                      │
│    • Resolves target `NaelaoAgentDO` actor for `:sessionId`.                │
│    • Calls `agentDO.injectObservation(widgetResponse)`.                     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. OBSERVATION INJECTION & REASONING WAKE (`NaelaoAgentDO.ts`)               │
│    • Appends XML observation: `<widget_response id="w_102">...</>`.         │
│    • Wakes REPL reasoning loop if dormant.                                  │
│    • Agent executes next tool turn (e.g. `calendar.book_slot`) & updates UI!│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Define Widget Response Types (`packages/types/src/widget-response.ts`)

Create `packages/types/src/widget-response.ts` and re-export from `packages/types/src/index.ts`:

```typescript
export interface WidgetResponsePayload {
  widgetId: string;
  widgetType: string; // e.g. "BookingSlotPicker", "BudgetSlider", "OptionSelector"
  action: string;     // e.g. "SLOT_SELECTED", "BUDGET_SUBMITTED", "APPROVED"
  payload: Record<string, any>;
  timestamp?: string;
}

export interface WidgetResponseApiResponse {
  ok: boolean;
  sessionId: string;
  widgetId: string;
  status: "queued" | "processing";
  message: string;
}
```

---

### B. Update Agent Worker Routes (`workers/agents/src/index.ts`)

Add the widget response route in `workers/agents/src/index.ts`:

```typescript
import { Hono } from "hono";
import { errorResponse, requireVerifiedTenant } from "@naelao/http";
import { WidgetResponsePayload } from "@naelao/types";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /spaces/:spaceId/sessions/:sessionId/widget-response
 * Receives structured user input from generative in-chat UI widgets and
 * injects the payload directly into the agent's reasoning loop.
 */
app.post("/spaces/:spaceId/sessions/:sessionId/widget-response", async (c) => {
  const { spaceId, sessionId } = c.req.param();
  const identity = requireVerifiedTenant(c);

  let body: WidgetResponsePayload;
  try {
    body = await c.req.json<WidgetResponsePayload>();
  } catch {
    return errorResponse(c, 400, "invalid_json", "Request body must be valid JSON");
  }

  if (!body.widgetId || !body.action) {
    return errorResponse(c, 400, "missing_fields", "Fields 'widgetId' and 'action' are required");
  }

  // 1. Resolve NaelaoAgentDO for this session
  const doId = c.env.NAELAO_AGENT_DO.idFromName(`${spaceId}:${sessionId}`);
  const agentStub = c.env.NAELAO_AGENT_DO.get(doId);

  // 2. Inject observation payload into DO
  const doResponse = await agentStub.fetch("http://internal/inject-observation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-user-id": identity.userId
    },
    body: JSON.stringify({
      type: "widget_response",
      data: {
        ...body,
        userId: identity.userId,
        timestamp: body.timestamp || new Date().toISOString()
      }
    })
  });

  if (!doResponse.ok) {
    const errText = await doResponse.text();
    return errorResponse(c, 500, "do_injection_failed", `Failed to inject widget observation: ${errText}`);
  }

  return c.json({
    ok: true,
    sessionId,
    widgetId: body.widgetId,
    status: "processing",
    message: "Widget response successfully injected into agent reasoning loop"
  });
});

export default app;
```

---

### C. Update `NaelaoAgentDO.ts` (`workers/agents/src/do/NaelaoAgentDO.ts`)

Implement `injectObservation` and internal route handling in `NaelaoAgentDO`:

```typescript
export class NaelaoAgentDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/inject-observation" && request.method === "POST") {
      const body = await request.json() as { type: string; data: any };
      await this.handleObservationInjection(body);
      return Response.json({ ok: true });
    }

    // ... existing DO fetch routes
    return new Response("Not Found", { status: 404 });
  }

  /**
   * Appends an observation turn to the active session transcript and wakes
   * the agent REPL reasoning loop if dormant.
   */
  async handleObservationInjection(event: { type: string; data: any }) {
    if (event.type === "widget_response") {
      const widgetData = event.data;

      // Format as structured XML observation for LLM context window
      const observationXml = `<widget_response id="${widgetData.widgetId}" type="${widgetData.widgetType}" action="${widgetData.action}">
${JSON.stringify(widgetData.payload, null, 2)}
</widget_response>`;

      // 1. Append observation to DO SQLite session messages
      this.ctx.storage.sql.exec(`
        INSERT INTO session_messages (session_id, role, content, metadata_json, created_at)
        VALUES (?, 'observation', ?, ?, datetime('now'))
      `, this.sessionId, observationXml, JSON.stringify(widgetData));

      // 2. Trigger active agent execution turn if not currently processing
      if (!this.isProcessing) {
        // Trigger background processing turn
        this.ctx.waitUntil(this.triggerReasoningTurn(`Received user input from widget '${widgetData.widgetId}'`));
      }
    }
  }

  private async triggerReasoningTurn(reason: string) {
    // Execute next reasoning step in agent loop
  }
}
```

---

### D. Update Frontend Widget Interceptor (`apps/shell/src/components/Chat.tsx`)

Add widget submit handler and API integration in `apps/shell/src/components/Chat.tsx`:

```tsx
import React, { useCallback } from "react";
import { apiFetch } from "../lib/api";

export interface WidgetComponentProps {
  widgetId: string;
  widgetType: string;
  data: Record<string, any>;
  onWidgetSubmit: (action: string, payload: Record<string, any>) => Promise<void>;
}

export function ChatWidgetWrapper({
  spaceId,
  sessionId,
  widgetId,
  widgetType,
  data
}: {
  spaceId: string;
  sessionId: string;
  widgetId: string;
  widgetType: string;
  data: Record<string, any>;
}) {
  const handleWidgetSubmit = useCallback(
    async (action: string, payload: Record<string, any>) => {
      try {
        console.log(`📤 Submitting widget response for [${widgetId}]: ${action}`, payload);

        await apiFetch(`/spaces/${spaceId}/sessions/${sessionId}/widget-response`, {
          method: "POST",
          body: JSON.stringify({
            widgetId,
            widgetType,
            action,
            payload,
            timestamp: new Date().toISOString()
          })
        });

        console.log(`✅ Widget response for [${widgetId}] processed successfully.`);
      } catch (err) {
        console.error(`❌ Failed to submit widget response:`, err);
      }
    },
    [spaceId, sessionId, widgetId, widgetType]
  );

  return (
    <div className="in-chat-widget-container" data-widget-id={widgetId}>
      {/* Dynamically render widget based on type */}
      <DynamicWidgetRenderer
        widgetId={widgetId}
        widgetType={widgetType}
        data={data}
        onSubmit={handleWidgetSubmit}
      />
    </div>
  );
}

function DynamicWidgetRenderer({
  widgetId,
  widgetType,
  data,
  onSubmit
}: {
  widgetId: string;
  widgetType: string;
  data: any;
  onSubmit: (action: string, payload: any) => Promise<void>;
}) {
  // Render concrete widget components (DateSlotPicker, BudgetSlider, etc.)
  return (
    <button
      className="btn-primary"
      onClick={() => onSubmit("SUBMIT", { selectedValue: "sample_value" })}
    >
      Submit Widget Response
    </button>
  );
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying Chunk 14:
1. Create `packages/types/src/widget-response.ts` and re-export in `packages/types/src/index.ts`.
2. Update `workers/agents/src/index.ts`:
   - Add route `POST /spaces/:spaceId/sessions/:sessionId/widget-response`.
   - Ensure tenant verification and payload validation fail fast on bad input.
3. Update `workers/agents/src/do/NaelaoAgentDO.ts`:
   - Implement route `/inject-observation` and method `handleObservationInjection`.
   - Ensure observations append as `<widget_response>` tags in SQLite and wake dormant reasoning loops.
4. Update `apps/shell/src/components/Chat.tsx`:
   - Add `ChatWidgetWrapper` and wire `handleWidgetSubmit` to dispatch API requests.
5. Run `node --check` syntax validation across all updated files.
```
