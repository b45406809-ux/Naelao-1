import { UIActionEvent } from "../../../../packages/events/src/index";

export interface TraceEntry {
  phase: "thought" | "action" | "observation";
  name: string;
  detail: string;
  params?: Record<string, any>;
  timestamp: string;
}

export interface ActiveRunContext {
  runId: string;
  pendingObservations: UIActionEvent[];
  history: { role: string; content: string }[];
}

export interface DurableObjectState {
  storage: {
    get<T = any>(key: string): Promise<T | undefined>;
    put<T = any>(key: string, value: T): Promise<void>;
  };
}

export class NaelaoAgentDO {
  state: DurableObjectState;
  env: any;
  status: "idle" | "running" = "idle";
  traces: TraceEntry[] = [];
  activeRunContext: ActiveRunContext = {
    runId: "run-default",
    pendingObservations: [],
    history: []
  };

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Check if endpoint is trace
    if (url.pathname.includes("/trace")) {
      return new Response(JSON.stringify(this.traces), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname.endsWith("/ui-event")) {
      const event = await request.json() as UIActionEvent;
      await this.handleUiEvent(event);
      return new Response(JSON.stringify({ status: "processed", agentStatus: this.status }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname.endsWith("/message")) {
      const body = await request.json() as { message: string };
      const response = await this.executeTurn(body.message, { source: "user" });
      return new Response(JSON.stringify({ response }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("NaelaoAgentDO Endpoint", { status: 200 });
  }

  pushTrace(trace: Omit<TraceEntry, "timestamp">) {
    const entry: TraceEntry = {
      ...trace,
      timestamp: new Date().toISOString()
    };
    this.traces.push(entry);
    console.log(`[Agent Trace] [${entry.phase.toUpperCase()}] ${entry.name}: ${entry.detail}`, entry.params || "");
  }

  composeSystemPrompt(): string {
    return `
You are Naelao, the sovereign orchestrator agent for the AVOS workspace.
You operate with deep semantic links to the visual canvas and widgets.

SYSTEM INSTRUCTIONS:
1. You will receive notification of user interactions within the workspace canvas via the 'mcp.ui_action' stream.
2. Analyze all UI actions as direct observation inputs. Update your internal state, explain what you see, and respond dynamically.
3. Keep reactions autonomous, precise, and highly context-aware.
`.trim();
  }

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
      const uiSummary = `The user interacted with the UI: ${event.action}. Data: ${JSON.stringify(event.payload)}`;
      return await this.executeTurn(uiSummary, { source: "ui_event" });
    }
    
    // 3. If a run is ALREADY in flight, append the UI event to the loop's 
    // `pendingObservations` so the model sees it on its next reasoning turn.
    this.activeRunContext.pendingObservations.push(event);
  }

  async executeTurn(input: string, context: { source: string }): Promise<string> {
    this.status = "running";
    this.pushTrace({
      phase: "thought",
      name: "THINKING",
      detail: `Processing input from ${context.source}: "${input.substring(0, 60)}..."`
    });

    // Handle any pending observations before or during the turn
    let observationsText = "";
    if (this.activeRunContext.pendingObservations.length > 0) {
      const obs = [...this.activeRunContext.pendingObservations];
      this.activeRunContext.pendingObservations = [];
      observationsText = "\nPending UI Observations seen since last turn:\n" + obs.map(o => 
        `- Gadget [${o.gadgetId}] action [${o.action}] payload: ${JSON.stringify(o.payload)}`
      ).join("\n");
      
      this.pushTrace({
        phase: "observation",
        name: "PENDING_UI_CONSUMED",
        detail: `Consumed ${obs.length} pending UI observations during the active reasoning turn.`
      });
    }

    // Simulate AI model reasoning loop
    const systemPrompt = this.composeSystemPrompt();
    const fullPrompt = `${systemPrompt}\n\nUser/System Input: ${input}${observationsText}`;

    // Simple reasoning simulation based on expected actions
    let reply = "";
    if (input.includes("approve") || input.includes("BUTTON_CLICK")) {
      reply = `I see you've approved that invoice, I'm updating the journal now and processing the associated payment ledger entry.`;
      this.pushTrace({
        phase: "action",
        name: "LEDGER_UPDATE",
        detail: "Updating project journal and preparing payment processor API payload."
      });
    } else {
      reply = `I've registered your input. Current state updated successfully. Pending canvas gadgets synchronized.`;
    }

    this.status = "idle";
    this.pushTrace({
      phase: "thought",
      name: "COMPLETED",
      detail: "Turn finished, returning to dormant state."
    });

    return reply;
  }
}
