import { describe, expect, it } from "vitest";
import { attachmentToolsForRun } from "./attachment-capabilities.js";

describe("attachment classification capability hints", () => {
  it("does not advertise tools missing from the active agent", () => {
    expect(attachmentToolsForRun(["knowledge-base"], false)).toEqual([]);
  });

  it("advertises installed operations and omits hosted transcription in air-gapped placement", () => {
    expect(attachmentToolsForRun(["attachments"], true)).toEqual([
      "attachment.inspect", "attachment.read", "attachment.copy",
    ]);
    expect(attachmentToolsForRun(["attachments"], false)).toContain("attachment.transcribe");
    expect(attachmentToolsForRun(["attachments"], false)).toContain("attachment.describe");
  });

  it("classifies customer-message attachments with only customer-safe operations", () => {
    expect(attachmentToolsForRun(["customer-attachments"], false)).toEqual([
      "attachment.inspect", "attachment.read", "attachment.ocr", "attachment.describe", "attachment.transcribe",
    ]);
    expect(attachmentToolsForRun(["customer-attachments"], true)).toEqual(["attachment.inspect", "attachment.read"]);
    expect(attachmentToolsForRun(["attachments", "customer-attachments"], false)).not.toContain("attachment.copy");
  });
});
