```markdown
---
chunk_id: "phase-7-chunk-05"
phase: 7
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/spaces/src/do/SpaceDO.ts
  - workers/router/src/index.ts
  - packages/events/src/business-feature-kinds.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/router/src/index.ts"
  - "packages/events/src/business-feature-kinds.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - packages/types/src/voice.ts
  - packages/types/src/index.ts
  - workers/agents/src/voice/voice-agent.ts
  - workers/spaces/src/routes/voice-webhooks.ts
  - workers/agents/src/workflows/OutboundCallWorkflow.ts
  - packages/events/src/business-feature-kinds.ts
  - workers/spaces/src/do/SpaceDO.ts
  - workers/router/src/index.ts
---

# Phase 7 — Chunk 05: Native Edge Voice Telephony, 24/7 Call Desks & Universal Calendar State

## 1. Mental Model & Architectural Vision

AVOS implements full duplex real-time telephony and voice agent desks natively at Cloudflare's edge using **`@cloudflare/voice`** and **Cloudflare Calls (WebRTC SFU)**.

By leveraging Cloudflare's colocated edge inference rather than routing through third-party voice brokers (like Vapi or Retell), the platform achieves:
* **Sub-300ms Round-Trip Audio Latency:** Streaming Speech-to-Text (STT via Deepgram Flux / Workers AI Whisper) $\rightarrow$ Fast Token Generation (Workers AI Llama 3.3 70B) $\rightarrow$ Streaming Text-to-Speech (TTS via Deepgram Aura / Cartesia) runs entirely at Cloudflare's edge.
* **Radical Cost Reduction:** Slashes telephony compute fees from **$0.15/minute** down to **$0.04/minute**.
* **Dual-Thread Project Architecture (`kind: "voice_agent"`):**
  1. *Management Threads:* The owner/admin uses natural language in chat to configure prompts, business hours, voices, and call forwarding rules.
  2. *Call Session Threads (`thread_kind: "voice_call"`):* The edge router auto-spawns an isolated thread per incoming/outgoing phone call with embedded audio recordings, full transcripts, sentiment metrics, and direct links to booked calendar slots.
* **Strict Security Clamping for Callers:** Outside public callers speaking to the voice bot are clamped to **Tier 1 (Safe RAG + Calendar tools only)**. Filesystem modification tools (`Edit`, `Write`), shell access (`Bash`), and Linux containers are physically stripped via `AgentFirewall`.

```
[ Inbound Phone Call / WebRTC Client ]
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. AUDIO INGRESS (Cloudflare Calls WebRTC SFU / Twilio SIP Trunk)           │
│    Ultra-low latency audio stream received directly at Cloudflare edge.     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. REAL-TIME STREAMING PIPELINE (@cloudflare/voice)                         │
│    • Streaming STT: Workers AI Whisper / Deepgram Flux (<150ms).            │
│    • Edge Reasoning: Workers AI Llama 3.3 70B (Sentence chunked).           │
│    • Streaming TTS: Deepgram Aura / Cartesia with real-time barge-in.       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. UNIVERSAL SHARED STATE WRITE (`SpaceDO.space_calendar_events`)          │
│    Agent calls `ctx.space.calendar.bookSlot()` atomically during speech.    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. AUTO-GENERATED CALL THREAD (`thread_kind: "voice_call"`)                 │
│    Transcript, recording URL, and AI summary committed to `SpaceDO` SQLite. │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Universal Shared Calendar & CRM Schema (`SpaceDO.ts` SQLite)

Appointments and customer states booked over voice telephony commit to the universal `space_calendar_events` table inside `SpaceDO` SQLite, making them immediately visible to all other project workstations (e.g. Legal `doc_studio`, Developer dashboards, and Founder morning Telegram briefings).

