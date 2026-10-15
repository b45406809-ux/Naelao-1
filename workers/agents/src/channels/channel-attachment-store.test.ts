import { describe, expect, it, vi } from "vitest";
import { storeChannelAttachments } from "./channel-attachment-store.js";

function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) {
        queries.push({ sql, values });
        return {
          async first() { return rows.get(String(values[0])) ?? null; },
          async run() { if (sql.startsWith("INSERT OR IGNORE INTO channel_attachments")) rows.set(String(values[0]), { id: values[0] }); return {}; },
        };
      }};
    },
  };
  const bucket = { put: vi.fn(async () => undefined) };
  return { db, bucket, rows, queries };
}

const file = { filename: "../invoice.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4]) };

describe("scoped channel attachment storage", () => {
  it("stores sanitized files under private keys and returns retry-stable opaque IDs", async () => {
    const state = setup();
    const input = { ...state, platformSecret: "secret", tenantId: "tenant-a", spaceId: "space-a", taskId: "event/1", channel: "telegram", files: [file], now: 1_800_000_000_000 };
    const first = await storeChannelAttachments(input);
    const replay = await storeChannelAttachments(input);
    expect(first).toEqual([{ id: expect.stringMatching(/^ca_[a-f0-9]{40}$/), filename: "_invoice.pdf", mimeType: "application/pdf", sizeBytes: 4 }]);
    expect(replay).toEqual(first);
    expect(state.bucket.put).toHaveBeenCalledOnce();
    expect(state.bucket.put.mock.calls[0]?.[0]).toContain("spaces/space-a/channel-inbound/event_1/");
    expect(state.queries[0]?.values.slice(1, 4)).toEqual(["tenant-a", "space-a", "event/1"]);
  });

  it("rejects zero-byte, oversized, and excessive attachment sets before object storage", async () => {
    const state = setup();
    const input = { ...state, platformSecret: "secret", tenantId: "tenant-a", spaceId: "space-a", taskId: "task", channel: "discord" };
    await expect(storeChannelAttachments({ ...input, files: [{ ...file, bytes: new Uint8Array() }] })).rejects.toThrow("channel_attachment_size_limit");
    await expect(storeChannelAttachments({ ...input, files: [{ ...file, bytes: new Uint8Array(5 * 1024 * 1024 + 1) }] })).rejects.toThrow("channel_attachment_size_limit");
    await expect(storeChannelAttachments({ ...input, files: Array(11).fill(file) })).rejects.toThrow("channel_attachment_count_limit");
    expect(state.bucket.put).not.toHaveBeenCalled();
  });
});
