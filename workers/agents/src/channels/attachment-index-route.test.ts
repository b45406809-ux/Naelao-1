import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "../index.js";

const secret = "attachment-index-secret";
const row = { id: "opaque-id", channel: "email", filename: "scan.pdf", mime_type: "application/pdf", size_bytes: 2048, created_at: "2026-10-15T00:00:00.000Z", expires_at: "2026-11-14T00:00:00.000Z" };

function env(options: { owned?: boolean; attachment?: typeof row; objectBytes?: Uint8Array } = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const attachment = options.attachment ?? row;
  const objectBytes = options.objectBytes;
  return {
    queries,
    value: {
      PLATFORM_SECRET: secret,
      SPACES_WORKER: { fetch: async () => Response.json({
        instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", status: "active" },
        manifest: { channels: [{ kind: "channel", provider: "whatsapp", attachmentAccess: { mode: "read_text" } }] },
      }) },
      PLATFORM_DB: {
        prepare(sql: string) {
          return { bind(...values: unknown[]) {
            queries.push({ sql, values });
            return {
              async all() { return { results: [attachment] }; },
              async first() {
                if (sql.includes("SELECT s.id FROM spaces s WHERE")) return { id: "space-a" };
                return options.owned === false ? null : attachment;
              },
            };
          } };
        },
      },
      ...(objectBytes ? { SCRIPTS_R2: { get: async () => ({ size: objectBytes.byteLength, httpMetadata: { contentType: "text/plain" }, arrayBuffer: async () => objectBytes.buffer }) } } : {}),
    } as never,
  };
}

async function post(path: string, context: ReturnType<typeof env>, body: Record<string, unknown>) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a", ...body }),
  }, context.value);
}

describe("scoped attachment metadata routes", () => {
  it("lists metadata only within the active tenant, Space, and task", async () => {
    const context = env();
    const response = await post("/internal/attachments/list", context, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachments: [row] });
    const attachmentQuery = context.queries.find((query) => query.sql.includes("FROM channel_attachments"));
    expect(attachmentQuery?.sql).toContain("tenant_id=? AND space_id=? AND task_id=? AND expires_at>?");
    expect(attachmentQuery?.values.slice(0, 3)).toEqual(["tenant-a", "space-a", "task-a"]);
  });

  it("inspects metadata without accessing object storage and hides cross-task ids", async () => {
    const context = env();
    const response = await post("/internal/attachments/inspect", context, { id: row.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachment: row });
    const attachmentQuery = context.queries.find((query) => query.sql.includes("FROM channel_attachments"));
    expect(attachmentQuery?.sql).toContain("id=? AND tenant_id=? AND space_id=? AND task_id=? AND expires_at>?");
    expect(attachmentQuery?.values.slice(0, 4)).toEqual([row.id, "tenant-a", "space-a", "task-a"]);

    const foreign = await post("/internal/attachments/inspect", env({ owned: false }), { id: row.id });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error_code: "attachment_not_found" });
  });

  it("lists only exact active-installation message handles and enforces declared bounds", async () => {
    const context = env();
    const response = await post("/internal/attachments/channel-list", context, {
      channel: "whatsapp", projectId: "project-a", installationId: "install-a", providerConnectionId: "connection-a", maxFiles: 2, maxTotalBytes: 3_000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attachments: [{ id: row.id, filename: row.filename, size_bytes: row.size_bytes }] });
    const query = context.queries.find(item => item.sql.includes("FROM channel_attachments"));
    expect(query?.sql).toContain("channel=? AND project_id IS ?");
    expect(query?.sql).toContain("installation_id=? AND provider_connection_id IS ? AND expires_at>?");
    expect(query?.values.slice(0, 7)).toEqual(["tenant-a", "space-a", "task-a", "whatsapp", "project-a", "install-a", "connection-a"]);
    expect(query?.sql).not.toContain("object_key");

    const invalid = await post("/internal/attachments/channel-list", env(), {
      channel: "whatsapp", projectId: "project-a", installationId: "install-a", providerConnectionId: "connection-a", maxFiles: 4,
    });
    expect(invalid.status).toBe(400);

    const staleInstall = await post("/internal/attachments/channel-list", env(), {
      channel: "whatsapp", projectId: "project-a", installationId: "install-b", providerConnectionId: "connection-a",
    });
    expect(staleInstall.status).toBe(403);
    expect(await staleInstall.json()).toMatchObject({ error_code: "channel_attachment_access_not_granted" });
  });

  it("reads text only after the exact binding, installation, message and expiry all match", async () => {
    const bytes = new TextEncoder().encode("order details");
    const context = env({ attachment: { ...row, mime_type: "text/plain", size_bytes: bytes.byteLength }, objectBytes: bytes });
    const response = await post("/internal/attachments/read-text", context, {
      id: row.id,
      extensionScope: { channel: "whatsapp", projectId: "project-a", installationId: "install-a", providerConnectionId: "connection-a" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attachment_id: row.id, mime_type: "text/plain", text: expect.stringContaining("order details") });
    const query = context.queries.find(item => item.sql.includes("FROM channel_attachments"));
    expect(query?.sql).toContain("channel=? AND project_id IS ?");
    expect(query?.sql).toContain("AND installation_id=? AND provider_connection_id IS ?");
    expect(query?.sql).toContain("expires_at>?");

    const staleInstall = await post("/internal/attachments/read-text", env({ attachment: { ...row, mime_type: "text/plain", size_bytes: bytes.byteLength }, objectBytes: bytes }), {
      id: row.id, extensionScope: { channel: "whatsapp", projectId: "project-a", installationId: "install-b", providerConnectionId: "connection-a" },
    });
    expect(staleInstall.status).toBe(403);
  });
});
