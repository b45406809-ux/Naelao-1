export const PRODUCT_USER_CHAT_EXPORT_MAX_SESSIONS = 1_000;
export const PRODUCT_USER_CHAT_EXPORT_MAX_MESSAGES = 2_000;
export const PRODUCT_USER_CHAT_EXPORT_MAX_BYTES = 4 * 1024 * 1024;
export const PRODUCT_USER_CHAT_EXPORT_MAX_PRODUCT_BYTES = 16 * 1024 * 1024;
export const PRODUCT_USER_EXPORT_MAX_SPACES = 128;

export type ProductUserChatHistoryExport = {
  space_id: string;
  sessions: string[];
  messages: Array<{
    id: string;
    session_id: string;
    role: string;
    content: string;
    tool_call_id: string | null;
    tool_name: string | null;
    token_count: number | null;
    created_at: string;
    author_type: string;
    author_id: string | null;
    metadata: string;
  }>;
};

/** Validate the complete, bounded SpaceDO response before including it in a user export. */
export function isProductUserChatHistoryExport(value: unknown, expectedSpaceId: string): value is ProductUserChatHistoryExport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 3 || !["space_id", "sessions", "messages"].every(key => key in root)
    || root.space_id !== expectedSpaceId || !Array.isArray(root.sessions) || root.sessions.length > PRODUCT_USER_CHAT_EXPORT_MAX_SESSIONS
    || root.sessions.some(id => typeof id !== "string" || !id.length || id.length > 256)
    || new Set(root.sessions).size !== root.sessions.length
    || !Array.isArray(root.messages) || root.messages.length > PRODUCT_USER_CHAT_EXPORT_MAX_MESSAGES) return false;
  const sessions = new Set(root.sessions as string[]);
  const required = ["id", "session_id", "role", "content", "tool_call_id", "tool_name", "token_count", "created_at", "author_type", "author_id", "metadata"];
  return root.messages.every(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    return Object.keys(row).length === required.length && required.every(key => key in row)
      && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256
      && typeof row.session_id === "string" && sessions.has(row.session_id)
      && typeof row.role === "string" && row.role.length > 0 && row.role.length <= 40
      && typeof row.content === "string"
      && (row.tool_call_id === null || typeof row.tool_call_id === "string")
      && (row.tool_name === null || typeof row.tool_name === "string")
      && (row.token_count === null || Number.isSafeInteger(row.token_count) && Number(row.token_count) >= 0)
      && typeof row.created_at === "string" && row.created_at.length > 0 && row.created_at.length <= 64
      && Number.isFinite(Date.parse(row.created_at))
      && typeof row.author_type === "string" && row.author_type.length > 0 && row.author_type.length <= 40
      && (row.author_id === null || typeof row.author_id === "string")
      && typeof row.metadata === "string";
  });
}
