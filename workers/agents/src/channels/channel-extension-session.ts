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
  sql.exec(`CREATE TABLE IF NOT EXISTS channel_extension_named_sessions (
    project_id TEXT NOT NULL, installation_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_key TEXT NOT NULL,
    state_json TEXT NOT NULL, state_bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,installation_id,conversation_id,session_key)
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS idx_channel_extension_named_sessions_expiry ON channel_extension_named_sessions(project_id,installation_id,expires_at)");
}

const MAX_NAMED_SESSIONS_PER_CONVERSATION = 16;
const SESSION_KEY = /^[a-z][a-z0-9_-]{0,47}$/;

/** Reads at most 16 opaque records for one verified conversation. Provider contact IDs never
 * enter the handler API; the host derives this scope from its authenticated inbound dispatch. */
export function readChannelExtensionSessions(sql: ChannelExtensionSessionSql, scope: ChannelExtensionSessionScope, now = Date.now()): Record<string, unknown> {
  sql.exec("DELETE FROM channel_extension_sessions WHERE project_id=? AND expires_at<=?", scope.projectId, now);
  sql.exec("DELETE FROM channel_extension_named_sessions WHERE project_id=? AND expires_at<=?", scope.projectId, now);
  const states: Record<string, unknown> = {};
  const legacy = sql.exec("SELECT state_json FROM channel_extension_sessions WHERE project_id=? AND installation_id=? AND conversation_id=? AND expires_at>?", scope.projectId, scope.installationId, scope.conversationId, now).toArray()[0] as { state_json: string } | undefined;
  if (legacy) { try { states.default = JSON.parse(legacy.state_json) as unknown; } catch { states.default = null; } }
  const rows = sql.exec("SELECT session_key,state_json FROM channel_extension_named_sessions WHERE project_id=? AND installation_id=? AND conversation_id=? AND expires_at>? ORDER BY session_key LIMIT ?", scope.projectId, scope.installationId, scope.conversationId, now, MAX_NAMED_SESSIONS_PER_CONVERSATION).toArray() as Array<{ session_key: string; state_json: string }>;
  for (const row of rows) if (SESSION_KEY.test(row.session_key)) { try { states[row.session_key] = JSON.parse(row.state_json) as unknown; } catch { states[row.session_key] = null; } }
  return states;
}

export function writeChannelExtensionNamedSessions(sql: ChannelExtensionSessionSql, input: ChannelExtensionSessionScope & {
  updates: Array<{ sessionId: string; value: unknown }>; maxBytes: number; ttlDays: number;
}, now = Date.now()): void {
  if (!Array.isArray(input.updates) || input.updates.length > MAX_NAMED_SESSIONS_PER_CONVERSATION
    || input.updates.some(update => !update || !SESSION_KEY.test(update.sessionId) || update.sessionId === "default")) throw new Error("channel_session_id_invalid");
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 4_096) throw new Error("channel_session_size_limit");
  if (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 90) throw new Error("channel_session_ttl_invalid");
  const unique = new Map(input.updates.map(update => [update.sessionId, update.value]));
  const currentRows = sql.exec("SELECT session_key,state_bytes FROM channel_extension_named_sessions WHERE project_id=? AND installation_id=? AND conversation_id=? AND expires_at>?", input.projectId, input.installationId, input.conversationId, now).toArray() as Array<{ session_key: string; state_bytes: number }>;
  const current = new Map(currentRows.map(row => [row.session_key, Number(row.state_bytes)]));
  let count = current.size, totalBytes = currentRows.reduce((sum, row) => sum + Number(row.state_bytes), 0);
  const encodedUpdates = [...unique].map(([sessionId, value]) => {
    if (value === null) return { sessionId, json: null as string | null, bytes: 0 };
    let json: string;
    try { const encoded = JSON.stringify(value); if (typeof encoded !== "string") throw new Error("not_json"); json = encoded; }
    catch { throw new Error("channel_session_value_not_json"); }
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > input.maxBytes) throw new Error("channel_session_size_limit");
    if (!current.has(sessionId)) count++;
    totalBytes += bytes - (current.get(sessionId) ?? 0);
    return { sessionId, json, bytes };
  });
  if (count > MAX_NAMED_SESSIONS_PER_CONVERSATION) throw new Error("channel_session_count_limit");
  sql.exec("DELETE FROM channel_extension_named_sessions WHERE project_id=? AND expires_at<=?", input.projectId, now);
  const active = sql.exec("SELECT COUNT(*) AS count,COALESCE(SUM(state_bytes),0) AS bytes FROM channel_extension_sessions WHERE project_id=? AND expires_at>?", input.projectId, now).toArray()[0] as { count?: number; bytes?: number } | undefined;
  const named = sql.exec("SELECT COUNT(*) AS count,COALESCE(SUM(state_bytes),0) AS bytes FROM channel_extension_named_sessions WHERE project_id=? AND expires_at>?", input.projectId, now).toArray()[0] as { count?: number; bytes?: number } | undefined;
  if (Number(active?.count ?? 0) + Number(named?.count ?? 0) + encodedUpdates.filter(update => update.json !== null && !current.has(update.sessionId)).length > MAX_PROJECT_SESSIONS
    || Number(active?.bytes ?? 0) + Number(named?.bytes ?? 0) + totalBytes - currentRows.reduce((sum, row) => sum + Number(row.state_bytes), 0) > MAX_PROJECT_SESSION_BYTES)
    throw new Error("channel_session_project_quota_exceeded");
  for (const update of encodedUpdates) {
    if (update.json === null) sql.exec("DELETE FROM channel_extension_named_sessions WHERE project_id=? AND installation_id=? AND conversation_id=? AND session_key=?", input.projectId, input.installationId, input.conversationId, update.sessionId);
    else sql.exec(`INSERT INTO channel_extension_named_sessions(project_id,installation_id,conversation_id,session_key,state_json,state_bytes,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,installation_id,conversation_id,session_key) DO UPDATE SET state_json=excluded.state_json,state_bytes=excluded.state_bytes,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
    input.projectId, input.installationId, input.conversationId, update.sessionId, update.json, update.bytes, now + input.ttlDays * 86_400_000, now);
  }
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

