// WebSocket Gateway via Durable Object — one WsHubDO per tenant, manages live WS connections
// Dashboard clients connect to receive live session/agent events.
import { DurableObject } from "cloudflare:workers";
import { mintInternalToken, readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { restoreWsSessionMeta, type WsSessionMeta } from "./session-meta";
import { blocksNodeEdit } from "./node-lease-gate";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  WS_HUB: DurableObjectNamespace<WsHubDO>;
  ALLOWED_ORIGINS?: string; // comma-separated list, e.g. "https://app.naelao.com,https://dashboard.naelao.com"
  AGENTS_WORKER?: Fetcher;
}

// G-AL03: Strict origin validation to prevent subdomain spoofing.
// Uses URL parsing and exact hostname matching — not string.includes() or endsWith().
function isAllowedOrigin(origin: string | null, env: Env): boolean {
  if (!origin) return false;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  // In development, allow localhost
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "dev") {
    if (parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1") {
      return true;
    }
  }

  // Check explicit allowlist if provided
  if (env.ALLOWED_ORIGINS) {
    const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
    if (allowed.includes(origin)) return true;
  }

  // Default: allow any subdomain of naelao.com (exact .naelao.com suffix, not substring match)
  const hostname = parsedOrigin.hostname;
  return hostname === "naelao.com" || hostname.endsWith(".naelao.com");
}

interface PresenceState extends Record<string, SqlStorageValue> { user_id: string; file_path: string | null; cursor_line: number | null; cursor_col: number | null; last_seen: number }

interface BroadcastBody {
  spaceId?: string;
  event: string;
  data: unknown;
}

interface UiActionEvent {
  type: "mcp.ui_action";
  action?: unknown;
  payload?: unknown;
  projectId?: unknown;
}

function actionIsDocumentMutation(action: unknown): boolean {
  return action === "redline.accept_clause" || action === "redline.apply_patch";
}

