This specification for **Phase 6 — Chunk 08** moves beyond static chat and introduces the **Generative In-Chat UI (Google Search AI Mode style)**. 

This is the interface that turns your platform from a standard chatbot into a **Proactive Application Engine**. Instead of the AI responding with blocks of text, it streams **interactive UI widgets** (date pickers, action cards, decision tables) that users and other agents can manipulate directly in the chat bubble.

---

### `specs/phase-6/chunk-08-generative-in-chat-ui.md`

```markdown
---
chunk_id: "phase-6-chunk-08"
phase: 6
include_files:
  - apps/shell/src/components/Chat.tsx
  - apps/shell/src/components/ui/GenerativeWidget.tsx
  - workers/agents/src/do/NaelaoAgentDO.ts
  - packages/types/src/mcp-ui.ts
repomix_include:
  - "apps/shell/src/components/Chat.tsx"
  - "apps/shell/src/components/ui/GenerativeWidget.tsx"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "packages/types/src/mcp-ui.ts"
expected_outputs:
  - apps/shell/src/components/Chat.tsx
  - apps/shell/src/components/ui/GenerativeWidget.tsx
  - packages/types/src/mcp-ui.ts
---

# Phase 6 — Chunk 08: In-Chat Generative UI (MCP-UI)

## 1. Mental Model & Architectural Vision

Traditional LLM interfaces are passive: the AI writes text, and the human reads. **Generative In-Chat UI** changes this to an interactive feedback loop. 

Whenever the AI needs structured input (e.g., booking a date, confirming a payment, filtering a dataset) or wants to surface live data, it streams a **JSON-Schema-based UI widget** directly into the chat stream.

```
[ AI Thinking: "I need to book a consultation slot..." ]
                          │
                          ▼ (MCP-UI Streamed JSON-RPC Payload)
┌─────────────────────────────────────────────────────────────┐
│ 🎛️ AI-Generated Widget: `BookingSlotPicker`                │
├─────────────────────────────────────────────────────────────┤
│ • Interactive Date Grid (Calendar)                          │
│ • Dropdown: "Service Tiers"                                 │
│ • [ Submit Booking ]                                        │
└─────────────────────────────────────┬───────────────────────┘
                                      │
                                      ▼ (User taps [Submit])
[ MCP-UI Event emits to NaelaoAgentDO Loop: { action: "BOOKING_CONFIRMED", data: {...} } ]
```

---

## 2. Technical Specifications

### A. Define Protocol (`packages/types/src/mcp-ui.ts`)
Standardize the widget interface so the frontend can render ANY dynamic tool surface the agent dreams up.

```typescript
export interface DynamicUiWidget {
  type: "dynamic_ui";
  component: "BookingSlotPicker" | "DecisionTable" | "ActionCard" | "StatusMeter";
  props: Record<string, any>; // Schema-compliant properties
  callbackId: string;        // Used to route UI interactions back to the Agent
}
```

### B. Implement Frontend Renderer (`apps/shell/src/components/ui/GenerativeWidget.tsx`)
Create a dynamic factory that renders components based on the `component` type:

```tsx
export function GenerativeWidget({ widget }: { widget: DynamicUiWidget }) {
  const onAction = (action: string, data: any) => {
    // Emit MCP-UI event to parent chat session
    window.postMessage({
      type: "mcp.ui_action",
      callbackId: widget.callbackId,
      action,
      data
    });
  };

  switch (widget.component) {
    case "BookingSlotPicker":
      return \u003cBookingSlotPicker {...widget.props} onSelect\u003d{onAction} /\u003e;
    case "ActionCard":
      return \u003cActionCard {...widget.props} onConfirm\u003d{onAction} /\u003e;
    default:
      return \u003cdiv\u003eUnknown UI Widget\u003c/div\u003e;
  }
}
```

### C. Update Agent Runtime (`workers/agents/src/do/NaelaoAgentDO.ts`)
The agent can now emit UI widgets as part of its turn:

```typescript
// Inside NaelaoAgentDO execution loop
async function sendUiWidget(widget: DynamicUiWidget) {
  // 1. Persist widget state to thread memory for re-rendering on reload
  await this.ctx.storage.sql.exec(
    "INSERT INTO thread_messages (..., ui_payload) VALUES (?, ?)", 
    threadId, 
    JSON.stringify(widget)
  );
  
  // 2. Stream event over WebSocket to frontend
  this.broadcastToFrontend({
    type: "stream_ui_widget",
    widget
  });
}
```

---

## 3. Implementation Instructions for the AI Runner

1.  **Define Protocol:** Create `packages/types/src/mcp-ui.ts` to define the schema for widget components and their associated callbacks.
2.  **UI Factory:** Implement `GenerativeWidget.tsx` in `apps/shell` as a dynamic component loader.
3.  **Chat Integration:** Update `Chat.tsx` to detect `dynamic_ui` message types and mount the `GenerativeWidget`.
4.  **Agent Logic:** Update `NaelaoAgentDO.ts` to handle `mcp.ui_action` events, routing them back into the agent’s reasoning queue as if they were fresh user tool-outputs.
5. **Self-Healing:** Ensure `Chat.tsx` handles widget re-rendering on session reload by re-fetching the `ui_payload` from the message history.
```

---

