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

export interface AgentMessageEvent {
  type: "agent.message";
  spaceId: string;
  projectId: string;
  sessionId: string;
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export interface AgentTraceEvent {
  type: "agent.trace";
  spaceId: string;
  projectId: string;
  sessionId: string;
  phase: "thought" | "action" | "observation";
  name: string;
  detail: string;
  params?: Record<string, any>;
  timestamp: string;
}

export type NaelaoEvent = UIActionEvent | AgentMessageEvent | AgentTraceEvent;
