import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

const SECRET = "product-user-chat-export-test-secret";

async function makeSpace() {
  const storage = createDOStorage();
  const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: SECRET } as never);
  await space.fetch(new Request("http://space/extension-releases?limit=1"));
  return { space, storage };
}

async function exportRequest(space: SpaceDO, userId = "user-a", token: string | undefined = undefined, params = "tenant_id=tenant-a&space_id=space-a") {
  const request = new Request(`http://space/product-user-chat-history-export?${params}`, {
    headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": userId,
      ...(token ? { "x-naelao-internal-token": token } : {}) },
  });
  return space.fetch(request);
}

function insertSession(sql: ReturnType<typeof createDOStorage>["sql"], id: string, tenantId: string, spaceId: string, userId: string) {
  sql.exec("INSERT INTO sessions (id,space_id,tenant_id,end_user_id) VALUES(?,?,?,?)", id, spaceId, tenantId, userId);
}

function insertMessage(sql: ReturnType<typeof createDOStorage>["sql"], id: string, sessionId: string, content: string) {
  sql.exec("INSERT INTO messages (id,session_id,role,content) VALUES(?,?,?,?)", id, sessionId, "user", content);
}

describe("product-user chat portability export", () => {
  it("exports only messages owned by the verified user in the exact tenant and Space", async () => {
    const { space, storage } = await makeSpace();
    insertSession(storage.sql, "owned-session", "tenant-a", "space-a", "user-a");
    insertSession(storage.sql, "sibling-session", "tenant-a", "space-a", "user-b");
    insertSession(storage.sql, "other-tenant-session", "tenant-b", "space-a", "user-a");
    insertSession(storage.sql, "other-space-session", "tenant-a", "space-b", "user-a");
    insertMessage(storage.sql, "owned-message", "owned-session", "my private conversation");
    insertMessage(storage.sql, "sibling-message", "sibling-session", "sibling private conversation");
    insertMessage(storage.sql, "other-tenant-message", "other-tenant-session", "other tenant conversation");
    insertMessage(storage.sql, "other-space-message", "other-space-session", "other Space conversation");

    const token = await mintInternalToken(SECRET, "tenant-a");
    const response = await exportRequest(space, "user-a", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      space_id: "space-a",
      sessions: ["owned-session"],
      messages: [{ id: "owned-message", session_id: "owned-session", content: "my private conversation" }],
    });
  });

  it("requires the internal tenant token and rejects an oversized complete transcript", async () => {
    const { space, storage } = await makeSpace();
    const denied = await exportRequest(space);
    expect(denied.status).toBe(403);

    insertSession(storage.sql, "large-session", "tenant-a", "space-a", "user-a");
    insertMessage(storage.sql, "large-message", "large-session", "x".repeat(4 * 1024 * 1024 + 1));
    const token = await mintInternalToken(SECRET, "tenant-a");
    const response = await exportRequest(space, "user-a", token);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "product_user_chat_export_limit_exceeded" });
  });

  it("rejects a request whose route parameters contradict the authenticated tenant", async () => {
    const { space } = await makeSpace();
    const token = await mintInternalToken(SECRET, "tenant-a");
    const response = await exportRequest(space, "user-a", token, "tenant_id=tenant-b&space_id=space-a");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "product_user_chat_export_scope_invalid" });
  });
});
