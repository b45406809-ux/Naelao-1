import { describe, expect, it, vi } from "vitest";
import { createAssistantVoiceClient, resolveAssistantVoice, validateAssistantVoicePatch } from "./assistant-voice.js";
describe("assistant voice policy", () => {
  it("prevents Projects from enabling Space-disabled features or raising budgets", () => {
    const p = resolveAssistantVoice({ maxCallMinutes: 10, maxCallCostUsd: 1 }, { enabled: true, customVoicesEnabled: true, maxCallMinutes: 240, maxCallCostUsd: 100 });
    expect(p).toMatchObject({ enabled: false, customVoicesEnabled: false, maxCallMinutes: 10, maxCallCostUsd: 1 });
  });
  it("honors disabled Project overrides", () => {
    expect(resolveAssistantVoice({ language: "en", allowProjectOverrides: false }, { language: "fr" }).language).toBe("en");
  });
  it.each([{ speed: NaN }, { speed: 100 }, { enabled: "true" }, { maxCallCostUsd: -1 }, { modelClass: "admin" }, { providerKey: "secret" }, { language: "../../" }])("rejects malformed settings %j", p => expect(() => validateAssistantVoicePatch(p)).toThrow());
  it("denies SDK calls before egress when capability is missing", async () => {
    const request = vi.fn();
    const client = createAssistantVoiceClient({ spaceId: "s", capabilities: [], request });
    await expect(client.getPreferences()).rejects.toThrow("voice_capability_denied");
    expect(request).not.toHaveBeenCalled();
  });
});
