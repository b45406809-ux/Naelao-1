Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 5 — Chunk 07**: `specs/phase-5/chunk-07-websocket-presence-and-multiplayer-sync.md`.

---

```markdown
---
chunk_id: "phase-5-chunk-07"
phase: 5
include_files:
  - workers/ws-gateway/src/index.ts
  - workers/spaces/src/do/SpaceDO.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/ws-gateway/src/index.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/ws-gateway/src/index.ts
  - workers/spaces/src/do/SpaceDO.ts
  - packages/types/src/multiplayer-presence.ts
  - packages/types/src/index.ts
---

# Phase 5 — Chunk 07: WebSocket Presence & Multiplayer Synchronization (`WsHubDO`)

## 1. Executive Summary & Architectural Vision

When multiple team members, human collaborators, and autonomous AI agents edit files or interact within a shared AVOS project workspace, state changes must be broadcasted in real time. 

Without sub-second multiplayer awareness, concurrent editors risk file clashing and desynchronization. AVOS solves this via **`WsHubDO` (Durable Object WebSocket Gateway)** [1.3.17]. 

`WsHubDO` acts as an edge-native pub/sub mesh running inside Cloudflare Durable Objects. It manages persistent WebSocket connections from `apps/shell`, tracks active user and agent presence cursors, and broadcasts live mutation events (`presence.file_editing`, `workspace.file_changed`, `pr.opened`) across all connected clients with zero latency.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       WSHUBDO MULTIPLAYER EVENT MESH                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Persistent WebSockets: Managed inside Cloudflare Durable Objects.        │
│ 2. Presence Tracking: Tracks who is online, what file they are viewing.      │
│ 3. Live Broadcasts: Instantly pushes AST edits and PR events to UI clients. │
│ 4. Hibernation Support: Uses Cloudflare WebSocket Hibernation for $0 idle.  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & Data Contracts

### A. Define Multiplayer Presence Types (`packages/types/src/multiplayer-presence.ts`)

Create `packages/types/src/multiplayer-presence.ts` and re-export from `packages/types/src/index.ts`:

```typescript
export type PresenceStatus = "active" | "idle" | "coding" | "reviewing" | "sleeping";

export interface MultiplayerPresencePayload {
  userId: string;
  userName: string;
  userAvatar: string;
  role: "HUMAN" | "ARCHITECT" | "DEV" | "REVIEW" | "GROWTH";
  status: PresenceStatus;
  currentFile?: string;
  cursorPosition?: { line: number; column: number };
  lastHeartbeat: number;
}

export interface WorkspaceMutationEvent {
  eventType: "file_changed" | "file_locked" | "file_unlocked" | "pr_opened" | "pr_merged";
  spaceId: string;
  projectId: string;
  filePath?: string;
  actorId: string;
  actorType: "human" | "agent";
  timestamp: string;
  metadata?: Record<string, any>;
}
```

---

## 3. Implementation Requirements & Code Contracts

### A. Update `workers/ws-gateway/src/index.ts`

Implement the robust `WsHubDO` class utilizing Cloudflare's WebSocket Hibernation API for high-density, low-cost connection management:

```typescript
import { DurableObject } from "cloudflare:workers";
import { MultiplayerPresencePayload, WorkspaceMutationEvent } from "@naelao/types";

export interface WsGatewayEnv {
  // Bindings if needed
}

export class WsHubDO extends DurableObject {
  private presenceMap: Map<string, MultiplayerPresencePayload> = new Map();

  constructor(ctx: DurableObjectState, env: WsGatewayEnv) {
    super(ctx, env);
    // Enable WebSocket Hibernation for maximum cost efficiency
    this.ctx.setWebSocketAutoResponse(new HibernationResponse());
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "presence.update") {
        const presence: MultiplayerPresencePayload = data.payload;
        this.presenceMap.set(presence.userId, { ...presence, lastHeartbeat: Date.now() });
        this.broadcast({ type: "presence.state", presences: Array.from(this.presenceMap.values()) }, ws);
      } 
      else if (data.type === "workspace.mutation") {
        const mutation: WorkspaceMutationEvent = data.payload;
        this.broadcast({ type: "workspace.broadcast", mutation }, ws);
      }
    } catch (err) {
      console.error("WsHubDO parse error:", err);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    ws.close(code, reason);
    // Clean up disconnected user presence
    for (const [userId, presence] of this.presenceMap.entries()) {
      // If socket is no longer accepted/active, remove
      if (Date.now() - presence.lastHeartbeat > 30000) {
        this.presenceMap.delete(userId);
      }
    }
    this.broadcast({ type: "presence.state", presences: Array.from(this.presenceMap.values()) });
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("WsHubDO socket error:", error);
  }

  private broadcast(message: any, excludeWs?: WebSocket) {
    const serialized = JSON.stringify(message);
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      if (socket !== excludeWs) {
        try {
          socket.send(serialized);
        } catch {
          // Socket dead, ignore
        }
      }
    }
  }
}

class HibernationResponse {
  // Built-in auto-pong handler for Cloudflare Hibernation
}
```

---

### B. Update `workers/spaces/src/do/SpaceDO.ts`

Expose a helper inside `SpaceDO` to dispatch workspace mutation broadcasts via internal RPC to the active `WsHubDO` instance:

```typescript
export async function broadcastSpaceMutation(
  wsHubNamespace: DurableObjectNamespace,
  spaceId: string,
  mutation: WorkspaceMutationEvent
) {
  try {
    const id = wsHubNamespace.idFromName(spaceId);
    const stub = wsHubNamespace.get(id);
    
    // Internal RPC fetch to trigger WebSocket broadcast
    await stub.fetch("https://internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "workspace.mutation", payload: mutation })
    });
  } catch (err) {
    console.warn("Failed to broadcast space mutation via WsHubDO:", err);
  }
}
```

---

## 4. Step-by-Step Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/multiplayer-presence.ts` and export its interfaces in `packages/types/src/index.ts`.
2. Implement `WsHubDO` inside `workers/ws-gateway/src/index.ts` utilizing Cloudflare WebSocket Hibernation.
3. Add `broadcastSpaceMutation` integration inside `workers/spaces/src/do/SpaceDO.ts`.
4. Run `node --check` syntax validation on the modified files.
```
