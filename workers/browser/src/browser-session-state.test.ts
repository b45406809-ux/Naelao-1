import { describe, expect, it, vi } from "vitest";
import type { BrowserRuntimeScope } from "@naelao/agent-sdk";
import {
  uploadScreenshotWithCleanupIntent,
  type BrowserSessionRecord,
  type BrowserStateStorage,
} from "./browser-session-state.js";

class MemoryStorage implements BrowserStateStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async transaction<T>(callback: (storage: Pick<BrowserStateStorage, "get" | "put">) => Promise<T>) {
    return callback(this);
  }
}

const scope: BrowserRuntimeScope = {
  tenantId: "tenant-a", spaceId: "space-a", actorId: "member-a", agentId: "agent-a",
  runId: "run-a", sessionId: "session-a", expiresAt: Date.now() + 60_000,
  authorizedOrigins: ["https://example.com"], authorizedActions: [], maxTier: 5,
};
function session(): BrowserSessionRecord {
  return { scope, status: "open", engine: "chromium", url: "https://example.com", actions: 0, screenshots: [], lastUsedAt: Date.now() };
}

describe("browser screenshot cleanup intent", () => {
  it("durably records the R2 path before upload begins", async () => {
    const storage = new MemoryStorage();
    const record = session();
    await storage.put("browser-session", record);
    const upload = vi.fn(async () => {
      expect((await storage.get<BrowserSessionRecord>("browser-session"))?.screenshots).toEqual([".perception/shot.png"]);
    });

    await uploadScreenshotWithCleanupIntent(storage, record, ".perception/shot.png", upload, async () => undefined);

    expect(upload).toHaveBeenCalledOnce();
    expect(record.screenshots).toEqual([".perception/shot.png"]);
    expect((await storage.get<BrowserSessionRecord>("browser-session"))?.screenshots).toEqual([".perception/shot.png"]);
  });

  it("removes the tracked path when a failed upload is successfully cleaned up", async () => {
    const storage = new MemoryStorage();
    const record = session();
    await storage.put("browser-session", record);
    const bytes = new Map<string, Uint8Array>();
    const upload = vi.fn(async () => { bytes.set(".perception/shot.png", new Uint8Array([1, 2, 3])); throw new Error("upload interrupted"); });
    const remove = vi.fn(async () => { bytes.delete(".perception/shot.png"); });

    await expect(uploadScreenshotWithCleanupIntent(storage, record, ".perception/shot.png", upload, remove)).rejects.toThrow("upload interrupted");

    expect(bytes.has(".perception/shot.png")).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect((await storage.get<BrowserSessionRecord>("browser-session"))?.screenshots).toEqual([]);
  });

  it("keeps the cleanup intent when R2 deletion fails so the session alarm can retry", async () => {
    const storage = new MemoryStorage();
    const record = session();
    await storage.put("browser-session", record);

    await expect(uploadScreenshotWithCleanupIntent(
      storage,
      record,
      ".perception/shot.png",
      async () => { throw new Error("upload interrupted"); },
      async () => { throw new Error("R2 unavailable"); },
    )).rejects.toThrow("upload interrupted");

    expect((await storage.get<BrowserSessionRecord>("browser-session"))?.screenshots).toEqual([".perception/shot.png"]);
  });
});
