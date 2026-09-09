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

export class AgentFirewall {
  static filterTools(tools: string[], isVoiceSession: boolean): string[] {
    if (!isVoiceSession) return tools;
    const allowed = [
      "calendar.check_availability",
      "calendar.book_slot",
      "knowledge.search",
      "support.create_ticket",
      "telephony.transfer_call"
    ];
    return tools.filter(t => allowed.includes(t));
  }
}
