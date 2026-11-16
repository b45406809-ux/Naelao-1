import { describe, expect, it } from "vitest";
import { createWebsitePreviewToken, sha256TextHex, verifyWebsitePreviewToken } from "./website-source-preview.js";

const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", userId: "owner", connectionId: "connection" };
const requestedUrl = "https://example.com/docs";
const finalUrl = "https://example.com/docs/current";

describe("owner-approved website preview receipt", () => {
  it("binds exact source, scope, owner, connection and preview for fifteen minutes", async () => {
    const previewSha256 = await sha256TextHex("# Approved guide");
    const token = await createWebsitePreviewToken({ secret: "secret", scope, requestedUrl, finalUrl, previewSha256, now: 10_000, nonce: "website-preview-nonce-123" });
    const input = { token, secret: "secret", scope, requestedUrl, finalUrl, previewSha256, now: 10_001 };
    await expect(verifyWebsitePreviewToken(input)).resolves.toBe(true);
    await expect(verifyWebsitePreviewToken({ ...input, scope: { ...scope, userId: "other" } })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, scope: { ...scope, connectionId: "other" } })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, finalUrl: requestedUrl })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, previewSha256: "a".repeat(64) })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, now: 910_001 })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, secret: "other" })).resolves.toBe(false);
  });

  it("binds a refresh receipt to the source document, revision and durable refresh operation", async () => {
    const previewSha256 = await sha256TextHex("# Updated guide");
    const token = await createWebsitePreviewToken({ secret: "secret", scope, requestedUrl, finalUrl, previewSha256,
      operation: "refresh", documentId: "document-1", sourceRevision: 8, refreshOperationId: "refresh-1",
      now: 10_000, nonce: "website-refresh-nonce-123" });
    const input = { token, secret: "secret", scope, requestedUrl, finalUrl, previewSha256, operation: "refresh" as const,
      documentId: "document-1", sourceRevision: 8, refreshOperationId: "refresh-1", now: 10_001 };
    await expect(verifyWebsitePreviewToken(input)).resolves.toBe(true);
    await expect(verifyWebsitePreviewToken({ ...input, sourceRevision: 7 })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, refreshOperationId: "refresh-2" })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, documentId: "document-2" })).resolves.toBe(false);
    await expect(verifyWebsitePreviewToken({ ...input, operation: "create" })).resolves.toBe(false);
  });
});