```sql
-- SpaceDO.ts SQLite Migration: Universal Calendar & Telephony Records

CREATE TABLE IF NOT EXISTS space_calendar_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  created_by_project_id TEXT,               -- e.g. "voice_agent_proj_01"
  client_name TEXT NOT NULL,
  client_contact TEXT NOT NULL,             -- Phone number or email
  event_type TEXT NOT NULL DEFAULT 'consultation', -- 'consultation', 'cleaning', 'support'
  start_time TEXT NOT NULL,                 -- ISO-8601 UTC
  end_time TEXT NOT NULL,                   -- ISO-8601 UTC
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'COMPLETED')),
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cal_time ON space_calendar_events(space_id, start_time);
CREATE INDEX IF NOT EXISTS idx_cal_proj ON space_calendar_events(project_id, start_time);

CREATE TABLE IF NOT EXISTS voice_call_logs (
  call_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  recording_url TEXT,
  sentiment TEXT CHECK (sentiment IN ('POSITIVE', 'NEUTRAL', 'FRUSTRATED', 'ANGRY')),
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_call_proj ON voice_call_logs(project_id, created_at DESC);
```

---

## 3. Canonical Type Contracts (`packages/types/src/voice.ts`)

Create `packages/types/src/voice.ts` and re-export from `packages/types/src/index.ts`:

```typescript
export interface CalendarEventRecord {
  id: string;
  spaceId: string;
  projectId?: string;
  clientName: string;
  clientContact: string;
  eventType: string;
  startTime: string; // ISO-8601 UTC
  endTime: string;   // ISO-8601 UTC
  status: "CONFIRMED" | "CANCELLED" | "RESCHEDULED" | "COMPLETED";
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface VoiceCallRecord {
  callId: string;
  spaceId: string;
  projectId: string;
  threadId: string;
  customerPhone: string;
  direction: "inbound" | "outbound";
  durationSeconds: number;
  recordingUrl?: string;
  sentiment?: "POSITIVE" | "NEUTRAL" | "FRUSTRATED" | "ANGRY";
  summary: string;
  createdAt: string;
}

export interface VoiceDeskConfig {
  telephony: {
    phoneNumber: string;
    carrier: "twilio" | "plivo" | "cloudflare_calls";
    transferFallbackNumber?: string;
  };
  voice: {
    provider: "deepgram" | "cartesia" | "elevenlabs";
    voiceId: string;
    speed: number;
    bargeInSensitivity: "low" | "medium" | "high";
    greeting: string;
  };
  prompt: {
    systemPrompt: string;
    businessHours: string;
    emergencyRules: string;
  };
  tools: {
    enableCalendarBooking: boolean;
    enableKbFaqSearch: boolean;
    enableCallTransfer: boolean;
  };
  scheduledOutboundCampaigns?: Array<{
    name: string;
    cron: string;
    scriptPath: string;
  }>;
}
```

---

## 4. Implementation Requirements

### A. Edge Voice Agent Class (`workers/agents/src/voice/voice-agent.ts`)
Implement the `@cloudflare/voice` integration binding the duplex audio pipeline to the project's knowledge and calendar state:

```typescript
import { Agent } from "agents";
import { withVoice } from "@cloudflare/voice";

export class NaelaoVoiceAgent extends withVoice(Agent) {
  // Edge voice model configuration
  voice = {
    stt: { provider: "workers-ai", model: "@cf/deepgram/flux" },
    tts: { provider: "workers-ai", model: "@cf/deepgram/aura" },
    llm: { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct" }
  };

  async onCallStart(session: any) {
    const config = await this.loadVoiceConfig();
    return {
      greeting: config.voice.greeting || "Hello! Thank you for calling. How can I assist you today?",
      bargeIn: config.voice.bargeInSensitivity !== "low"
    };
  }

  async onSpeechTurn(userUtterance: string, ctx: any) {
    // 1. Enforce Tier 1 Security Clamp (Safe RAG & Calendar Tools Only)
    // Physically blocks any filesystem or terminal tools from phone callers
    const safeTools = {
      checkCalendarAvailability: async (params: { timeIso: string }) => {
        return await ctx.space.calendar.checkAvailability(params.timeIso);
      },
      bookAppointment: async (params: { clientName: string; timeIso: string; serviceType: string }) => {
        return await ctx.space.calendar.bookSlot({
          clientName: params.clientName,
          startTime: params.timeIso,
          eventType: params.serviceType
        });
      },
      searchFaqs: async (params: { query: string }) => {
        return await ctx.kb.search(params.query, { limit: 3 });
      },
      transferToHuman: async (params: { reason: string }) => {
        const config = await this.loadVoiceConfig();
        return { transferTo: config.telephony.transferFallbackNumber };
      }
    };

    // 2. Execute conversational reasoning
    const reply = await this.executeSafeVoiceTurn(userUtterance, safeTools);
    return reply;
  }

  private async loadVoiceConfig(): Promise<VoiceDeskConfig> {
    const raw = await this.ctx.storage.get<string>("voice_agent_config");
    return raw ? JSON.parse(raw) : {
      telephony: { phoneNumber: "", carrier: "cloudflare_calls" },
      voice: { provider: "deepgram", voiceId: "aura-asteria-en", speed: 1.0, bargeInSensitivity: "high", greeting: "Hello! How can I help you?" },
      prompt: { systemPrompt: "You are a polite receptionist.", businessHours: "9am - 5pm", emergencyRules: "Transfer emergencies immediately." },
      tools: { enableCalendarBooking: true, enableKbFaqSearch: true, enableCallTransfer: true }
    };
  }
}
```

