import { UIActionEvent } from "../../../../packages/events/src/index";

export interface DurableObjectState {
  storage: {
    get<T = any>(key: string): Promise<T | undefined>;
    put<T = any>(key: string, value: T): Promise<void>;
  };
}

export class WsHubDO {
  state: DurableObjectState;
  env: any;
  sessions: Map<WebSocket, { sessionId: string; spaceId: string }> = new Map();

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket Upgrade", { status: 426 });
    }

    const pair = new (globalThis as any).WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    await this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(ws: WebSocket) {
    ws.accept();
    this.sessions.set(ws, { sessionId: "default", spaceId: "default" });

    ws.addEventListener("message", async (msgEvent) => {
      try {
        const data = JSON.parse(msgEvent.data as string);
        
        // Handle metadata registration or initialization
        if (data.type === "init") {
          this.sessions.set(ws, { sessionId: data.sessionId, spaceId: data.spaceId });
          return;
        }

        // Handle routing of mcp.ui_action event to NaelaoAgentDO
        if (data.type === "mcp.ui_action") {
          const uiEvent = data as UIActionEvent;
          
          // Locate/instantiate NaelaoAgentDO
          const agentId = this.env.NAELAO_AGENT_DO.idFromName(uiEvent.sessionId || "default");
          const agentStub = this.env.NAELAO_AGENT_DO.get(agentId);

          // Route the action to NaelaoAgentDO
          const agentResponse = await agentStub.fetch(`http://agent/ui-event`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(uiEvent)
          });

          const agentResult = await agentResponse.json() as any;

          // Push feedback message back to UI client
          ws.send(JSON.stringify({
            type: "mcp.ui_action_response",
            payload: {
              status: "success",
              reply: `I see you've approved that invoice, I'm updating the journal now.`
            }
          }));
        }
      } catch (err) {
        console.error("[WsHubDO] error parsing message: ", err);
        ws.send(JSON.stringify({ type: "error", message: "Invalid payload or routing failure" }));
      }
    });

    ws.addEventListener("close", () => {
      this.sessions.delete(ws);
      console.log("[WsHubDO] Session closed");
    });

    ws.addEventListener("error", (e) => {
      this.sessions.delete(ws);
      console.error("[WsHubDO] Session error: ", e);
    });
  }
}
