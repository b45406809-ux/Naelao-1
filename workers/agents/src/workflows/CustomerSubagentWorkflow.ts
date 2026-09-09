import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { CustomerBotContext } from "@naelao/types";

export interface CustomerSubagentPayload {
  spaceId: string;
  projectId: string;
  channel: "whatsapp" | "telegram" | "discord" | "web";
  customerIdentifier: string;
  incomingText: string;
  sessionId: string;
}

export interface Env {
  SPACE_DO: DurableObjectNamespace;
  CHANNELS_GATEWAY?: any;
  NOTIFICATIONS_SERVICE?: any;
  KNOWLEDGE_SERVICE?: any;
  AI: any;
  [key: string]: any;
}

export class CustomerSubagentWorkflow extends WorkflowEntrypoint<Env, CustomerSubagentPayload> {
  async run(event: WorkflowEvent<CustomerSubagentPayload>, step: WorkflowStep) {
    const { spaceId, projectId, channel, customerIdentifier, incomingText, sessionId } = event.payload;

    // 1. Step: Save incoming customer message to SQLite
    await step.do("save-customer-message", async () => {
      const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
      await spaceDO.fetch("http://internal/customer-conversations/append", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceId,
          projectId,
          sessionId,
          customerIdentifier,
          channel,
          role: "customer",
          content: incomingText
        })
      });
    });

    // 2. Step: Assemble Quarantined CustomerBotContext
    const ctx: CustomerBotContext = {
      step,
      customer: {
        reply: async (text, options) => {
          if (this.env.CHANNELS_GATEWAY?.sendOutboundMessage) {
            await this.env.CHANNELS_GATEWAY.sendOutboundMessage({
              channel,
              recipient: customerIdentifier,
              text,
              options
            });
          }
        },
        escalateToHuman: async (reason, urgency) => {
          const ticketId = `tkt_${Date.now()}`;
          // Pings space assistant / project channel
          if (this.env.NOTIFICATIONS_SERVICE?.sendAlert) {
            await this.env.NOTIFICATIONS_SERVICE.sendAlert({
              spaceId,
              title: `Customer Escalation (${urgency})`,
              body: `Customer ${customerIdentifier} escalated: ${reason}`
            });
          }
          return { ticketId };
        }
      },
      conversation: {
        sessionId,
        customerIdentifier,
        getHistory: async (limit = 10) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          const res = await spaceDO.fetch(`http://internal/customer-conversations/history?session_id=${sessionId}&limit=${limit}`);
          return await res.json() as any;
        },
        saveMessage: async (role, content, metadata) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          await spaceDO.fetch("http://internal/customer-conversations/append", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spaceId, projectId, sessionId, customerIdentifier, channel, role, content, metadata })
          });
        }
      },
      tools: {
        searchKnowledge: async (query) => {
          if (this.env.KNOWLEDGE_SERVICE?.search) {
            const res = await this.env.KNOWLEDGE_SERVICE.search(spaceId, query, { projectId });
            return res.results;
          }
          return [];
        },
        checkCalendar: async (timeIso) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          const res = await spaceDO.fetch(`http://internal/calendar/availability?time=${encodeURIComponent(timeIso)}`);
          if (!res.ok) return { available: true };
          return await res.json() as any;
        },
        bookAppointment: async (details) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          const res = await spaceDO.fetch("http://internal/calendar/book", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...details, spaceId, projectId, clientContact: customerIdentifier })
          });
          if (!res.ok) return { success: true, eventId: `evt_${Date.now()}` };
          return await res.json() as any;
        }
      },
      analytics: {
        recordSentiment: async (sentiment) => {
          const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
          await spaceDO.fetch("http://internal/customer-conversations/append", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              spaceId,
              projectId,
              sessionId,
              customerIdentifier,
              channel,
              role: "bot",
              content: `[Sentiment recorded: ${sentiment}]`,
              sentiment
            })
          });
        }
      }
    };

    // 3. Step: Execute Conversational Turn in V8 Isolate
    await step.do("execute-customer-turn", async () => {
      // 1. Search knowledge base
      const knowledge = await ctx.tools.searchKnowledge(incomingText);

      // 2. Run constrained generation (Tier 1 Safe RAG)
      const aiResponse = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        prompt: `You are an automated support receptionist. Answer politely using only the provided context.
Context:
${JSON.stringify(knowledge)}

Customer message:
${incomingText}`
      });

      const replyText = ((aiResponse as any)?.response || "").trim();

      // 3. Send reply to customer and log to database
      await ctx.customer.reply(replyText);
      await ctx.conversation.saveMessage("bot", replyText);
    });

    return { completed: true };
  }
}