// WsHubDO — one DO per tenant. Manages all WebSocket connections for that tenant.
// Uses Hibernation API (ctx.acceptWebSocket) so the DO can hibernate between events
// and connections are preserved across hibernation cycles.
export class WsHubDO extends DurableObject<Env> {
  // In-memory session map — only valid while the DO is active (not hibernated).
  // DO hibernation kills in-memory state; however WebSocket connections themselves
  // survive hibernation via the Hibernation API (acceptWebSocket).
  private sessions = new Map<WebSocket, WsSessionMeta>();
  private presence = new Map<string, PresenceState>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS presence (
      user_id TEXT PRIMARY KEY, file_path TEXT, cursor_line INTEGER, cursor_col INTEGER, last_seen INTEGER NOT NULL)`);
    for (const row of ctx.storage.sql.exec<PresenceState>("SELECT user_id, file_path, cursor_line, cursor_col, last_seen FROM presence")) {
      if (row.last_seen >= Date.now() - 60_000) this.presence.set(row.user_id, row);
    }
  }

  private schedulePresencePersistence(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const cutoff = Date.now() - 60_000;
      this.ctx.storage.sql.exec("DELETE FROM presence WHERE last_seen < ?", cutoff);
      for (const value of this.presence.values()) {
        if (value.last_seen < cutoff) { this.presence.delete(value.user_id); continue; }
        this.ctx.storage.sql.exec(`INSERT INTO presence VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET file_path=excluded.file_path, cursor_line=excluded.cursor_line,
          cursor_col=excluded.cursor_col, last_seen=excluded.last_seen`, value.user_id, value.file_path,
          value.cursor_line, value.cursor_col, value.last_seen);
      }
    }, 500);
  }

  /** Rehydrate a hibernation-surviving socket into the active session index. The WebSocket
   * attachment is authoritative; the tag fallback keeps older connections readable after a
   * deploy that predates attachment metadata. Every inbound event goes through this helper so a
   * socket that wakes the DO is immediately eligible for the next broadcast. */
  private restoreSession(ws: WebSocket): WsSessionMeta | undefined {
    const existing = this.sessions.get(ws);
    if (existing) return existing;
    const restored = restoreWsSessionMeta(
      ws.deserializeAttachment() as WsSessionMeta | null,
      this.ctx.getTags(ws),
    );
    if (restored) this.sessions.set(ws, restored);
    return restored;
  }

  /** Dispatch a canvas action through the authenticated agent route and report the
   * observation back to the originating socket. The accepted event is intentionally
   * separate from the result so the UI can show a running state while the planner works. */
  private async dispatchUiAction(ws: WebSocket, meta: WsSessionMeta, event: UiActionEvent): Promise<void> {
    if (!this.env.AGENTS_WORKER) {
      ws.send(JSON.stringify({ type: "mcp.ui_action.failed", action: event.action, error: "agent_worker_unavailable" }));
      return;
    }

    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
    const nodeId = typeof (payload as Record<string, unknown>).nodeId === "string" ? String((payload as Record<string, unknown>).nodeId) : "";
    if (actionIsDocumentMutation(event.action) && nodeId && typeof event.projectId === "string") {
      const leaseResponse = await this.env.AGENTS_WORKER.fetch(new Request("http://agents/internal/document-node-lease/status", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": meta.tenantId, "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, meta.tenantId) },
        body: JSON.stringify({ tenant_id: meta.tenantId, space_id: meta.spaceId, project_id: event.projectId, node_id: nodeId, holder_id: meta.userId, holder_type: "HUMAN" }),
      }));
      if (!leaseResponse.ok) {
        ws.send(JSON.stringify({ type: "mcp.ui_action.failed", action: event.action, error: "node_lease_check_unavailable" }));
        return;
      }
      const status = await leaseResponse.json<{ active?: boolean; holder_type?: string; holder_id?: string }>();
      if (blocksNodeEdit(status, meta.userId!)) {
        ws.send(JSON.stringify({ type: "mcp.ui_action.blocked", action: event.action, error: "document_node_locked", node_id: nodeId }));
        return;
      }
    }
    const escapedPayload = JSON.stringify(payload).replace(/[<&]/g, c => c === "<" ? "\\u003c" : "\\u0026");
    const action = event.action as string;
    const goal = `<ui_action_event user="${meta.userId!.replace(/[\"&<>]/g, "_")}" action="${action.replace(/[\"&<>]/g, "_")}" payload="${escapedPayload.replace(/"/g, "&quot;")}" />`;
    const runResponse = await this.env.AGENTS_WORKER.fetch(new Request(`http://agents/agents/${encodeURIComponent(meta.agentId!)}/script/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": meta.tenantId,
        "x-naelao-space-id": meta.spaceId!,
        "x-naelao-user-id": meta.userId!,
        "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, meta.tenantId),
      },
      body: JSON.stringify({ goal, spaceId: meta.spaceId, projectId: event.projectId, sessionId: meta.sessionId, context: { immediate: true, source: "mcp_ui" } }),
    }));
    const body = await runResponse.json<unknown>().catch(() => null);
    if (!runResponse.ok) {
      ws.send(JSON.stringify({ type: "mcp.ui_action.failed", action, status: runResponse.status, error: "agent_action_failed" }));
      return;
    }
    const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    ws.send(JSON.stringify({
      type: runResponse.status === 202 ? "mcp.ui_action.queued" : "mcp.ui_action.completed",
      action,
      run_id: typeof record.run_id === "string" ? record.run_id : typeof record.id === "string" ? record.id : undefined,
      result: body,
    }));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 1024 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    const url = new URL(request.url);
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";

    if (url.pathname === "/ws") {
      // WebSocket upgrade
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 400 });
      }

      // G-AL03: Reject WebSocket upgrades from unauthorized origins
      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin, this.env)) {
        return new Response(JSON.stringify({ error_code: "forbidden", message: "WebSocket origin not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]] as [WebSocket, WebSocket];

      // Use Hibernation API so CF can sleep the DO between messages
      this.ctx.acceptWebSocket(server);

      const spaceId = url.searchParams.get("spaceId") ?? undefined;
      const userId = url.searchParams.get("userId") ?? undefined;
      const agentId = url.searchParams.get("agentId") ?? undefined;
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const meta: WsSessionMeta = { tenantId, ...(spaceId !== undefined ? { spaceId } : {}), ...(userId ? { userId } : {}), ...(agentId ? { agentId } : {}), ...(sessionId ? { sessionId } : {}) };
      this.sessions.set(server, meta);
      server.serializeAttachment(meta);

      server.addEventListener("close", () => {
        this.sessions.delete(server);
      });
      server.addEventListener("error", () => {
        this.sessions.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      // Internal endpoint: broadcast an event to all connections for this tenant.
      // Validated by PLATFORM_SECRET so only internal workers can call this.
      const incomingSecret = request.headers.get("x-naelao-platform-secret") ?? "";
      const expectedSecret = this.env.PLATFORM_SECRET;
      if (expectedSecret && incomingSecret !== expectedSecret) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = await request.json<BroadcastBody>();
      const payload = JSON.stringify({ event: body.event, data: body.data });
      const targetSpaceId = body.spaceId;

      // Re-hydrate sessions from the Hibernation API if the DO woke from sleep
      const activeSockets = this.ctx.getWebSockets();
      for (const ws of activeSockets) {
        this.restoreSession(ws);
      }

      let sent = 0;
      for (const [ws, meta] of this.sessions) {
        if (!targetSpaceId || meta.spaceId === targetSpaceId) {
          try {
            ws.send(payload);
            sent++;
          } catch {
            this.sessions.delete(ws);
          }
        }
      }

      return new Response(JSON.stringify({ ok: true, sent }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // Hibernation API handlers — called by CF when the DO wakes for a WebSocket event
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const byteLength = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (byteLength > 64 * 1024) {
      ws.close(1009, "message too large");
      return;
    }
    // Clients can send ping frames; echo back a pong
    if (typeof message === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        ws.send(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "type" in parsed &&
        (parsed as { type: unknown }).type === "ping"
      ) {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "presence.update") {
        const meta = this.restoreSession(ws);
        const body = parsed as { file_path?: unknown; cursor_line?: unknown; cursor_col?: unknown };
        if (!meta?.userId) { ws.send(JSON.stringify({ error: "user_identity_required" })); return; }
        const value: PresenceState = {
          user_id: meta.userId,
          file_path: typeof body.file_path === "string" ? body.file_path : null,
          cursor_line: Number.isInteger(body.cursor_line) ? body.cursor_line as number : null,
          cursor_col: Number.isInteger(body.cursor_col) ? body.cursor_col as number : null,
          last_seen: Date.now(),
        };
        this.presence.set(meta.userId, value);
        this.schedulePresencePersistence();
        const payload = JSON.stringify({ event: "presence.update", data: value });
        for (const [socket, socketMeta] of this.sessions) if (socketMeta.spaceId === meta.spaceId) socket.send(payload);
      }
      if (parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "mcp.ui_action") {
        const meta = this.restoreSession(ws);
        const event = parsed as UiActionEvent;
        if (!meta?.spaceId || !meta.userId || !meta.agentId || !meta.sessionId || typeof event.action !== "string" || !event.action) { ws.send(JSON.stringify({ error: "ui_action_context_required" })); return; }
        ws.send(JSON.stringify({ type: "mcp.ui_action.accepted", action: event.action }));
        void this.dispatchUiAction(ws, meta, event).catch(() => {
          try { ws.send(JSON.stringify({ type: "mcp.ui_action.failed", action: event.action, error: "agent_action_failed" })); } catch { /* closed socket */ }
        });
      }
    }
  }

  override webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.sessions.delete(ws);
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
    this.sessions.delete(ws);
  }
}

// Main worker — routes WebSocket upgrades and broadcast calls to the per-tenant WsHubDO
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.PLATFORM_SECRET) {
      return new Response(
        JSON.stringify({ error_code: "internal_error", message: "Missing PLATFORM_SECRET" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error_code: "unauthorized", message: "Missing tenant" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // One DO per tenant — stable DO name derived from tenantId
    const doId = env.WS_HUB.idFromName(`ws:${tenantId}`);
    const stub = env.WS_HUB.get(doId);

    // Forward the request to the DO, preserving all headers and body
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
