import { Agent } from "agents";
import { synthesizeVoicePcm } from "./pcm-speech.js";
import { WorkersAIFluxSTT, withVoice } from "agents/voice";
import type { AgentsEnv } from "../index.js";
import {
  verifyOwnerVoiceTicket,
  type OwnerVoiceTicket,
} from "./voice-ticket.js";
import { verifyVoiceSession } from "./session-scope.js";
import { DurableVoiceTurns } from "./durable-turn.js";
import { scopeAccess } from "../communications/core.js";
import {
  liveCallAllowed,
  type LiveCall,
} from "../communications/live-calls.js";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import {
  phoneProvider,
  resolvePhoneCredentials,
} from "../communications/phone-provider.js";
import type { CommunicationIdentity } from "../communications/core.js";
import type { AssistantPhoneBinding } from "../communications/phones.js";

const VoiceAgent = withVoice(Agent, {
  historyLimit: 2,
  maxMessageCount: 12,
  audioFormat: "pcm16",
  sampleRate: 16000,
});
/** Audio transport only. All reasoning, tools, approvals and durable work use the existing
 * Naelao planner/worker runtime, scoped to the app-authenticated human and session. */
export class OwnerVoiceAgent extends VoiceAgent<AgentsEnv> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  private activeTicket: OwnerVoiceTicket | null = null;
  private turns = new DurableVoiceTurns(
    this.ctx.storage,
    this.env.AGENTS_WORKER,
    this.env.PLATFORM_SECRET,
    this.env.SPACES_WORKER
  );
  private watcher: AbortController | null = null;
  private audioConnectionId: string | null = null;
  tts = {
    synthesize: async (
      text: string,
      signal?: AbortSignal
    ): Promise<ArrayBuffer | null> => {
      if (!this.activeTicket || !(await this.allowed(this.activeTicket)))
        throw new Error("voice_access_revoked");
      const audio = await synthesizeVoicePcm(this.env.AI, text, signal);
      if (!this.activeTicket || !(await this.allowed(this.activeTicket)))
        throw new Error("voice_access_revoked");
      return audio;
    },
  };
  private async allowed(ticket: OwnerVoiceTicket): Promise<boolean> {
    try {
      await verifyVoiceSession(
        this.env.SPACES_WORKER,
        this.env.PLATFORM_SECRET,
        {
          tenantId: ticket.tenantId,
          spaceId: ticket.spaceId,
          userId: ticket.userId,
          role: ticket.callerRole,
          ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
        },
        ticket.sessionId
      );
    } catch {
      return false;
    }
    if (ticket.phoneBindingId) {
      const call = await this.env.PLATFORM_DB.prepare(
        "SELECT l.* FROM assistant_live_calls l JOIN assistant_phone_bindings b ON b.id=l.binding_id JOIN assistant_communication_identities i ON i.id=b.identity_id WHERE l.id=? AND l.binding_id=? AND l.call_sid=? AND l.tenant_id=? AND l.space_id=? AND l.user_id=? AND l.session_id=? AND l.status='connected' AND b.status='active' AND i.status='active' AND l.deadline>?"
      )
        .bind(
          ticket.nonce,
          ticket.phoneBindingId,
          ticket.callSid!,
          ticket.tenantId,
          ticket.spaceId,
          ticket.userId,
          ticket.sessionId,
          Math.floor(Date.now() / 1000)
        )
        .first<LiveCall>();
      return !!call && (await liveCallAllowed(this.env, call));
    }
    return (
      (await scopeAccess(
        this.env,
        {
          tenantId: ticket.tenantId,
          spaceId: ticket.spaceId,
          userId: ticket.userId,
          role: ticket.callerRole,
          ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
        },
        true
      )) &&
      !(await isSpaceNetworkEgressDenied(this.env.PLATFORM_DB, ticket.spaceId))
    );
  }
  override async onConnect(
    connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0],
    context: Parameters<Agent<AgentsEnv>["onConnect"]>[1]
  ): Promise<void> {
    const ticket = await verifyOwnerVoiceTicket(
      new URL(context.request.url).searchParams.get("ticket") ?? "",
      this.env.PLATFORM_SECRET,
      this.ctx.id.name ?? ""
    );
    if (!ticket || !(await this.allowed(ticket))) {
      connection.close(1008, "voice_scope_unavailable");
      return;
    }
    // One active audio stream per session; reconnects take over transport, not task ownership.
    for (const previous of this.getConnections())
      if (previous.id !== connection.id)
        previous.close(1000, "voice_reconnected");
    this.watcher?.abort();
    this.audioConnectionId = connection.id;
    connection.setState(ticket);
    this.activeTicket = ticket;
    await this.ctx.storage.put("voice:ticket", ticket);
    if (ticket.phoneBindingId) {
      const call = await this.env.PLATFORM_DB.prepare(
        "SELECT deadline FROM assistant_live_calls WHERE id=?"
      )
        .bind(ticket.nonce)
        .first<{ deadline: number }>();
      if (call) await this.ctx.storage.setAlarm(call.deadline * 1000);
    }
  }
  override async beforeCallStart(
    connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0]
  ): Promise<boolean> {
    const ticket = connection.state as OwnerVoiceTicket | null;
    return (
      !!ticket &&
      ticket.agentName === this.ctx.id.name &&
      (await this.allowed(ticket))
    );
  }
  override async onInterrupt(
    connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0]
  ): Promise<void> {
    if (this.audioConnectionId === connection.id) this.watcher?.abort();
  }
  override async onCallEnd(
    connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0]
  ): Promise<void> {
    if (this.audioConnectionId === connection.id) {
      this.watcher?.abort();
      this.activeTicket = null;
    }
  }
  private watchCompletion(
    ticket: OwnerVoiceTicket,
    connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0]
  ): void {
    this.watcher?.abort();
    const watcher = new AbortController();
    this.watcher = watcher;
    this.ctx.waitUntil(
      (async () => {
        // Leave time for the current progress sentence to start. This watcher only reads/resumes
        // the saved task; it never submits another planner request or answers an approval.
        for (let n = 0; n < 180 && !watcher.signal.aborted; n++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (
            watcher.signal.aborted ||
            this.audioConnectionId !== connection.id ||
            connection.readyState !== 1 ||
            !(await this.allowed(ticket))
          )
            return;
          const reply = await this.turns.resume(ticket, watcher.signal);
          if (!(await this.turns.pending())) {
            if (
              reply &&
              !watcher.signal.aborted &&
              (await this.allowed(ticket))
            )
              await this.speak(connection, reply);
            return;
          }
        }
      })().catch(() => {})
    );
  }
  override async onTurn(
    transcript: string,
    context: {
      connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0];
      signal: AbortSignal;
    }
  ): Promise<string> {
    this.watcher?.abort();
    const ticket = context.connection.state as OwnerVoiceTicket | null;
    if (
      !ticket ||
      ticket.agentName !== this.ctx.id.name ||
      !(await this.allowed(ticket))
    ) {
      context.connection.close(1008, "voice_scope_unavailable");
      throw new Error("voice_scope_unavailable");
    }
    this.activeTicket = ticket;
    let reply: string;
    try {
      reply = await this.turns.turn(ticket, transcript, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      reply =
        "I could not confirm the task’s current status. Its saved progress is available in Naelao; check it before retrying an action.";
    }
    if (!(await this.allowed(ticket))) {
      context.connection.close(1008, "voice_access_revoked");
      throw new Error("voice_access_revoked");
    }
    if (await this.turns.pending())
      this.watchCompletion(ticket, context.connection);
    return reply;
  }
  override async alarm(): Promise<void> {
    this.watcher?.abort();
    for (const connection of this.getConnections())
      connection.close(1000, "voice_call_ended");
    const ticket = await this.ctx.storage.get<OwnerVoiceTicket>("voice:ticket");
    if (!ticket?.phoneBindingId) return;
    const binding = await this.env.PLATFORM_DB.prepare(
      "SELECT * FROM assistant_phone_bindings WHERE id=?"
    )
      .bind(ticket.phoneBindingId)
      .first<AssistantPhoneBinding>();
    const identity = binding
      ? await this.env.PLATFORM_DB.prepare(
          "SELECT * FROM assistant_communication_identities WHERE id=?"
        )
          .bind(binding.identity_id)
          .first<CommunicationIdentity>()
      : null;
    try {
      const credentials =
        identity && binding
          ? await resolvePhoneCredentials(this.env, identity, binding.payer)
          : null;
      if (!credentials) throw new Error("phone_credentials_unavailable");
      await phoneProvider(
        credentials,
        `Calls/${ticket.callSid}.json`,
        "POST",
        new URLSearchParams({ Status: "completed" })
      );
      await this.env.PLATFORM_DB.prepare(
        "UPDATE assistant_live_calls SET status='ended' WHERE id=? AND status='connected'"
      )
        .bind(ticket.nonce)
        .run();
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 30000);
    }
  }
}
