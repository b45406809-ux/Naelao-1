import { DynamicUiWidget } from "@avos/types";
import { ScriptToolSurface } from "../script-engine/tool-surface";

export class NaelaoAgentDO {
  private ctx: DurableObjectState;
  private env: any;
  private sessions: Set<WebSocket> = new Set();
  private isProcessing: boolean = false;
  private sessionId?: string;

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
        CREATE TABLE IF NOT EXISTS session_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL
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

    if (request.method === "POST" && (url.pathname.endsWith("/inject-observation") || url.pathname === "/inject-observation")) {
      const body: any = await request.json();
      await this.handleObservationInjection(body);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname.endsWith("/ui-action")) {
      const body: any = await request.json();
      await this.handleUiAction(body);
      return Response.json({ success: true });
    }

    if (request.method === "POST" && url.pathname.endsWith("/initialize-run")) {
      const body: any = await request.json();
      const result = await this.initializeRunContext(body);
      return Response.json({ success: true, activeGadgetCounts: result.activeGadgetCounts });
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

  /**
   * Appends an observation turn to the active session transcript and wakes
   * the agent REPL reasoning loop if dormant.
   */
  async handleObservationInjection(event: { type: string; data: any }) {
    if (event.type === "widget_response") {
      const widgetData = event.data;

      // Format as structured XML observation for LLM context window
      const observationXml = `<widget_response id="${widgetData.widgetId}" type="${widgetData.widgetType || "dynamic_ui"}" action="${widgetData.action}">
${JSON.stringify(widgetData.payload || widgetData.data || {}, null, 2)}
</widget_response>`;

      const msgId = crypto.randomUUID();
      const targetSessionId = widgetData.sessionId || widgetData.threadId || this.sessionId || "default";

      // 1. Append observation to DO SQLite session messages
      this.ctx.storage.sql.exec(
        `INSERT INTO session_messages (id, session_id, role, content, metadata_json, created_at)
         VALUES (?, ?, 'observation', ?, ?, datetime('now'))`,
        msgId,
        targetSessionId,
        observationXml,
        JSON.stringify(widgetData)
      );

      // 2. Also record in thread_messages for UI continuity
      this.ctx.storage.sql.exec(
        `INSERT INTO thread_messages (id, thread_id, role, content, ui_payload, created_at)
         VALUES (?, ?, 'observation', ?, ?, ?)`,
        msgId,
        targetSessionId,
        observationXml,
        JSON.stringify(widgetData),
        Date.now()
      );

      // 3. Broadcast to frontend stream
      this.broadcastToFrontend({
        type: "observation_injected",
        observation: observationXml,
        widgetData,
      });

      // 4. Trigger active agent execution turn if not currently processing
      if (!this.isProcessing) {
        this.ctx.waitUntil(this.triggerReasoningTurn(`Received user input from widget '${widgetData.widgetId}'`));
      }
    }
  }

  private async triggerReasoningTurn(reason: string) {
    this.isProcessing = true;
    try {
      this.broadcastToFrontend({
        type: "agent_reasoning_step",
        event: {
          type: "reasoning_wake",
          reason,
          timestamp: Date.now(),
        },
      });
    } finally {
      this.isProcessing = false;
    }
  }

  async initializeRunContext(runConfig: { spaceId: string; projectId?: string; userId?: string }) {
    // 1. Fetch space actor stub
    const spaceDO = this.getSpaceDOStub(runConfig.spaceId);

    // 2. Discover active gadgets for this project/user
    const discoveredGadgets = await spaceDO.listGadgetInstancesForRun(
      runConfig.projectId,
      runConfig.userId
    );

    // 3. Register discovered gadget MCP endpoints into tool surface
    const toolSurface = new ScriptToolSurface();
    await toolSurface.registerDiscoveredGadgetTools(discoveredGadgets, {
      mcpHub: this.env.MCP_HUB || {
        listToolsOverInternalRpc: async () => ({ tools: [] }),
        callToolOverInternalRpc: async () => ({})
      },
      spaceId: runConfig.spaceId
    });

    return { toolSurface, activeGadgetCounts: discoveredGadgets.length };
  }

  private getSpaceDOStub(spaceId: string) {
    if (this.env?.SPACE_DO) {
      const id = this.env.SPACE_DO.idFromString(spaceId);
      return this.env.SPACE_DO.get(id);
    }
    // Mock / fallback stub for tests
    return {
      listGadgetInstancesForRun: async (projectId?: string, userId?: string) => {
        return [];
      }
    };
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
