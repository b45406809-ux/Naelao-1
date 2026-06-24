import { DurableObject } from 'cloudflare:workers';

interface Env {}

export class ThreadsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(() => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY DEFAULT 0)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_version VALUES (0)`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      archived_at TEXT
    )`);

    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      seq INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg_thread_seq ON messages(thread_id, seq ASC)`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/threads/create' && request.method === 'POST') return this.handleCreateThread(request);
      if (path.startsWith('/threads/') && request.method === 'GET' && !path.includes('/messages')) return this.handleGetThread(path);
      if (path.startsWith('/threads/') && request.method === 'DELETE') return this.handleDeleteThread(path);
      if (path === '/messages/add' && request.method === 'POST') return this.handleAddMessage(request);
      if (path.startsWith('/messages/') && request.method === 'GET') return this.handleGetMessages(path, url);
      if (path.startsWith('/messages/') && request.method === 'DELETE') return this.handleDeleteMessage(path);
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404 });
    } catch (e) {
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: String(e) } }, { status: 500 });
    }
  }

  private async handleCreateThread(request: Request): Promise<Response> {
    const { spaceId, projectId, title } = await request.json<{ spaceId: string; projectId?: string; title?: string }>();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO threads (id, space_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, spaceId, projectId ?? null, title ?? null, now, now
    );
    const thread = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM threads WHERE id = ?`, id)][0];
    return Response.json({ data: { thread } });
  }

  private handleGetThread(path: string): Response {
    const id = path.split('/').pop() ?? '';
    const thread = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM threads WHERE id = ?`, id)][0];
    if (!thread) return Response.json({ error: { code: 'NOT_FOUND', message: 'Thread not found' } }, { status: 404 });
    return Response.json({ data: { thread } });
  }

  private handleDeleteThread(path: string): Response {
    const id = path.split('/').pop() ?? '';
    this.sql.exec(`DELETE FROM messages WHERE thread_id = ?`, id);
    this.sql.exec(`DELETE FROM threads WHERE id = ?`, id);
    return Response.json({ data: { ok: true } });
  }

  private async handleAddMessage(request: Request): Promise<Response> {
    const { threadId, role, content, toolCallId } = await request.json<{
      threadId: string; role: string; content: string; toolCallId?: string;
    }>();

    const seqRow = [...this.sql.exec<{ seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM messages WHERE thread_id = ?`, threadId
    )][0];
    const seq = seqRow?.seq ?? 1;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO messages (id, thread_id, role, content, tool_call_id, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, threadId, role, content, toolCallId ?? null, seq, now
    );

    this.sql.exec(`UPDATE threads SET updated_at = ? WHERE id = ?`, now, threadId);

    const message = [...this.sql.exec<Record<string, unknown>>(`SELECT * FROM messages WHERE id = ?`, id)][0];
    return Response.json({ data: { message } });
  }

  private handleGetMessages(path: string, url: URL): Response {
    const threadId = path.split('/').pop() ?? '';
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const cursor = url.searchParams.get('cursor');

    let query = `SELECT * FROM messages WHERE thread_id = ?`;
    const params: unknown[] = [threadId];
    if (cursor) {
      query += ` AND seq > ?`;
      params.push(parseInt(cursor, 10));
    }
    query += ` ORDER BY seq ASC LIMIT ?`;
    params.push(limit);

    const messages = [...this.sql.exec<Record<string, unknown>>(query, ...params)];
    const lastSeq = messages.length > 0 ? (messages[messages.length - 1]?.['seq'] as number) : undefined;
    const nextCursor = messages.length === limit ? String(lastSeq) : undefined;

    return Response.json({ data: { messages, nextCursor } });
  }

  private handleDeleteMessage(path: string): Response {
    const id = path.split('/').pop() ?? '';
    this.sql.exec(`DELETE FROM messages WHERE id = ?`, id);
    return Response.json({ data: { ok: true } });
  }
}
