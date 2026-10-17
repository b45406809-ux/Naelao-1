/** Owner-approved external conversation state. Values are opaque bounded JSON, and every read
 * and write is scoped to one project, installation version identity and opaque conversation ID. */
export interface ChannelExtensionSessionSql {
  exec(query: string, ...params: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

export interface ChannelExtensionSessionScope { projectId: string; installationId: string; conversationId: string; }
const MAX_PROJECT_SESSIONS = 10_000;
const MAX_PROJECT_SESSION_BYTES = 16 * 1024 * 1024;

export function initChannelExtensionSessionStore(sql: ChannelExtensionSessionSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS channel_extension_sessions (
    project_id TEXT NOT NULL, installation_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    state_json TEXT NOT NULL, state_bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,installation_id,conversation_id)
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS idx_channel_extension_sessions_expiry ON channel_extension_sessions(project_id,installation_id,expires_at)");
}

export function readChannelExtensionSession(sql: ChannelExtensionSessionSql, scope: ChannelExtensionSessionScope, now = Date.now()): unknown {
  sql.exec("DELETE FROM channel_extension_sessions WHERE project_id=? AND expires_at<=?", scope.projectId, now);
  const row = sql.exec("SELECT state_json FROM channel_extension_sessions WHERE project_id=? AND installation_id=? AND conversation_id=? AND expires_at>?",
    scope.projectId, scope.installationId, scope.conversationId, now).toArray()[0] as { state_json: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.state_json) as unknown; } catch { return null; }
}

export function writeChannelExtensionSession(sql: ChannelExtensionSessionSql, input: ChannelExtensionSessionScope & {
  value: unknown; maxBytes: number; ttlDays: number;
}, now = Date.now()): void {
  const key = [input.projectId, input.installationId, input.conversationId] as const;
  if (input.value === null) {
    sql.exec("DELETE FROM channel_extension_sessions WHERE project_id=? AND installation_id=? AND conversation_id=?", ...key);
    return;
  }
  let stateJson: string;
  try {
    const encoded = JSON.stringify(input.value);
    if (typeof encoded !== "string") throw new Error("not_json");
    stateJson = encoded;
  } catch { throw new Error("channel_session_value_not_json"); }
  const stateBytes = new TextEncoder().encode(stateJson).byteLength;
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 4_096 || stateBytes > input.maxBytes)
    throw new Error("channel_session_size_limit");
  if (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 90)
    throw new Error("channel_session_ttl_invalid");
  sql.exec("DELETE FROM channel_extension_sessions WHERE project_id=? AND expires_at<=?", input.projectId, now);
  const existing = sql.exec("SELECT state_bytes FROM channel_extension_sessions WHERE project_id=? AND installation_id=? AND conversation_id=?", ...key).toArray()[0] as { state_bytes: number } | undefined;
  const active = sql.exec("SELECT COUNT(*) AS count, COALESCE(SUM(state_bytes),0) AS bytes FROM channel_extension_sessions WHERE project_id=? AND expires_at>?",
    input.projectId, now).toArray()[0] as { count: number; bytes: number } | undefined;
  const sessionCount = (active?.count ?? 0) + (existing ? 0 : 1);
  const projectBytes = (active?.bytes ?? 0) - (existing?.state_bytes ?? 0) + stateBytes;
  if (sessionCount > MAX_PROJECT_SESSIONS || projectBytes > MAX_PROJECT_SESSION_BYTES)
    throw new Error("channel_session_project_quota_exceeded");
  sql.exec(`INSERT INTO channel_extension_sessions(project_id,installation_id,conversation_id,state_json,state_bytes,expires_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,installation_id,conversation_id) DO UPDATE SET state_json=excluded.state_json,
    state_bytes=excluded.state_bytes,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
  ...key, stateJson, stateBytes, now + input.ttlDays * 86_400_000, now);
}
