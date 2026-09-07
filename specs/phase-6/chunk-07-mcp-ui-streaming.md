Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 6 — Chunk 07: MCP-UI Bidirectional Streaming**.

---

```markdown
---
chunk_id: "phase-6-chunk-07"
phase: 6
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - apps/shell/src/components/Chat.tsx
  - workers/ws-gateway/src/do/WsHubDO.ts
  - packages/events/src/index.ts
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "apps/shell/src/components/Chat.tsx"
  - "workers/ws-gateway/src/do/WsHubDO.ts"
  - "packages/events/src/index.ts"
expected_outputs:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - apps/shell/src/components/Chat.tsx
  - packages/events/src/index.ts
---

# Phase 6 — Chunk 07: MCP-UI Bidirectional Streaming

## 1. Executive Summary & Architectural Vision

In traditional AI systems, the agent is "blind" to user interactions that happen inside a UI or Micro-App. If a user clicks a button or submits a form in a custom Canvas, the agent has no way of knowing it happened unless the user manually types a message in chat.

**MCP-UI** (Model Context Protocol for UI) bridges this gap. It turns the visual canvas into an **Observable Sensor**. Whenever a user interacts with a **Tier 2 Canvas Gadget** or a **Tier 3 Micro-App**, the UI emits a structured event that is streamed directly into the Agent's reasoning loop in real-time.

### The Observation Flow:
1.  **User Action:** User clicks "Approve Invoice #402" inside the `finance_grid` gadget iframe.
2.  **Iframe Emission:** The gadget (a null-origin iframe) sends a `postMessage` to the AVOS Shell.
3.  **Shell Relay:** The Shell packages this into a `UI_ACTION` WebSocket event and sends it to the `WsHubDO` (WebSocket Gateway).
4.  **Agent Perception:** The Gateway routes the event to the `NaelaoAgentDO`.
5.  **Autonomous Reaction:** The Agent "sees" the event as a new observation turn:
    *   *Observation:* `User approved Invoice #402.`
    *   *Thought:* I should now update the Project Journal and move the funds.
    *   *Action:* `commerce.process_payment({ id: "402" })`

---

## 2. Technical Specifications & Event Schemas

### A. The UI Action Event Definition (`packages/events/src/index.ts`)

Add the `UIActionEvent` to the platform's canonical event registry:

```typescript
export interface UIActionEvent {
  type: "mcp.ui_action";
  spaceId: string;
  projectId: string;
  sessionId: string; // The active chat session
  gadgetId: string;  // The ID of the gadget that emitted the event
  action: string;    // e.g., "BUTTON_CLICK", "FORM_SUBMIT"
  payload: Record<string, any>;
  timestamp: string;
}
```

---

### B. The Iframe Bridge (`apps/shell/src/components/ViewportHarness.tsx`)

The Shell must listen for events from the pluggable gadget iframes. Implement the `Window` message listener:

```typescript
// Inside the Shell's Viewport Harness
window.addEventListener("message", (event) => {
  // 1. Verify the message is from a registered AVOS Gadget
  if (event.data?.type === "avos.ui_event") {
    const uiEvent: UIActionEvent = {
      type: "mcp.ui_action",
      spaceId: currentSpaceId,
      projectId: activeProjectId,
      sessionId: activeSessionId,
      gadgetId: event.data.gadgetId,
      action: event.data.action,
      payload: event.data.payload,
      timestamp: new Date().toISOString(),
    };

    // 2. Dispatch to the Agent via the existing WebSocket Gateway
    wsClient.send(JSON.stringify(uiEvent));
  }
});
```

---

### C. Agent Perception Logic (`workers/agents/src/do/NaelaoAgentDO.ts`)

The Agent DO must be updated to handle incoming `mcp.ui_action` events and inject them into its active reasoning loop.

```typescript
// workers/agents/src/do/NaelaoAgentDO.ts

export class NaelaoAgentDO extends DurableObject {
  /**
   * Handle incoming UI events from the WebSocket Gateway.
   */
  async handleUiEvent(event: UIActionEvent) {
    // 1. Log the event to the in-memory trace (item 133/HX1)
    this.pushTrace({
      phase: "observation",
      name: "UI_INTERACTION",
      detail: `User performed ${event.action} in gadget ${event.gadgetId}`,
      params: event.payload
    });

    // 2. Wake up the Agent if it's currently sleeping (Dormant -> Active)
    if (this.status === "idle") {
      // Re-trigger the run loop with the UI event as the new "goal"
      const uiSummary = `The user interacted with the UI: ${event.action}. Data: ${JSON.stringify(event.payload)}`;
      return await this.executeTurn(uiSummary, { source: "ui_event" });
    }
    
    // 3. If a run is ALREADY in flight, append the UI event to the loop's 
    // `priorSteps` so the model sees it on its next reasoning turn.
    this.activeRunContext.pendingObservations.push(event);
  }
}
```

---

## 3. Implementation Requirements for the AI Runner

### Step 1: Update Event Registry
Add `UIActionEvent` to `packages/events/src/index.ts`. Ensure the union type `NaelaoEvent` includes this new type.

### Step 2: Update `NaelaoAgentDO`
*   Add a `pendingObservations` array to the active run state.
*   Implement `handleUiEvent` logic to allow "UI-Triggered Wake-ups."
*   Update the `composeSystemPrompt` to include a section for **UI State Awareness**, telling the model: *"You will receive notification of user interactions within the workspace canvas via the `mcp.ui_action` stream."*

### Step 3: Shell Integration
*   In `apps/shell/src/components/Chat.tsx`, ensure the WebSocket listener routes events of type `mcp.ui_action` to the correct Agent DO instance.
*   Update the UI to show a "Thinking..." indicator when a UI event triggers an autonomous agent response.

### Step 4: Verification
1.  **Simulate Iframe Message:** Manually trigger a `window.postMessage` in the browser console.
2.  **Verify Trace:** Check the `/agent/runs/:id/trace` endpoint to ensure the `UI_INTERACTION` was recorded.
3.  **Verify Response:** Confirm the agent replies in chat acknowledging the UI action (e.g., *"I see you've approved that invoice, I'm updating the journal now."*)

---

## 4. Why this beats Grok Bot / Claude Code

*   **Claude Code** is a CLI; it cannot "see" a user clicking a custom web form.
*   **Grok Bot** has a flat "Computer Use" view, but it doesn't have a semantic event stream from the apps inside the computer.
*   **AVOS** provides a **Deep Semantic Link** between the pixels the user sees and the bytes the agent processes. The UI isn't just a display; it's a part of the agent's nervous system.
```

---



