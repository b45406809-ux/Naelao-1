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
});
