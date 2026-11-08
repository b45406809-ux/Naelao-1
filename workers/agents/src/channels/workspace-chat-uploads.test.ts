import { describe, expect, it, vi } from "vitest";
import { MAX_COORDINATOR_UPLOAD_BYTES, publishProjectChatUpload } from "./workspace-chat-uploads.js";

const scope = { tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1", jurisdiction: "global" as const };
const emptySnapshot = { head: { branch: "main", revision: 4 }, entries: [] };

describe("checked project chat uploads", () => {
  it("publishes with the observed manifest hash and a stable idempotency key", async () => {
    const bytes = new TextEncoder().encode("session upload");
    const publish = vi.fn(async () => ({ status: "published" as const, revision: 5 }));
    const input = {
      scope, sessionId: "session-1", filename: "brief.txt", actorId: "user-1", bytes,
      readSnapshot: async () => emptySnapshot, publish,
    };
    const first = await publishProjectChatUpload(input);
    const second = await publishProjectChatUpload(input);
    expect(first).toMatchObject({ path: "uploads/session-1/brief.txt", revision: 5, deleted: false });
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ branch: "main", expectedHash: null, bytes });
    expect(publish.mock.calls[1]?.[0].idempotencyKey).toBe(publish.mock.calls[0]?.[0].idempotencyKey);
  });

  it("deletes with the manifest's current expected hash", async () => {
    const expectedHash = "a".repeat(64);
    let received: { expectedHash: string | null } | undefined;
    const result = await publishProjectChatUpload({
      scope, sessionId: "session-1", filename: "brief.txt", actorId: "user-1", bytes: null,
      readSnapshot: async () => ({ head: { branch: "main", revision: 9 }, entries: [{ path: "uploads/session-1/brief.txt", sha256: expectedHash, size: 10 }] }),
      publish: async change => { received = change; return { status: "published", revision: 10 }; },
    });
    expect(received?.expectedHash).toBe(expectedHash);
    expect(result).toMatchObject({ deleted: true, hash: null, revision: 10 });
  });

  it("rejects oversized files before reading or publishing", async () => {
    const readSnapshot = vi.fn(async () => emptySnapshot);
    const publish = vi.fn(async () => ({ status: "published" as const, revision: 5 }));
    await expect(publishProjectChatUpload({
      scope, sessionId: "session-1", filename: "oversized.bin", actorId: "user-1",
      bytes: new Uint8Array(MAX_COORDINATOR_UPLOAD_BYTES + 1), readSnapshot, publish,
    })).rejects.toThrow("chat_upload_coordinator_file_limit");
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