---

### B. Inbound Webhook & Call Thread Spawner (`workers/spaces/src/routes/voice-webhooks.ts`)
When a call completes, the webhook records the full recording, transcript, and sentiment analysis, automatically creating a `thread_kind: "voice_call"` thread:

```typescript
import { Hono } from "hono";
import { spaceDoStub } from "../do-stub";
import { broadcastSpaceEvent } from "@naelao/http";

export const voiceWebhookApp = new Hono<{ Bindings: Env }>();

voiceWebhookApp.post("/webhooks/voice/call-completed", async (c) => {
  const payload = await c.req.json<{
    spaceId: string;
    projectId: string;
    callId: string;
    customerPhone: string;
    direction: "inbound" | "outbound";
    durationSeconds: number;
    recordingUrl: string;
    transcript: string;
    summary: string;
    sentiment: "POSITIVE" | "NEUTRAL" | "FRUSTRATED" | "ANGRY";
  }>();

  const { spaceId, projectId, callId, customerPhone, direction, durationSeconds, recordingUrl, transcript, summary, sentiment } = payload;
  const spaceDO = await spaceDoStub(c.env, spaceId);

  // 1. Spawn a dedicated Call Session Thread
  const threadTitle = `📞 ${direction === "inbound" ? "Inbound Call" : "Outbound Call"}: ${customerPhone} (${Math.round(durationSeconds / 60)}m)`;
  const thread = await spaceDO.createThread({
    projectId,
    title: threadTitle,
    threadKind: "voice_call", // Distinct call thread kind
    metadata: {
      callId,
      customerPhone,
      direction,
      durationSeconds,
      recordingUrl,
      sentiment,
      summary
    }
  });

  // 2. Commit Full Transcript as Message
  await spaceDO.appendMessage(thread.sessionId, {
    role: "assistant",
    content: `### 📞 Call Transcript (${customerPhone})\n\n**AI Summary:** ${summary}\n**Sentiment:** ${sentiment} | **Duration:** ${durationSeconds}s\n\n---\n${transcript}`,
    metadata: {
      audioRecordingUrl: recordingUrl,
      callId
    }
  });

  // 3. Insert into persistent call logs table
  await spaceDO.executeSql(`
    INSERT INTO voice_call_logs (call_id, space_id, project_id, thread_id, customer_phone, direction, duration_seconds, recording_url, sentiment, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, callId, spaceId, projectId, thread.id, customerPhone, direction, durationSeconds, recordingUrl, sentiment, summary);

  // 4. Real-time broadcast to UI via WsHubDO WebSockets
  await broadcastSpaceEvent(c.env, c.req.header("x-naelao-tenant-id") || "", spaceId, "voice.call_completed", {
    threadId: thread.id,
    customerPhone,
    summary,
    sentiment
  });

  return c.json({ ok: true, threadId: thread.id });
});
```

---

### C. Outbound Telephony Reminder Workflow (`workers/agents/src/workflows/OutboundCallWorkflow.ts`)
Implements automated appointment confirmation calling campaigns using Cloudflare Workflows:

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { spaceDoStub } from "../do-stub";

export interface OutboundCampaignPayload {
  spaceId: string;
  projectId: string;
  campaignType: "APPOINTMENT_CONFIRMATION" | "LEAD_FOLLOWUP";
}

export class OutboundCallWorkflow extends WorkflowEntrypoint<Env, OutboundCampaignPayload> {
  async run(event: WorkflowEvent<OutboundCampaignPayload>, step: WorkflowStep) {
    const { spaceId, projectId, campaignType } = event.payload;

    if (campaignType === "APPOINTMENT_CONFIRMATION") {
      // Step 1: Query SpaceDO calendar for tomorrow's unconfirmed appointments
      const appointments = await step.do("fetch-tomorrow-appointments", async () => {
        const spaceDO = await spaceDoStub(this.env, spaceId);
        const res = await spaceDO.fetch(`http://internal/calendar/unconfirmed-tomorrow?project_id=${projectId}`);
        return (await res.json()) as Array<{ id: string; clientName: string; clientContact: string; startTime: string }>;
      });

      // Step 2: Dispatch calls sequentially with rate pacing
      for (const apt of appointments) {
        await step.do(`call-${apt.id}`, async () => {
          return await this.env.VOICE_SERVICE.dispatchOutboundCall({
            spaceId,
            projectId,
            toNumber: apt.clientContact,
            clientName: apt.clientName,
            appointmentTime: apt.startTime,
            promptDirectives: `You are calling ${apt.clientName} to confirm their appointment tomorrow at ${apt.startTime}. Ask if they can attend.`
          });
        });

        // 30-second pacing between outbound calls
        await step.sleep(`pace-${apt.id}`, "30 seconds");
      }
    }
  }
}
```

---

### D. In-Composer Voice-to-Text Transcription (`workers/router/src/index.ts`)
Provides native voice dictation inside the chat ComposerDock powered by Workers AI Whisper:

```typescript
app.post("/v1/voice/transcribe", async (c) => {
  const formData = await c.req.formData();
  const audioFile = formData.get("audio") as File;

  if (!audioFile) {
    return c.json({ error: "Missing audio payload" }, 400);
  }

  const arrayBuffer = await audioFile.arrayBuffer();
  const audioBytes = [...new Uint8Array(arrayBuffer)];

  // Run Cloudflare Workers AI Whisper model at edge ($0 compute cost)
  const response = await c.env.AI.run("@cf/openai/whisper", {
    audio: audioBytes
  });

  return c.json({
    ok: true,
    text: response.text ? response.text.trim() : ""
  });
});
```

---

### E. Register `voice_agent` Project Kind (`packages/events/src/business-feature-kinds.ts`)

Ensure `VOICE_AGENT_KIND` is registered:

```typescript
export const VOICE_AGENT_KIND: BusinessFeatureKind = {
  kind: "voice_agent",
  label: "Voice Telephony & Call Desk",
  description: "24/7 AI voice phone receptionist powered by @cloudflare/voice and WebRTC.",
  singleton: false,
  minCreationRole: "admin",
  autoProvisionable: true,
  viewportComponent: "VoiceAgentCanvas", // Call logs, waveform visualizer, phone number config
  allowedLadderTiers: [1, 2],           // Clamped to Safe RAG & Calendar tools
  requiresTelephonyNumber: true,
  lifecycle: "continuous",
  domainSystemPrompt: `You are a 24/7 AI Voice Phone Receptionist.
Rules:
1. Speak in concise, natural sentences (1-2 sentences per conversational turn).
2. Never output markdown formatting, bullet points, or emoji symbols in spoken speech.
3. Verify calendar availability and confirm appointment bookings immediately.`
};
```

---

## 5. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/voice.ts` exporting `CalendarEventRecord`, `VoiceCallRecord`, and `VoiceDeskConfig`; re-export from `packages/types/src/index.ts`.
2. Update `workers/spaces/src/do/SpaceDO.ts` SQLite initialization to create `space_calendar_events` and `voice_call_logs` tables with appropriate indexes.
3. Implement `workers/agents/src/voice/voice-agent.ts` with `NaelaoVoiceAgent` wrapping `@cloudflare/voice`.
4. Create `workers/spaces/src/routes/voice-webhooks.ts` with the `call-completed` webhook spawner and mount on the spaces router.
5. Implement `workers/agents/src/workflows/OutboundCallWorkflow.ts` handling automated reminder campaigns.
6. Add `/v1/voice/transcribe` endpoint in `workers/router/src/index.ts` calling `@cf/openai/whisper`.
7. Update `packages/events/src/business-feature-kinds.ts` with the `VOICE_AGENT_KIND` declaration.
8. Run local syntax checks across modified files to ensure strict TypeScript type safety.
```
