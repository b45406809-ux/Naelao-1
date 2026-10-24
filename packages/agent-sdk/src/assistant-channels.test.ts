import { describe, it, expect } from "vitest";
import {
  resolveAssistantChannels,
  validateAssistantChannelDefaults,
} from "./assistant-channels.js";
import { instantiateBlueprint } from "./blueprint.js";
describe("assistant channel defaults", () => {
  it("gives both assistants email and keeps phone optional", () => {
    expect(resolveAssistantChannels("space_assistant").enabled).toEqual({
      chat: true,
      email: true,
      whatsapp: true,
      telegram: true,
      slack: true,
      discord: true,
      phone: false,
    });
    expect(resolveAssistantChannels("project_assistant").enabled).toEqual({
      chat: true,
      email: true,
      whatsapp: false,
      telegram: false,
      slack: false,
      discord: false,
      phone: false,
    });
  });
  it("applies explicit settings over template defaults without mutating them", () => {
    const defaults = { enabled: { email: false, phone: true } };
    expect(
      resolveAssistantChannels("space_assistant", defaults, {
        enabled: { email: true, phone: false },
      }).enabled
    ).toMatchObject({ email: true, phone: false });
    expect(defaults.enabled.email).toBe(false);
  });
  it("rejects capability or credential injection into templates", () => {
    expect(() =>
      validateAssistantChannelDefaults({
        spaceAssistant: { enabled: { email: "true" } },
      })
    ).toThrow();
    expect(() =>
      validateAssistantChannelDefaults({
        projectAssistants: { purchasePhone: true },
      })
    ).toThrow();
  });
  it("preserves validated channel defaults in detached blueprint copies", () => {
    const bp = {
      id: "template",
      schemaVersion: "2.0" as const,
      metadata: {},
      templateCategory: "general",
      projects: [],
      requiredExtensions: [],
      requiredCredentials: [],
      assistantChannels: {
        projectAssistants: {
          phonePrompt: "recommended" as const,
          enabled: { phone: true },
        },
      },
    };
    const copy = instantiateBlueprint(bp, "space");
    expect(copy.assistantChannels).toEqual(bp.assistantChannels);
    copy.assistantChannels!.projectAssistants!.enabled!.phone = false;
    expect(bp.assistantChannels.projectAssistants.enabled.phone).toBe(true);
  });
});
