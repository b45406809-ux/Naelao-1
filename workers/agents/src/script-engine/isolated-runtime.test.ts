import { describe, expect, it } from "vitest";
import { channelSerializedEventLimit } from "./isolated-runtime.js";

describe("channel image input bounds", () => {
  it("keeps ordinary channel events at the existing small limit", () => {
    expect(channelSerializedEventLimit({ event: { payload: { text: "hello", attachments: [] } } })).toBe(32_768);
    expect(channelSerializedEventLimit({ event: { payload: { text: "hello" } } })).toBe(32_768);
  });

  it("allows one canonical, bounded image payload through the larger event limit", () => {
    expect(channelSerializedEventLimit({ event: { payload: { attachments: [
      { mimeType: "image/png", sizeBytes: 3, image_base64: "AAAA" },
    ] } } })).toBe(768 * 1024);
  });

  it("does not enlarge input for malformed, unsupported or multiple images", () => {
    const attachment = { mimeType: "image/png", sizeBytes: 3, image_base64: "AAAA" };
    expect(channelSerializedEventLimit({ event: { payload: { attachments: [{ ...attachment, image_base64: "not base64" }] } } })).toBe(32_768);
    expect(channelSerializedEventLimit({ event: { payload: { attachments: [{ ...attachment, sizeBytes: 4 }] } } })).toBe(32_768);
    expect(channelSerializedEventLimit({ event: { payload: { attachments: [{ ...attachment, mimeType: "application/pdf" }] } } })).toBe(32_768);
    expect(channelSerializedEventLimit({ event: { payload: { attachments: [attachment, attachment] } } })).toBe(32_768);
  });
});
