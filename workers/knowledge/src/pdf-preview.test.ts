import { describe, expect, it } from "vitest";
import { createKnowledgePdfPreviewToken, sha256BytesHex, verifyKnowledgePdfPreviewToken } from "./pdf-preview.js";

const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a" };
const sourceSha256 = "a".repeat(64);
const extractionSha256 = "b".repeat(64);

describe("Knowledge PDF preview receipt", () => {
  it("binds source bytes, parsed extraction, scope and parser for a bounded approval window", async () => {
    const token = await createKnowledgePdfPreviewToken({ secret: "secret", scope, sourceSha256, extractionSha256, now: 10_000, nonce: "preview-nonce-123456" });
    await expect(verifyKnowledgePdfPreviewToken({ token, secret: "secret", scope, sourceSha256, extractionSha256, now: 10_001 })).resolves.toBe(true);
    await expect(verifyKnowledgePdfPreviewToken({ token, secret: "secret", scope: { ...scope, projectId: null }, sourceSha256, extractionSha256, now: 10_001 })).resolves.toBe(false);
    await expect(verifyKnowledgePdfPreviewToken({ token, secret: "secret", scope, sourceSha256: "c".repeat(64), extractionSha256, now: 10_001 })).resolves.toBe(false);
    await expect(verifyKnowledgePdfPreviewToken({ token, secret: "other-secret", scope, sourceSha256, extractionSha256, now: 10_001 })).resolves.toBe(false);
    await expect(verifyKnowledgePdfPreviewToken({ token, secret: "secret", scope, sourceSha256, extractionSha256, now: 910_001 })).resolves.toBe(false);
  });

  it("hashes the selected original PDF bytes rather than a text encoding", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
    await expect(sha256BytesHex(bytes)).resolves.toBe("a478fc587766bd2eafb37c5c0c2d481744812be8ad63a539b70c6be1e77f1145");
  });
});
