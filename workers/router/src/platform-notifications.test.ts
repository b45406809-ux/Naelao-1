import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { listPlatformNotifications, markPlatformNotificationRead } from "./platform-notifications.js";

function fixture() {
  const database = createFakeD1([
    `CREATE TABLE notifications (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, action_url TEXT, created_at TEXT NOT NULL
    )`,
    "CREATE INDEX idx_notifications_tenant_user ON notifications(tenant_id,user_id,created_at DESC)",
    `INSERT INTO notifications VALUES
      ('notice-a','tenant-a','user-a','billing','Newest unread','Body',NULL,NULL,'2026-11-15 12:00:00'),
      ('notice-b','tenant-a','user-a','system','Older unread','Body',NULL,NULL,'2026-11-15 12:00:00'),
      ('notice-c','tenant-a','user-a','email','Read notice','Body','2026-11-14 09:00:00',NULL,'2026-11-14 09:00:00'),
      ('notice-other-user','tenant-a','user-b','billing','Other user','Secret',NULL,NULL,'2026-11-15 13:00:00'),
      ('notice-other-tenant','tenant-b','user-a','billing','Other tenant','Secret',NULL,NULL,'2026-11-15 14:00:00')`,
  ]);
  return database;
}

describe("platform notification inbox", () => {
  it("lists only the exact tenant and user with stable cursor pagination", async () => {
    const db = fixture();
    const first = await listPlatformNotifications(db as never, {
      tenantId: "tenant-a", userId: "user-a", status: "unread", limit: 1,
    });
    expect(first).toMatchObject({ data: [{ id: "notice-b" }], has_more: true, next_cursor: expect.any(String) });

    const second = await listPlatformNotifications(db as never, {
      tenantId: "tenant-a", userId: "user-a", status: "unread", limit: 1, cursor: first.next_cursor!,
    });
    expect(second).toMatchObject({ data: [{ id: "notice-a" }], has_more: false, next_cursor: null });

    const all = await listPlatformNotifications(db as never, { tenantId: "tenant-a", userId: "user-a", status: "all", limit: 10 });
    expect(all.data.map((row) => row.id)).toEqual(["notice-b", "notice-a", "notice-c"]);
    expect(all.data.some((row) => row.id.includes("other"))).toBe(false);
  });

  it("validates bounded pagination and opaque cursor input", async () => {
    const db = fixture();
    await expect(listPlatformNotifications(db as never, {
      tenantId: "tenant-a", userId: "user-a", status: "unread", limit: 101,
    })).rejects.toThrow("platform_notification_query_invalid");
    await expect(listPlatformNotifications(db as never, {
      tenantId: "tenant-a", userId: "user-a", status: "all", limit: 10, cursor: "../../notice",
    })).rejects.toThrow("platform_notification_cursor_invalid");
  });

  it("marks only an exact user's notification read and treats retries idempotently", async () => {
    const db = fixture();
    const input = { tenantId: "tenant-a", userId: "user-a", notificationId: "notice-a" };
    expect(await markPlatformNotificationRead(db as never, input)).toBe(true);
    const readAt = db.db.prepare("SELECT read_at FROM notifications WHERE id='notice-a'").get() as { read_at: string };
    expect(readAt.read_at).toBeTruthy();
    expect(await markPlatformNotificationRead(db as never, input)).toBe(true);
    expect(await markPlatformNotificationRead(db as never, { ...input, userId: "user-b" })).toBe(false);
    expect(await markPlatformNotificationRead(db as never, { ...input, tenantId: "tenant-b" })).toBe(false);
    const unread = await listPlatformNotifications(db as never, {
      tenantId: "tenant-a", userId: "user-a", status: "unread", limit: 10,
    });
    expect(unread.data.map((row) => row.id)).toEqual(["notice-b"]);
  });
});
