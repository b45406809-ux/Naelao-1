import { verifyInternalToken, readBoundedRequestText } from "@naelao/http";
import { Agent } from "agents";
import { withVoice } from "agents/voice";
import type { AgentsEnv } from "../index.js";
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AssistantVoicePreferences, AssistantVoiceSettings, RuntimeVault } from "@naelao/agent-sdk";
import { approvedAssistantVoice } from "@naelao/agent-sdk";
import { createVaultProxy } from "../script-engine/vault-proxy.js";
import { createOpenRouterAudio } from "./openrouter-audio.js";
import { OpenRouterLiveTranscriber } from "./openrouter-live-transcriber.js";
import { OpenRouterLiveTTS } from "./openrouter-live-tts.js";
import { createVoiceAudioAdmission } from "./audio-usage-admission.js";
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
  transcriber: import("agents/voice").Transcriber = { createSession: () => { throw new Error("voice_call_not_initialized"); } };
  private activeTicket: OwnerVoiceTicket | null = null;
  private activePreferences: AssistantVoicePreferences | null = null;
  private activeProfile: ReturnType<typeof approvedAssistantVoice> = null;
  private audio: ReturnType<typeof createOpenRouterAudio> | null = null;
  private admission: ReturnType<typeof createVoiceAudioAdmission> | null = null;
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
      if (!(await this.loadPreferences(this.activeTicket))) throw new Error("voice_disabled_or_unavailable");
      if (!this.audio || !this.activeProfile) throw new Error("voice_call_not_initialized");
      const audio = await new OpenRouterLiveTTS({
        audio: this.audio, model: this.activeProfile.speechModel, voice: this.activeProfile.speechVoice,
        ...(this.activePreferences?.deliveryInstructions ? { instructions: this.activePreferences.deliveryInstructions } : {}),
        priceUsdPerMillionCharacters: this.activeProfile.priceUsdPerMillionCharacters,
        speed: this.activePreferences?.speed ?? 1, sampleRate: this.activeProfile.sampleRate,
        requestId: () => crypto.randomUUID(),
      }).synthesize(text, signal);
      if (!this.activeTicket || !(await this.allowed(this.activeTicket)))
        throw new Error("voice_access_revoked");
      if (!(await this.loadPreferences(this.activeTicket))) throw new Error("voice_disabled_or_unavailable");
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
        "SELECT l.* FROM assistant_live_calls l JOIN assistant_phone_bindings b ON b.id=l.binding_id JOIN assistant_communication_identities i ON i.id=b.identity_id WHERE l.id=? AND l.binding_id=? AND l.call_sid=? AND l.tenant_id=? AND l.space_id=? AND l.user_id=? AND l.session_id=? AND l.status='connected' AND b.status='active' AND b.purpose='assistant' AND i.status='active' AND l.deadline>?"
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
        false
      )) &&
      !(await isSpaceNetworkEgressDenied(this.env.PLATFORM_DB, ticket.spaceId))
    );
  }
  private async loadPreferences(ticket: OwnerVoiceTicket): Promise<AssistantVoicePreferences | null> {
    const query = new URLSearchParams(ticket.projectId ? { project_id: ticket.projectId } : {});
    const url = `http://spaces/spaces/${encodeURIComponent(ticket.spaceId)}/assistant-voice${query.size ? `?${query}` : ""}`;
    const response = await this.env.SPACES_WORKER.fetch(new Request(url, { headers: {
      "x-naelao-tenant-id": ticket.tenantId, "x-naelao-user-id": ticket.userId,
      "x-naelao-role": ticket.callerRole,
      "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, ticket.tenantId),
    } }));
    if (!response.ok) return null;
    const settings = await readBoundedResponseJson<AssistantVoiceSettings>(response, 64 * 1024);
    const preferences = settings.preferences;
    if (!preferences?.enabled) return null;
    return preferences;
  }
  private async initializeAudio(ticket: OwnerVoiceTicket, preferences: AssistantVoicePreferences): Promise<void> {
    if (!this.env.BILLING_WORKER) throw new Error("voice_billing_unavailable");
    if (!this.env.CREDENTIALS_WORKER) throw new Error("voice_credentials_unavailable");
    const profile = approvedAssistantVoice(preferences.voiceProfileId, preferences.modelClass);
    if (!profile) throw new Error("voice_profile_unavailable");
    const vault: RuntimeVault = createVaultProxy({
      credentialsWorker: this.env.CREDENTIALS_WORKER!, platformSecret: this.env.PLATFORM_SECRET,
      tenantId: ticket.tenantId, spaceId: ticket.spaceId, agentId: ticket.agentName,
      userId: ticket.userId, ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
      runId: `voice-${ticket.nonce}`, purpose: "assistant-audio",
    });
    const admission = createVoiceAudioAdmission({
      tenantId: ticket.tenantId, spaceId: ticket.spaceId, callId: ticket.nonce,
      secret: this.env.PLATFORM_SECRET, billingWorker: this.env.BILLING_WORKER,
      journal: this.ctx.storage, maxCostUsd: preferences.maxCallCostUsd,
      stillAllowed: async () => (await this.allowed(ticket)) && !!(await this.loadPreferences(ticket))?.enabled,
      resolveGeneration: async (id, fallbackTokens) => {
        if (!this.audio) throw new Error("voice_audio_unavailable");
        return this.audio.resolveGeneration(id, fallbackTokens);
      },
    });
    // Credentials worker resolves the active key pointer internally; no plaintext provider key
    // crosses into this Durable Object.
    const audio = createOpenRouterAudio({ vault, credentialName: "llm_byok_active::openrouter", authorize: admission.authorize });
    this.activePreferences = preferences;
    this.activeProfile = profile;
    this.admission = admission;
    this.audio = audio;
    await this.ctx.storage.put("voice:preferences", preferences);
    this.transcriber = new OpenRouterLiveTranscriber({
      provider: { transcribe: ({ requestId, data, format }) => audio.transcribe({
        model: profile.transcriptionModel, requestId, data, format,
        ...(preferences.language !== "auto" ? { language: preferences.language } : {}),
        priceUsdPerSecond: profile.transcriptionUsdPerSecond,
      }) },
      requestId: () => crypto.randomUUID(),
    });
    await admission.reconcile();
  }
  private async reconcileVoiceUsage(ticket: OwnerVoiceTicket): Promise<void> {
    if (!this.env.BILLING_WORKER || !this.env.CREDENTIALS_WORKER) return;
    const preferences = await this.ctx.storage.get<AssistantVoicePreferences>("voice:preferences");
    const vault: RuntimeVault = createVaultProxy({
      credentialsWorker: this.env.CREDENTIALS_WORKER, platformSecret: this.env.PLATFORM_SECRET,
      tenantId: ticket.tenantId, spaceId: ticket.spaceId, agentId: ticket.agentName,
      userId: ticket.userId, ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
      runId: `voice-${ticket.nonce}`, purpose: "assistant-audio",
    });
    const audio = createOpenRouterAudio({ vault, credentialName: "llm_byok_active::openrouter", authorize: async () => { throw new Error("voice_reconciliation_only"); } });
    const admission = createVoiceAudioAdmission({
      tenantId: ticket.tenantId, spaceId: ticket.spaceId, callId: ticket.nonce,
      secret: this.env.PLATFORM_SECRET, billingWorker: this.env.BILLING_WORKER,
      journal: this.ctx.storage, maxCostUsd: preferences?.maxCallCostUsd ?? 100,
      stillAllowed: async () => false,
      resolveGeneration: (id, fallbackTokens) => audio.resolveGeneration(id, fallbackTokens),
    });
    await admission.reconcile();
  }
  private async retryableUsageRemains(ticket: OwnerVoiceTicket): Promise<boolean> {
    const entries = await this.ctx.storage.list<{ state: string; generationId?: string }>({ prefix: `voice-audio:${ticket.nonce}:` });
    return [...entries.values()].some((record) => record.state === "settle_retry" || record.state === "pending" && !!record.generationId);
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
    let preferences: AssistantVoicePreferences | null;
    try { preferences = await this.loadPreferences(ticket); }
    catch { preferences = null; }
    if (!preferences) { connection.close(1008, "voice_disabled_or_unavailable"); return; }
    try { await this.initializeAudio(ticket, preferences); }
    catch { connection.close(1011, "voice_provider_unavailable"); return; }
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
      (await this.allowed(ticket)) && !!(await this.loadPreferences(ticket))?.enabled
    );
  }
  override async onCallStart(
    connection: Parameters<Agent<AgentsEnv>["onConnect"]>[0]
  ): Promise<void> {
    const ticket = connection.state as OwnerVoiceTicket | null;
    if (!ticket || !(await this.allowed(ticket)))
      throw new Error("voice_scope_unavailable");
    const preferences = await this.loadPreferences(ticket);
    if (!preferences || !this.activeProfile) throw new Error("voice_disabled_or_unavailable");
    let callDeadline = Date.now() + preferences.maxCallMinutes * 60_000;
    if (ticket.phoneBindingId) {
      const phoneCall = await this.env.PLATFORM_DB.prepare("SELECT deadline FROM assistant_live_calls WHERE id=? AND status='connected'")
        .bind(ticket.nonce).first<{ deadline: number }>();
      if (phoneCall) callDeadline = Math.min(callDeadline, phoneCall.deadline * 1000);
    }
    await this.ctx.storage.setAlarm(callDeadline);
    await this.env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_active_voice_endpoints(tenant_id,space_id,project_key,user_id,agent_name,connection_id,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,space_id,project_key,user_id) DO UPDATE SET agent_name=excluded.agent_name,connection_id=excluded.connection_id,expires_at=excluded.expires_at"
    )
      .bind(
        ticket.tenantId,
        ticket.spaceId,
        ticket.projectId ?? "",
        ticket.userId,
        ticket.agentName,
        connection.id,
        Date.now() + 900000
      )
      .run();
  }
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/internal/voice-notification")
      return super.onRequest(request);
    const tenant = request.headers.get("x-naelao-tenant-id") ?? "";
    if (
      request.method !== "POST" ||
      !(await verifyInternalToken(
        request.headers.get("x-naelao-internal-token") ?? undefined,
        tenant,
        this.env.PLATFORM_SECRET
      ))
    )
      return new Response("Forbidden", { status: 403 });
    const body = JSON.parse(await readBoundedRequestText(request, 8192)) as {
      spaceId: string;
      projectId: string | null;
      userId: string;
      eventId: string;
      message: string;
    };
    const ticket = this.activeTicket;
    if (
      !ticket ||
      ticket.tenantId !== tenant ||
      ticket.spaceId !== body.spaceId ||
      (ticket.projectId ?? null) !== body.projectId ||
      ticket.userId !== body.userId ||
      typeof body.message !== "string" ||
      body.message.length > 4000 ||
      !(await this.allowed(ticket))
    )
      return new Response("No active authorized call", { status: 404 });
    const connection = [...this.getConnections()].find(
      (c) => c.id === this.audioConnectionId && c.readyState === 1
    );
    if (!connection) return new Response("No active call", { status: 404 });
    const task = /^task:([-a-zA-Z0-9._]+):completed$/.exec(body.eventId);
    if (task && (await this.turns.ownsTask(task[1]!)))
      return Response.json({ delivered: true, coalesced: true });
    await this.speak(connection, "Assistant update. " + body.message);
    return Response.json({ delivered: true });
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
      if (this.admission) await this.admission.reconcile().catch(() => {});
      else {
        const ticket = connection.state as OwnerVoiceTicket | null;
        if (ticket) await this.reconcileVoiceUsage(ticket).catch(() => {});
      }
      this.activeTicket = null;
      this.activePreferences = null;
      this.activeProfile = null;
      this.audio = null;
      this.admission = null;
      const ticket = connection.state as OwnerVoiceTicket | null;
      if (ticket)
        await this.env.PLATFORM_DB.prepare(
          "DELETE FROM assistant_active_voice_endpoints WHERE tenant_id=? AND space_id=? AND project_key=? AND user_id=? AND connection_id=?"
        )
          .bind(
            ticket.tenantId,
            ticket.spaceId,
            ticket.projectId ?? "",
            ticket.userId,
            connection.id
          )
          .run();
      const endedTicket = connection.state as OwnerVoiceTicket | null;
      if (endedTicket && await this.retryableUsageRemains(endedTicket)) await this.ctx.storage.setAlarm(Date.now() + 30_000);
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
          if (
            this.turns.completionReady &&
            reply &&
            !watcher.signal.aborted &&
            (await this.allowed(ticket))
          )
            await this.speak(connection, reply);
          if (!(await this.turns.pending())) return;
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
    const currentPreferences = await this.loadPreferences(ticket);
    if (!currentPreferences) {
      context.connection.close(1008, "voice_disabled_or_unavailable");
      throw new Error("voice_disabled_or_unavailable");
    }
    const configuredProfile = approvedAssistantVoice(currentPreferences.voiceProfileId, currentPreferences.modelClass);
    if (!configuredProfile) throw new Error("voice_profile_unavailable");
    if (!this.activeProfile || this.activeProfile.id !== configuredProfile.id
      || this.activePreferences?.speed !== currentPreferences.speed
      || this.activePreferences?.language !== currentPreferences.language
      || this.activePreferences?.deliveryInstructions !== currentPreferences.deliveryInstructions) {
      await this.initializeAudio(ticket, currentPreferences);
    }
    this.activeTicket = ticket;
    await this.env.PLATFORM_DB.prepare("UPDATE assistant_active_voice_endpoints SET expires_at=? WHERE tenant_id=? AND space_id=? AND project_key=? AND user_id=? AND connection_id=?")
      .bind(Date.now()+900000,ticket.tenantId,ticket.spaceId,ticket.projectId??"",ticket.userId,context.connection.id).run();
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
    const ticket = await this.ctx.storage.get<OwnerVoiceTicket>("voice:ticket");
    if (this.admission) await this.admission.reconcile().catch(() => {});
    else if (ticket) await this.reconcileVoiceUsage(ticket).catch(() => {});
    for (const connection of this.getConnections())
      connection.close(1000, "voice_call_ended");
    if (!ticket?.phoneBindingId) {
      if (ticket && await this.retryableUsageRemains(ticket)) await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
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
    if (ticket && await this.retryableUsageRemains(ticket)) await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
}
