import { describe, expect, it } from "vitest";
import { indexChatUploads } from "./chat-upload-attachments.js";

describe("chat upload attachment indexing", () => {
  it("copies exact project-session uploads into task-scoped opaque storage", async () => {
    const sourceKey = "spaces/s/projects/p/workspace/uploads/thread-1/brief.txt";
    const source = new TextEncoder().encode("private attachment");
    const objects = new Map<string, Uint8Array>([[sourceKey, source]]);
    const rows = new Map<string, { id: string }>();
    const statements: string[] = [];
    const db = { prepare(sql: string) { statements.push(sql); return { bind(...values: unknown[]) { return {
      async first<T>() { return rows.get(String(values[0])) as T | undefined ?? null; },
      async run() { if (sql.includes("INSERT OR IGNORE INTO channel_attachments")) rows.set(String(values[0]), { id: String(values[0]) }); return {}; },
    }; } }; } };
    const bucket = {
      async get(key: string) { const bytes = objects.get(key); return bytes ? { key, size: bytes.byteLength,
        httpMetadata: { contentType: "text/plain" }, async arrayBuffer() { return bytes.slice().buffer; } } : null; },
      async put(key: string, bytes: Uint8Array) { objects.set(key, bytes.slice()); },
    };
    const result = await indexChatUploads({ bucket, db, platformSecret: "test-secret", tenantId: "t", spaceId: "s",
      sessionId: "thread-1", projectId: "p", taskId: "run-1", names: ["brief.txt"] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ filename: "brief.txt", mimeType: "text/plain", sizeBytes: source.length });
    expect(result[0]?.id).toMatch(/^ca_[a-f0-9]{40}$/);
    expect([...objects.keys()].some(key => key.includes("channel-inbound/run-1"))).toBe(true);
    expect(statements.some(sql => sql.includes("channel_attachments"))).toBe(true);
    expect(await indexChatUploads({ bucket, db, platformSecret: "test-secret", tenantId: "t", spaceId: "s",
      sessionId: "thread-1", projectId: "p", taskId: "run-1", names: ["brief.txt"] })).toEqual(result);
  });

  it("rejects traversal, missing uploads, and overlarge files without widening the source prefix", async () => {
    const bucket = { async get(key: string) { return key.endsWith("big.bin") ? { key, size: 20 * 1024 * 1024 + 1,
      httpMetadata: {}, async arrayBuffer() { return new ArrayBuffer(0); } } : null; }, async put() {} };
    const db = { prepare() { return { bind() { return { async first() { return null; }, async run() { return {}; } }; } }; } };
    const base = { bucket, db, platformSecret: "test-secret", tenantId: "t", spaceId: "s", sessionId: "sess", taskId: "task" };
    await expect(indexChatUploads({ ...base, names: ["../secret"] })).rejects.toThrow("chat_attachment_name_invalid");
    await expect(indexChatUploads({ ...base, names: ["missing.txt"] })).rejects.toThrow("chat_attachment_not_found");
    await expect(indexChatUploads({ ...base, names: ["big.bin"] })).rejects.toThrow("chat_attachment_size_limit");
  });
});
