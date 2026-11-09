import { describe, expect, it, vi } from "vitest";
import { fileManager } from "./file-manager.js";
import type { PrebuiltOpContext } from "./index.js";

const run = async () => undefined;

describe("file-manager coordinator history", () => {
  it("returns bounded versions newest first with revision identity", async () => {
    const workspaceHistoryRead = vi.fn(async () => ({
      branch: "workers/child", path: "notes.txt", headRevision: 8, cursor: 8, hasMore: false, resetRequired: false,
      versions: [
        { revision: 6, updatedAt: "2026-11-08T00:00:00.000Z", sha256: "a".repeat(64), size: 5, deleted: false },
        { revision: 8, updatedAt: "2026-11-09T00:00:00.000Z", sha256: "b".repeat(64), size: 6, deleted: false },
      ],
    }));
    const ctx = { env: { spaceId: "space", projectId: "project", workspaceBranch: "workers/child", workspaceHistoryRead }, run } as unknown as PrebuiltOpContext;
    const result = await fileManager.operations["file.history"]!({ path: "notes.txt", limit: 20 }, ctx) as { available: boolean; branch: string; versions: Array<{ revision: number }> };
    expect(workspaceHistoryRead).toHaveBeenCalledWith({ path: "notes.txt", limit: 20 });
    expect(result).toMatchObject({ available: true, branch: "workers/child", versions: [{ revision: 8 }, { revision: 6 }] });
  });

  it("restores retained bytes through the checked writer with expected hash and MIME", async () => {
    const bytes = new TextEncoder().encode("restored");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sourceHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    const workspaceRevisionRead = vi.fn(async () => ({ revision: 3, sha256: sourceHash, bytes, contentType: "text/markdown; charset=utf-8", deleted: false }));
    const publishWorkspaceChecked = vi.fn(async () => ({ hash: "b".repeat(64), revision: 9, deleted: false }));
    const workspaceBucket = {} as R2Bucket;
    const ctx = { env: {
      spaceId: "space", projectId: "project", workspaceBranch: "workers/child", workspaceBucket,
      workspaceRevisionRead, workspaceManifestRead: async () => ({}), publishWorkspaceChecked,
    }, run } as unknown as PrebuiltOpContext;
    const result = await fileManager.operations["file.restore"]!({ path: "notes.md", revision: 3, expectedHash: "c".repeat(64) }, ctx) as Record<string, unknown>;
    expect(workspaceRevisionRead).toHaveBeenCalledWith({ path: "notes.md", revision: 3 });
    expect(publishWorkspaceChecked).toHaveBeenCalledWith({ key: "spaces/space/projects/project/workspace/branches/workers/child/notes.md", bytes, expectedHash: "c".repeat(64), contentType: "text/markdown; charset=utf-8" });
    expect(result).toMatchObject({ ok: true, restoredFromRevision: 3, revision: 9, branch: "workers/child", deleted: false, hash: "b".repeat(64) });
  });
});
