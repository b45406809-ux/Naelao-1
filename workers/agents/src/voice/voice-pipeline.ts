import type { VoiceAgentConfig, VoiceCallSummary } from "@naelao/agent-sdk";

export const WHISPER_MODEL = "@cf/openai/whisper";
export const VOICE_LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const DEFAULT_TTS_MODEL = "@cf/myshell-ai/melotts";

// The voice adapter receives a completed utterance, not a full call recording. Keep both the
// provider payload and prompt memory bounded even if an ingress implementation misbehaves.
export const MAX_VOICE_FRAME_BYTES = 5 * 1024 * 1024;
export const MAX_VOICE_TURN_CHARS = 2_000;
export const MAX_VOICE_TRANSCRIPT_TURNS = 24;
const MAX_VOICE_PROMPT_CHARS = 12_000;

export interface VoiceAi {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

export interface VoiceTransport {
  sendAudio(audio: ReadableStream<Uint8Array> | ArrayBuffer): Promise<void>;
  stopAudio(): Promise<void>;
}

type Turn = VoiceCallSummary["transcript"][number];

function textFrom(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const value = result as { text?: unknown; response?: unknown };
  return String(value.text ?? value.response ?? "").trim();
}

function audioFrom(result: unknown): ArrayBuffer | ReadableStream<Uint8Array> {
  if (result instanceof ArrayBuffer || result instanceof ReadableStream) return result;
  if (result && typeof result === "object" && "audio" in result) {
    const audio = (result as { audio: unknown }).audio;
    if (audio instanceof ArrayBuffer || audio instanceof ReadableStream) return audio;
    if (typeof audio === "string") {
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
      return bytes.buffer;
    }
  }
  throw new Error("Workers AI TTS returned no audio");
}

/** One Cloudflare Calls participant. Frames are processed serially; new speech aborts TTS. */
export class VoiceSession {
  private transcript: Turn[] = [];
  private speaking = false;
  private generation = 0;

  constructor(
    readonly callSid: string,
    readonly callerId: string,
    private readonly ai: VoiceAi,
    private readonly transport: VoiceTransport,
    private readonly config: VoiceAgentConfig,
  ) {}

  /** Called by the Calls audio-track handler after its VAD marks a complete utterance. */
  async receiveAudio(frame: ArrayBuffer, speechDetected = true): Promise<string | null> {
    if (!frame.byteLength) return null;
    if (frame.byteLength > MAX_VOICE_FRAME_BYTES) throw new Error("voice_audio_frame_too_large");
    if (speechDetected && this.speaking) await this.bargeIn();
    const ownGeneration = ++this.generation;
    const stt = await this.ai.run(WHISPER_MODEL, { audio: [...new Uint8Array(frame)] });
    const utterance = textFrom(stt).slice(0, MAX_VOICE_TURN_CHARS);
    if (!utterance) return null;
    this.transcript.push({ role: "caller", text: utterance, at: new Date().toISOString() });
    // Bound retained transcript state and the prompt independently. The transcript remains useful
    // for an operator receipt, while old turns cannot cause unbounded model input or memory use.
    if (this.transcript.length > MAX_VOICE_TRANSCRIPT_TURNS) {
      this.transcript.splice(0, this.transcript.length - MAX_VOICE_TRANSCRIPT_TURNS);
    }
    const prompt = this.transcript.slice(-12).map((t) => `${t.role}: ${t.text}`).join("\n").slice(-MAX_VOICE_PROMPT_CHARS);
    const greeting = this.config.greeting.slice(0, MAX_VOICE_TURN_CHARS);
    const completion = await this.ai.run(VOICE_LLM_MODEL, {
      messages: [
        { role: "system", content: `You are a telephone receptionist. Reply naturally in one or two short spoken sentences. Greeting: ${greeting}` },
        { role: "user", content: prompt },
      ],
      max_tokens: 120,
    });
    if (ownGeneration !== this.generation) return utterance;
    const reply = textFrom(completion);
    if (!reply) throw new Error("Voice model returned an empty response");
    this.transcript.push({ role: "assistant", text: reply, at: new Date().toISOString() });
    if (this.transcript.length > MAX_VOICE_TRANSCRIPT_TURNS) {
      this.transcript.splice(0, this.transcript.length - MAX_VOICE_TRANSCRIPT_TURNS);
    }
    const tts = await this.ai.run(this.config.voiceModel || DEFAULT_TTS_MODEL, { prompt: reply });
    if (ownGeneration !== this.generation) return utterance;
    this.speaking = true;
    try { await this.transport.sendAudio(audioFrom(tts)); }
    finally { if (ownGeneration === this.generation) this.speaking = false; }
    return utterance;
  }

  async bargeIn(): Promise<void> {
    ++this.generation;
    this.speaking = false;
    await this.transport.stopAudio();
  }

  getTranscript(): Turn[] { return this.transcript.map((turn) => ({ ...turn })); }
}
