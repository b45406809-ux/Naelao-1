export type PlatformNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
};

export type PlatformNotificationStatus = "all" | "unread";

type NotificationCursor = { createdAt: string; id: string };

const MAX_LIMIT = 100;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6}Z?)?$/;

function encodeCursor(cursor: NotificationCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string | undefined): NotificationCursor | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("platform_notification_cursor_invalid");
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).some((key) => key !== "createdAt" && key !== "id") ||
        typeof parsed.createdAt !== "string" || !TIMESTAMP.test(parsed.createdAt) ||
        typeof parsed.id !== "string" || !ID.test(parsed.id)) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error("platform_notification_cursor_invalid");
  }
}

export async function listPlatformNotifications(
  db: D1Database,
  input: {
    tenantId: string;
    userId: string;
    status: PlatformNotificationStatus;
    limit: number;
    cursor?: string;
  },
): Promise<{ data: PlatformNotification[]; has_more: boolean; next_cursor: string | null }> {
  if (!input.tenantId || !input.userId || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT ||
      (input.status !== "all" && input.status !== "unread")) {
    throw new Error("platform_notification_query_invalid");
  }

  const cursor = decodeCursor(input.cursor);
  const clauses = ["tenant_id=?", "user_id=?"];
  const bindings: unknown[] = [input.tenantId, input.userId];
  if (input.status === "unread") clauses.push("read_at IS NULL");
  if (cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  bindings.push(input.limit + 1);

  const rows = await db.prepare(`SELECT id,type,title,body,read_at,created_at FROM notifications
    WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(...bindings).all<PlatformNotification>();
  const selected = (rows.results ?? []).slice(0, input.limit);
  const hasMore = (rows.results?.length ?? 0) > input.limit;
  const last = selected.at(-1);
  return {
    data: selected,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

/** Return false for missing or out-of-scope IDs without disclosing which case occurred. */
export async function markPlatformNotificationRead(
  db: D1Database,
  input: { tenantId: string; userId: string; notificationId: string },
): Promise<boolean> {
  if (!input.tenantId || !input.userId || !ID.test(input.notificationId)) {
    throw new Error("platform_notification_id_invalid");
  }
  const result = await db.prepare(`UPDATE notifications SET read_at=COALESCE(read_at,datetime('now'))
    WHERE tenant_id=? AND user_id=? AND id=?`)
    .bind(input.tenantId, input.userId, input.notificationId).run();
  if ((result.meta?.changes ?? 0) > 0) return true;
  const existing = await db.prepare("SELECT id FROM notifications WHERE tenant_id=? AND user_id=? AND id=?")
    .bind(input.tenantId, input.userId, input.notificationId).first<{ id: string }>();
  return existing !== null;
}
