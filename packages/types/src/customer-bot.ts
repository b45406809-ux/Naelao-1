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
  sentiment?: "POSITIVE" | "NEUTRAL" | "FRUSTRATED" | "ANGRY";
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
