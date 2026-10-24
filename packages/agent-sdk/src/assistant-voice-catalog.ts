import type { AssistantVoicePreferences, ModelClass } from "@naelao/agent-sdk";

/** Host-reviewed OpenRouter speech catalog. The model and voice IDs are never accepted from an
 * extension or client; selection is by stable profile ID. Keep rates conservative and refresh
 * model availability from OpenRouter before deploying catalog changes. */
export interface ApprovedAssistantVoice {
  id: string;
  name: string;
  modelClass: ModelClass;
  speechModel: string;
  speechVoice: string;
  sampleRate: 16000 | 24000;
  priceUsdPerMillionCharacters: number;
  transcriptionModel: string;
  transcriptionUsdPerSecond: number;
  languages: string[];
}

export const ASSISTANT_VOICE_CATALOG: readonly ApprovedAssistantVoice[] = Object.freeze([
  ...(["eve", "ara", "rex", "sal", "leo"] as const).map((voice) => ({
    id: `economy-${voice}`, name: `Economy · ${voice[0]!.toUpperCase()}${voice.slice(1)}`,
    modelClass: "economy" as const, speechModel: "x-ai/grok-voice-tts-1.0", speechVoice: voice,
    sampleRate: 16000 as const, priceUsdPerMillionCharacters: 15,
    transcriptionModel: "openai/whisper-large-v3-turbo", transcriptionUsdPerSecond: 0.000003,
    languages: ["auto", "en"],
  })),
  ...(["en-US-Harper:MAI-Voice-2.1-Flash", "en-US-Grant:MAI-Voice-2.1-Flash"] as const).map((voice) => ({
    id: `balanced-${voice.includes("Harper") ? "harper" : "grant"}`,
    name: `Balanced · ${voice.split(":")[0]}`,
    modelClass: "balanced" as const, speechModel: "microsoft/mai-voice-2.1-flash", speechVoice: voice,
    sampleRate: 24000 as const, priceUsdPerMillionCharacters: 15,
    transcriptionModel: "openai/whisper-large-v3-turbo", transcriptionUsdPerSecond: 0.000003,
    languages: ["en", "en-US"],
  })),
  ...(["en-US-Harper:MAI-Voice-2.1", "en-US-Grant:MAI-Voice-2.1"] as const).map((voice) => ({
    id: `advanced-${voice.includes("Harper") ? "harper" : "grant"}`,
    name: `Advanced · ${voice.split(":")[0]}`,
    modelClass: "advanced" as const, speechModel: "microsoft/mai-voice-2.1", speechVoice: voice,
    sampleRate: 24000 as const, priceUsdPerMillionCharacters: 22,
    transcriptionModel: "openai/whisper-large-v3-turbo", transcriptionUsdPerSecond: 0.000003,
    languages: ["en", "en-US"],
  })),
]);

export function approvedAssistantVoice(profileId: string | null | undefined, modelClass: ModelClass): ApprovedAssistantVoice | null {
  const selected = profileId ? ASSISTANT_VOICE_CATALOG.find((voice) => voice.id === profileId) : undefined;
  if (selected) return selected.modelClass === modelClass ? selected : null;
  return ASSISTANT_VOICE_CATALOG.find((voice) => voice.modelClass === modelClass) ?? null;
}

export function resolveAssistantVoiceProfile(prefs: AssistantVoicePreferences): ApprovedAssistantVoice | null {
  return approvedAssistantVoice(prefs.voiceProfileId, prefs.modelClass);
}
