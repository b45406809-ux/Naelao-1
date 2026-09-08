import { DynamicUiWidget } from "@avos/types";

export class NaelaoAgentDO {
  private ctx: DurableObjectState;
  private env: any;
  private sessions: Set<WebSocket> = new Set();

  constructor(ctx: DurableObjectState, env: any) {
    this.ctx = ctx;
    this.env = env;

    // Initialize SQLite storage for thread messages and UI state persistence
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS thread_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          ui_payload TEXT,
          created_at INTEGER NOT NULL
        );
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname.endsWith("/ui-action")) {
      const body: any = await request.json();
      await this.handleUiAction(body);
      return Response.json({ success: true });
    }

    return new Response("NaelaoAgentDO Active (MCP-UI)", { status: 200 });
  }

  private handleWebSocket(ws: WebSocket) {
    ws.accept();
    this.sessions.add(ws);

    ws.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(typeof event.data === "string" ? event.data : "{}");
        if (data.type === "mcp.ui_action") {
          await this.handleUiAction(data);
        }
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    });

    ws.addEventListener("close", () => {
      this.sessions.delete(ws);
    });
  }

  async sendUiWidget(threadId: string, widget: DynamicUiWidget) {
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    // 1. Persist widget state to thread memory for re-rendering on reload
    this.ctx.storage.sql.exec(
      "INSERT INTO thread_messages (id, thread_id, role, content, ui_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      threadId,
      "assistant",
      `Rendered widget: ${widget.component}`,
      JSON.stringify(widget),
      createdAt
    );

    // 2. Stream event over WebSocket to frontend
    this.broadcastToFrontend({
      type: "stream_ui_widget",
      threadId,
      widget,
    });
  }

  async handleUiAction(payload: { callbackId: string; action: string; data: any }) {
    console.log("Handling MCP-UI action from client:", payload);

    // Route event back into the agent's reasoning queue as a fresh tool-output
    const reasoningEvent = {
      type: "tool_output",
      source: "mcp_ui",
      callbackId: payload.callbackId,
      action: payload.action,
      data: payload.data,
      timestamp: Date.now(),
    };

    // Broadcast acknowledgment or next agent step
    this.broadcastToFrontend({
      type: "agent_reasoning_step",
      event: reasoningEvent,
    });
  }

  private broadcastToFrontend(message: any) {
    const payload = JSON.stringify(message);
    for (const ws of this.sessions) {
      try {
        ws.send(payload);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }
}
