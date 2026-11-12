import { describe, expect, it } from "vitest";
import { MAX_MANAGED_ATTACHMENT_DOWNLOAD_BYTES, normalizeManagedServiceAttachment } from "./managed-service-attachments.js";

describe("managed service attachment links", () => {
  it("accepts current provider signed HTTPS links without exposing them as display metadata", () => {
    const attachment = normalizeManagedServiceAttachment({ data: { attachment: {
      filename: "report.pdf", size: 1024, content_type: "application/pdf",
      download_url: "https://files.agentmail.example/download?id=private-signature",
      text_url: "https://files.agentmail.example/text?id=private-signature",
      expires_at: "2026-11-12T10:00:00.000Z",
    } } }, Date.parse("2026-11-12T09:00:00.000Z"));

    expect(attachment).toMatchObject({ filename: "report.pdf", sizeBytes: 1024, contentType: "application/pdf",
      downloadUrl: "https://files.agentmail.example/download?id=private-signature",
      textUrl: "https://files.agentmail.example/text?id=private-signature", expired: false, tooLarge: false });
  });

  it("does not offer expired, non-HTTPS, credential-bearing, or oversized URLs", () => {
    const expired = normalizeManagedServiceAttachment({ filename: "a.txt", size: 1,
      download_url: "https://files.example/a?token=x", expires_at: "2026-11-12T08:00:00.000Z" }, Date.parse("2026-11-12T09:00:00.000Z"));
    expect(expired).toMatchObject({ expired: true, downloadUrl: null });

    for (const url of ["http://files.example/a", "javascript:alert(1)", "https://user:pass@files.example/a"]) {
      const result = normalizeManagedServiceAttachment({ filename: "a.txt", size: 1,
        download_url: url, expires_at: "2026-11-12T10:00:00.000Z" }, Date.parse("2026-11-12T09:00:00.000Z"));
      expect(result?.downloadUrl).toBeNull();
    }

    const oversized = normalizeManagedServiceAttachment({ filename: "large.zip", size: MAX_MANAGED_ATTACHMENT_DOWNLOAD_BYTES + 1,
      download_url: "https://files.example/large?token=x", expires_at: "2026-11-12T10:00:00.000Z" }, Date.parse("2026-11-12T09:00:00.000Z"));
    expect(oversized).toMatchObject({ tooLarge: true, downloadUrl: null });
  });

  it("requires a valid size and expiry before making a signed link available", () => {
    expect(normalizeManagedServiceAttachment({ filename: "a.txt", size: "10",
      download_url: "https://files.example/a?token=x", expires_at: "2026-11-12T10:00:00.000Z" }, Date.parse("2026-11-12T09:00:00.000Z")))
      .toMatchObject({ sizeBytes: null, downloadUrl: null });
    expect(normalizeManagedServiceAttachment(null)).toBeNull();
  });
});
