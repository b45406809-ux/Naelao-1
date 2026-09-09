
Here is the complete, single, fully detailed Markdown specification for **`specs/phase-7/chunk-07-voice-telephony-and-copilot-channels.md`**.

---

```markdown
---
chunk_id: "phase-7-chunk-07"
phase: 7
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/launchpad/channels.ts
  - workers/agents/src/launchpad/channel-pairing.ts
  - packages/events/src/business-feature-kinds.ts
  - apps/shell/src/components/ComposerDock.tsx
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/agents/src/launchpad/channels.ts"
  - "workers/agents/src/launchpad/channel-pairing.ts"
  - "packages/events/src/business-feature-kinds.ts"
  - "apps/shell/src/components/ComposerDock.tsx"
expected_outputs:
  - workers/agents/src/voice/voice-agent.ts
  - workers/agents/src/workflows/OutboundCallWorkflow.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/launchpad/channels.ts
  - packages/events/src/business-feature-kinds.ts
  - apps/shell/src/components/ComposerDock.tsx
---

# Phase 7 — Chunk 07: Native Voice Telephony, Voice Desks & Executive Copilot Channels

## 1. Mental Model & Architectural Vision

Chunk 07 establishes the multimodal audio and external messaging ingress for AVOS. Rather than relying on expensive external SaaS voice brokers (Vapi/Retell) or exposing raw developer APIs to outside callers, this chunk implements:

1. **Native Duplex Voice Telephony (`@cloudflare/voice` + Cloudflare Calls WebRTC):**  
   Low-latency streaming audio (<300ms round-trip) running directly at Cloudflare's edge, orchestrating Streaming STT (Deepgram/Whisper) $\rightarrow$ Streaming LLM (Llama 3.3 70B) $\rightarrow$ Streaming TTS (Cartesia/Aura).
2. **The `kind: "voice_agent"` Project Kind:**  
   A dedicated call desk project kind that pairs with an inbound phone number, checks the universal `space_calendar_events` table in `SpaceDO`, books client consultations, and answers domain FAQs.
3. **Dual-Thread Voice Architecture:**  
   Separates human management from customer calls:
   * *Management Threads:* User chats with the agent to configure greetings, business hours, and phone settings.
   * *Call Session Threads (`thread_kind: "voice_call"`):* Auto-spawned per real phone call, storing full audio recording URLs, transcripts, caller sentiment, and action receipts.
4. **Outbound Calling Workflows:**  
   Cloudflare Dynamic Workflows that wake on cron schedules (e.g. daily at 10:00 AM), query tomorrow's appointments from `SpaceDO`, and trigger automated 1-minute reminder calls.
5. **In-Composer Voice Dictation (WhisperFlow-Style):**  
   Native browser audio capture in `ComposerDock.tsx` that streams directly to Workers AI Whisper (`@cf/openai/whisper`) for $0 compute cost.
6. **Private Executive Copilot Channel:**  
   Pairs WhatsApp and Telegram exclusively to the verified business owner/partner, providing on-the-go RAG, audio SOAP/note drafting, and 1-tap HITL approval cards.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   VOICE & TELEPHONY ARCHITECTURE                                       │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Inbound Customer Call (Twilio / Plivo / Calls WebRTC) ]                                             │
│                                           │                                                            │
│                                           ▼                                                            │
│ 1. 🌐 EDGE VOICE PIPELINE (`@cloudflare/voice`)                                                        │
│    • Inbound Audio Stream ──► Workers AI Streaming STT (<150ms).                                       │
│    • Streaming Llama 3.3 70B Reasoning ──► Calls `space.calendar.bookSlot()`.                         │
│    • Synthesizes Cartesia/Aura audio stream directly back to caller (<150ms).                          │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. 🗄️ DUAL-THREAD RECORDING & STATE COMMIT                                                             │
│    • Call ends ──► Auto-creates `thread_kind: "voice_call"` inside `kind: "voice_agent"` project.      │
│    • Stores audio recording URL, speaker transcript, and sentiment analysis in SQLite.                 │
│    • Broadcasts `voice.call_received` event to `apps/shell` via `WsHubDO`.                             │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Define `VOICE_AGENT_KIND` (`packages/events/src/business-feature-kinds.ts`)

Add the formal `voice_agent` kind to the registry:

```typescript
export const VOICE_AGENT_KIND: BusinessFeatureKind = {
  kind: "voice_agent",
  label: "Voice Telephony & Call Desk",
  description: "24/7 AI voice phone receptionist powered by Cloudflare Calls WebRTC and Workers AI.",
  singleton: false,
  minCreationRole: "admin",
  autoProvisionable: false,
  viewportComponent: "VoiceAgentCanvas",
  allowedLadderTiers: [1, 2], // Strictly clamped: Safe RAG and Calendar tools only!
  defaultContainer: undefined,
  lifecycle: "continuous",
  requiresTelephonyNumber: true,
  domainSystemPrompt: `You are an elite, highly professional Voice Receptionist speaking over a live telephone call.
Operating Rules:
1. Speak in short, natural, conversational sentences (1 to 2 sentences per turn max).
2. Do not use markdown syntax, asterisks, bullet points, or emojis in your speech output.
3. Check calendar availability using calendar tools before confirming any booking.
4. If the caller has an emergency or requests a human 3 times, transfer immediately using transfer_call.`,
  linterRules: ["phone-format-validator", "spoken-cadence-linter"]
};
```

---

### B. Implement `@cloudflare/voice` Engine (`workers/agents/src/voice/voice-agent.ts`)

Create the edge voice runtime class:

```typescript
import { Agent } from "agents";
import { withVoice } from "@cloudflare/voice";

