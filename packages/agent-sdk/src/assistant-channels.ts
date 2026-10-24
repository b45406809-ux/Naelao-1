/** Channel availability is a preference, never an account connection or spending grant. */
export const ASSISTANT_CHANNELS = [
  "chat",
  "email",
  "whatsapp",
  "telegram",
  "slack",
  "discord",
  "phone",
] as const;
export type AssistantChannel = (typeof ASSISTANT_CHANNELS)[number];
export type AssistantKind = "space_assistant" | "project_assistant";
export interface AssistantChannelPreferences {
  enabled: Record<AssistantChannel, boolean>;
  phonePrompt: "optional" | "recommended" | "required";
}
export interface AssistantChannelPatch {
  enabled?: Partial<Record<AssistantChannel, boolean>>;
  phonePrompt?: AssistantChannelPreferences["phonePrompt"];
}
export interface AssistantChannelTemplateDefaults {
  spaceAssistant?: AssistantChannelPatch;
  projectAssistants?: AssistantChannelPatch;
}
export function validateAssistantChannelPatch(
  value: unknown
): AssistantChannelPatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_assistant_channel_preferences");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["enabled", "phonePrompt"].includes(key)))
    throw new Error("unknown_assistant_channel_preference");
  const result: AssistantChannelPatch = {};
  if (raw.enabled !== undefined) {
    if (
      !raw.enabled ||
      typeof raw.enabled !== "object" ||
      Array.isArray(raw.enabled)
    )
      throw new Error("invalid_assistant_channels");
    result.enabled = {};
    for (const [key, enabled] of Object.entries(raw.enabled)) {
      if (
        !(ASSISTANT_CHANNELS as readonly string[]).includes(key) ||
        typeof enabled !== "boolean"
      )
        throw new Error("invalid_assistant_channel");
      result.enabled[key as AssistantChannel] = enabled;
    }
  }
  if (raw.phonePrompt !== undefined) {
    if (
      !["optional", "recommended", "required"].includes(String(raw.phonePrompt))
    )
      throw new Error("invalid_phone_prompt");
    result.phonePrompt =
      raw.phonePrompt as AssistantChannelPreferences["phonePrompt"];
  }
  return result;
}
export function validateAssistantChannelDefaults(
  value: unknown
): AssistantChannelTemplateDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_assistant_channel_defaults");
  const result: AssistantChannelTemplateDefaults = {};
  for (const [key, patch] of Object.entries(value)) {
    if (key !== "spaceAssistant" && key !== "projectAssistants")
      throw new Error("unknown_assistant_channel_scope");
    result[key] = validateAssistantChannelPatch(patch);
  }
  return result;
}
export function resolveAssistantChannels(
  kind: AssistantKind,
  ...layers: Array<AssistantChannelPatch | undefined>
): AssistantChannelPreferences {
  const space = kind === "space_assistant";
  const result: AssistantChannelPreferences = {
    enabled: {
      chat: true,
      email: true,
      whatsapp: space,
      telegram: space,
      slack: space,
      discord: space,
      phone: false,
    },
    phonePrompt: "optional",
  };
  for (const patch of layers)
    if (patch) {
      const checked = validateAssistantChannelPatch(patch);
      Object.assign(result.enabled, checked.enabled);
      if (checked.phonePrompt) result.phonePrompt = checked.phonePrompt;
    }
  return result;
}
