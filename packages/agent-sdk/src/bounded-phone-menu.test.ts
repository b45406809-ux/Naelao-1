import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import manifest from "../examples/bounded-phone-menu/manifest.json";
import { run } from "../examples/bounded-phone-menu/handler.js";
import { validateExtensionManifest } from "./extensions.js";
import { validateVoiceChannelResponse } from "./voice-channel.js";

const settings = {
  greeting: "Welcome.", option_1_label: "Bookings", option_1_response: "Our booking team will help you.",
  option_2_label: "Support", option_2_response: "Our support team will help you.",
  fallback_response: "That key is not available.",
};
const dashboard = readFileSync(new URL("../examples/bounded-phone-menu/dashboard.html", import.meta.url), "utf8");

async function responseFor(voiceEvent: string, digits?: string) {
  let raw = "";
  await run({}, { channel: {
    event: { payload: { voice_event: voiceEvent, ...(digits ? { digits } : {}) } },
    settings: { values: settings },
    reply: async message => { raw = message.text; return { messageId: "test" }; },
  } });
  return validateVoiceChannelResponse(JSON.parse(raw));
}

describe("bounded phone menu package", () => {
  it("declares signed per-installation settings and only the host-supported phone channel", () => {
    const parsed = validateExtensionManifest(manifest);
    expect(parsed.id).toBe("ext_bounded_phone_menu");
    expect(parsed.settingsSchema?.fields).toHaveLength(6);
    expect(parsed.channels).toEqual([expect.objectContaining({
      provider: "phone", handlerScript: "./handler.ts", context: "channel_only",
      inboundEvents: ["message.received", "call.received", "call.digits"], outboundEvents: ["message.reply", "voice.reply"],
    })]);
    expect(parsed.capabilityRequirements).toEqual(["extension.settings.read", "extension.settings.configure"]);
    expect(dashboard).toContain("Preview current settings");
    expect(dashboard).toContain("aria-label=\"Simulated keypad menu response\"");
    expect(dashboard).toContain("does not run a carrier call, contact a provider, publish this draft, or save a call session");
  });

  it("previews the same bounded responses as the package handler without provider execution", async () => {
    const previewFunction = dashboard.match(/      function previewMenuResponse\([\s\S]*?\n      \}/)?.[0];
    expect(previewFunction).toBeDefined();
    const preview = new Function(`${previewFunction}; return previewMenuResponse;`)() as
      (event: string, digits: string, values: typeof settings) => unknown;
    for (const [event, digits] of [["call.received", ""], ["call.digits", "1"], ["call.digits", "2"], ["call.digits", "9"]]) {
      expect(preview(event!, digits!, settings)).toEqual(await responseFor(event!, digits! || undefined));
    }
  });

  it("gathers one DTMF digit and returns only configured, bounded responses", async () => {
    expect(await responseFor("call.received")).toEqual({ schema_version: 1, actions: [
      { type: "gather", input: "dtmf", digits: 1, text: "Welcome. Press 1 for Bookings. Press 2 for Support." },
    ] });
    expect(await responseFor("call.digits", "1")).toEqual({ schema_version: 1, actions: [
      { type: "say", text: "Our booking team will help you." }, { type: "hangup" },
    ] });
    expect(await responseFor("call.digits", "2")).toEqual({ schema_version: 1, actions: [
      { type: "say", text: "Our support team will help you." }, { type: "hangup" },
    ] });
    expect(await responseFor("call.digits", "9")).toEqual({ schema_version: 1, actions: [
      { type: "say", text: "That key is not available." }, { type: "hangup" },
    ] });
  });

  it("does not gather speech and tolerates a missing settings snapshot", async () => {
    const response = await responseFor("call.received");
    expect(response?.actions).not.toContainEqual(expect.objectContaining({ input: "speech" }));
    let raw = "";
    await run({}, { channel: { event: { payload: { voice_event: "call.received" } }, reply: async message => { raw = message.text; return {}; } } });
    expect(validateVoiceChannelResponse(JSON.parse(raw))?.actions[0]).toMatchObject({ input: "dtmf", digits: 1 });
  });
});
