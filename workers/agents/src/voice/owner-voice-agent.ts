import { Agent } from "agents";
import { WorkersAIFluxSTT, WorkersAITTS, withVoice } from "agents/voice";
import type { AgentsEnv } from "../index.js";
import { dispatchOwnerVoiceTurn } from "./planner-turn.js";
import { verifyOwnerVoiceTicket } from "./voice-ticket.js";

const VoiceAgent = withVoice(Agent, { historyLimit: 2, maxMessageCount: 12 });

/** Browser voice extension built on Cloudflare's official Agents voice pipeline. The Agent DO
 * owns only transport/short voice history; Naelao's existing session planner remains canonical. */
export class OwnerVoiceAgent extends VoiceAgent<AgentsEnv> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  override async onConnect(connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0], context: Parameters<Agent<AgentsEnv>["onConnect"]>[1]): Promise<void> {
    const ticket = await verifyOwnerVoiceTicket(new URL(context.request.url).searchParams.get("ticket") ?? "", this.env.PLATFORM_SECRET, this.ctx.id.name ?? "");
    if (!ticket) {
      connection.close(1008, "voice_ticket_invalid");
      return;
    }
    connection.setState(ticket);
  }

  override async beforeCallStart(connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0]): Promise<boolean> {
    const ticket = connection.state as Awaited<ReturnType<typeof verifyOwnerVoiceTicket>>;
    return Boolean(ticket && (ticket.role === "owner" || ticket.role === "admin") && ticket.agentName === this.ctx.id.name);
  }

  override async onTurn(transcript: string, context: { connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0]; signal: AbortSignal }): Promise<string> {
    const ticket = context.connection.state as Awaited<ReturnType<typeof verifyOwnerVoiceTicket>>;
    if (!ticket || (ticket.role !== "owner" && ticket.role !== "admin") || ticket.agentName !== this.ctx.id.name) {
      throw new Error("voice_scope_unavailable");
    }
    return dispatchOwnerVoiceTurn(ticket, transcript, {
      platformSecret: this.env.PLATFORM_SECRET,
      agentsWorker: this.env.AGENTS_WORKER,
      signal: context.signal,
    });
  }
}