/** Retention-only view for the project owner UI; never returns conversation IDs or state values. */
export function summarizeChannelExtensionSessions(sql: ChannelExtensionSessionSql, projectId: string, installationId: string, now = Date.now()): {
  activeConversations: number; storedBytes: number; nextExpiryAt: number | null;
} {
  sql.exec("DELETE FROM channel_extension_sessions WHERE project_id=? AND installation_id=? AND expires_at<=?", projectId, installationId, now);
  sql.exec("DELETE FROM channel_extension_named_sessions WHERE project_id=? AND installation_id=? AND expires_at<=?", projectId, installationId, now);
  const row = sql.exec(`SELECT COUNT(DISTINCT conversation_id) AS count,COALESCE(SUM(state_bytes),0) AS bytes,MIN(expires_at) AS next_expiry
    FROM (SELECT conversation_id,expires_at,state_bytes FROM channel_extension_sessions WHERE project_id=? AND installation_id=? AND expires_at>? UNION ALL SELECT conversation_id,expires_at,state_bytes FROM channel_extension_named_sessions WHERE project_id=? AND installation_id=? AND expires_at>?)`, projectId, installationId, now, projectId, installationId, now)
    .toArray()[0] as { count?: number; bytes?: number; next_expiry?: number | null } | undefined;
  return { activeConversations: Number(row?.count ?? 0), storedBytes: Number(row?.bytes ?? 0),
    nextExpiryAt: row?.next_expiry === undefined || row.next_expiry === null ? null : Number(row.next_expiry) };
}

/** Owner-initiated deletion is scoped to exactly one project installation. */
export function clearChannelExtensionSessions(sql: ChannelExtensionSessionSql, projectId: string, installationId: string): number {
  const result = sql.exec("DELETE FROM channel_extension_sessions WHERE project_id=? AND installation_id=?", projectId, installationId) as { rowsWritten?: number };
  const named = sql.exec("DELETE FROM channel_extension_named_sessions WHERE project_id=? AND installation_id=?", projectId, installationId) as { rowsWritten?: number };
  return Number(result.rowsWritten ?? 0) + Number(named.rowsWritten ?? 0);
}
