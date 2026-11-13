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
    const insert = state.queries.find(query => query.sql.includes("INSERT OR IGNORE INTO channel_attachments"));
    expect(insert?.values[9]).toBe(new Date(input.now).toISOString());
    expect(insert?.values[10]).toBe(new Date(input.now + 30 * 24 * 60 * 60 * 1000).toISOString());
  });

  it("infers a known filename extension for generic provider MIME while preserving explicit MIME", async () => {
    const state = setup();
    const input = { ...state, platformSecret: "secret", tenantId: "tenant-a", spaceId: "space-a", taskId: "task", channel: "email" };
    const [inferred] = await storeChannelAttachments({ ...input, files: [{ ...file, mimeType: "application/octet-stream" }] });
    expect(inferred).toMatchObject({ filename: "_invoice.pdf", mimeType: "application/pdf" });
    expect(state.bucket.put.mock.calls[0]?.[2]).toMatchObject({ httpMetadata: { contentType: "application/pdf" } });

    const [explicit] = await storeChannelAttachments({ ...input, indexOffset: 1, files: [{ ...file, mimeType: "application/x-provider-recorded" }] });
    expect(explicit?.mimeType).toBe("application/x-provider-recorded");
  });

  it("binds opted-in channel attachments to one project, installation, and provider connection", async () => {
    const state = setup();
    const input = { ...state, platformSecret: "secret", tenantId: "tenant-a", spaceId: "space-a", taskId: "provider-event", channel: "whatsapp", files: [file], now: 1_800_000_000_000 };
    const first = await storeChannelAttachments({ ...input, extensionScope: { projectId: "project-a", installationId: "install-a", providerConnectionId: "connection-a" } });
    const otherInstall = await storeChannelAttachments({ ...input, extensionScope: { projectId: "project-a", installationId: "install-b", providerConnectionId: "connection-a" } });
    expect(first[0]?.id).not.toBe(otherInstall[0]?.id);
    const rows = state.queries.filter(query => query.sql.includes("INSERT OR IGNORE INTO channel_attachments"));
    expect(rows[0]?.sql).toContain("project_id, installation_id, provider_connection_id");
    expect(rows[0]?.values.slice(-3)).toEqual(["project-a", "install-a", "connection-a"]);
    expect(rows[1]?.values.slice(-3)).toEqual(["project-a", "install-b", "connection-a"]);
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