export interface VoiceCallSessionMeta {
  callId: string;
  callerPhone: string;
  direction: "inbound" | "outbound";
  spaceId: string;
  projectId: string;
}

export class NaelaoVoiceAgent extends withVoice(Agent) {
  // Edge voice model configuration
  voice = {
    stt: { provider: "workers-ai" as const, model: "@cf/deepgram/flux" },
    tts: { provider: "workers-ai" as const, model: "@cf/deepgram/aura" },
    llm: { provider: "workers-ai" as const, model: "@cf/meta/llama-3.3-70b-instruct" }
  };

  // Clamped toolset for phone callers (Zero Bash, Zero File Edit, Zero Container)
  allowedTools = [
    "calendar.check_availability",
    "calendar.book_slot",
    "knowledge.search",
    "support.create_ticket",
    "telephony.transfer_call"
  ];

  async onCallStart(session: VoiceCallSessionMeta) {
    return {
      say: "Thank you for calling. How can I assist you today?"
    };
  }

  async onCallEnd(summary: { durationSeconds: number; transcript: string; recordingUrl?: string }, session: VoiceCallSessionMeta) {
    // Post call details to SpaceDO to create the `voice_call` thread
    await this.env.SPACES_WORKER.fetch(`http://internal/spaces/${session.spaceId}/projects/${session.projectId}/voice-calls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callId: session.callId,
        callerPhone: session.callerPhone,
        durationSeconds: summary.durationSeconds,
        transcript: summary.transcript,
        recordingUrl: summary.recordingUrl
      })
    });
  }
}
```

---

### C. Outbound Telephony Campaign Workflow (`workers/agents/src/workflows/OutboundCallWorkflow.ts`)

Implement the scheduled appointment reminder workflow:

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

interface OutboundCampaignPayload {
  spaceId: string;
  projectId: string;
  campaignType: "APPOINTMENT_CONFIRMATION" | "LEAD_FOLLOWUP";
}

export class OutboundCallWorkflow extends WorkflowEntrypoint<Env, OutboundCampaignPayload> {
  async run(event: WorkflowEvent<OutboundCampaignPayload>, step: WorkflowStep) {
    const { spaceId, projectId, campaignType } = event.payload;

    // Step 1: Query SpaceDO calendar for tomorrow's bookings
    const appointments = await step.do("fetch-tomorrow-appointments", async () => {
      const res = await this.env.SPACES_WORKER.fetch(
        `http://internal/spaces/${spaceId}/calendar/appointments?range=tomorrow&project_id=${projectId}`
      );
      return (await res.json()) as Array<{ id: string; clientName: string; clientPhone: string; startTime: string }>;
    });

    // Step 2: Sequentially dispatch outbound reminder calls with 30s pacing
    for (const apt of appointments) {
      await step.do(`dispatch-call-${apt.id}`, async () => {
        return await this.env.VOICE_GATEWAY.dispatchOutboundCall({
          to: apt.clientPhone,
          prompt: `You are calling ${apt.clientName} to confirm their appointment scheduled for tomorrow at ${apt.startTime}. Ask if they can still make it.`,
          initialGreeting: `Hello ${apt.clientName}, this is an automated confirmation call regarding your appointment tomorrow at ${apt.startTime}.`
        });
      });

      // 30-second pacing sleep between phone calls ($0 compute)
      await step.sleep(`pace-${apt.id}`, "30 seconds");
    }

    return { completed: true, totalCallsDispatched: appointments.length };
  }
}
```

---

### D. In-Composer Voice Dictation (`apps/shell/src/components/ComposerDock.tsx`)

Add native Whisper voice-to-text dictation into the composer dock:

```tsx
// Inside apps/shell/src/components/ComposerDock.tsx
export function VoiceDictationButton({ onTranscribed }: { onTranscribed: (text: string) => void }) {
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      const audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("audio", audioBlob);

        // Send directly to edge Workers AI Whisper endpoint
        const res = await fetch("/v1/voice/transcribe", {
          method: "POST",
          body: formData
        });

        const data = await res.json() as { text?: string };
        if (data.text) {
          onTranscribed(data.text);
        }
        setRecording(false);
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setRecording(true);
    } catch (err) {
      console.error("Microphone access denied or unsupported:", err);
      setRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    }
  };

  return (
    <button
      type="button"
      className={`dock-btn ${recording ? "recording-pulse text-danger" : "text-text3"}`}
      onClick={recording ? stopRecording : startRecording}
      title={recording ? "Click to stop recording" : "Voice dictation (Whisper)"}
    >
      🎙️ {recording && <span className="recording-text">Listening...</span>}
    </button>
  );
}
```

---

### E. Private Executive Copilot Channel Routing (`workers/agents/src/launchpad/channels.ts`)

Enforce that space-level WhatsApp/Telegram channels are authenticated strictly to the verified business owner:

```typescript
export async function routeInboundChannelMessage(
  channel: "telegram" | "whatsapp" | "slack" | "discord",
  senderId: string,
  messageText: string,
  spaceId: string,
  env: Env
) {
  // 1. Verify if this channel is mapped as the Space-Level Executive Copilot
  const pairing = await env.PLATFORM_DB.prepare(
    "SELECT * FROM channel_pairings WHERE space_id = ? AND channel = ? AND sender_id = ?"
  ).bind(spaceId, channel, senderId).first<{ paired_by: string; scope: string }>();

  if (!pairing) {
    return { ok: false, error: "Unauthorized: Unpaired channel sender." };
  }

  // 2. Space Copilot must match the verified Owner User ID
  const ownerMembership = await env.PLATFORM_DB.prepare(
    "SELECT role FROM business_memberships WHERE space_id = ? AND user_id = ? AND role IN ('owner', 'admin')"
  ).bind(spaceId, pairing.paired_by).first();

  if (!ownerMembership) {
    return { ok: false, error: "Forbidden: Only space owners and admins may access the Executive Copilot channel." };
  }

  // 3. Dispatch to Space Assistant DO with Owner identity
  const assistantDO = env.NAELAO_AGENT_DO.get(env.NAELAO_AGENT_DO.idFromName(`${spaceId}:naelao-agent`));
  return await assistantDO.fetch("http://internal/channel-session/message", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-user-id": pairing.paired_by,
      "x-naelao-role": "owner"
    },
    body: JSON.stringify({
      text: messageText,
      channel,
      senderId
    })
  });
}
```

---

## 3. Security Invariants for Chunk 07

1. **Hardware-Clamped Ladder for Phone Callers:** Inbound voice calls are strictly clamped to **Tier 1 (Safe RAG / In-Memory)**. The `AgentFirewall` physically strips `Bash`, file system modifications, and container access from voice sessions.
2. **Untrusted Spoken Audio Tagging:** Spoken caller input converted via STT is wrapped in `<untrusted_caller_audio>` boundary tags before entering model reasoning, preventing voice jailbreaks.
3. **Owner Pairing Non-Repudiation:** Inbound WhatsApp/Telegram webhooks verify cryptographic signatures (Meta HMAC / Telegram bot token) and validate sender phone IDs against verified `channel_pairings` rows.

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

1. Update `packages/events/src/business-feature-kinds.ts`:
   * Export `VOICE_AGENT_KIND` with `requiresTelephonyNumber: true`, `allowedLadderTiers: [1, 2]`, and `VoiceAgentCanvas`.
2. Create `workers/agents/src/voice/voice-agent.ts`:
   * Implement `NaelaoVoiceAgent` wrapping `withVoice(Agent)` from `@cloudflare/voice`.
   * Restrict tools strictly to calendar booking, ticket creation, and knowledge search.
3. Create `workers/agents/src/workflows/OutboundCallWorkflow.ts`:
   * Implement appointment reminder pacing with `step.sleep("30 seconds")`.
4. Update `workers/agents/src/launchpad/channels.ts`:
   * Implement owner-verified pairing checks in `routeInboundChannelMessage`.
5. Update `apps/shell/src/components/ComposerDock.tsx`:
   * Add `VoiceDictationButton` capturing `audio/webm` media streams and posting to `/v1/voice/transcribe`.
6. Run `node --check` syntax validation on all touched files.
```

---

#
