// WebSocket Gateway via Durable Object — one WsHubDO per tenant, manages live WS connections
// Dashboard clients connect to receive live session/agent events.
import { DurableObject } from "cloudflare:workers";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  WS_HUB: DurableObjectNamespace<WsHubDO>;
  ALLOWED_ORIGINS?: string; // comma-separated list, e.g. "https://app.naelao.com,https://dashboard.naelao.com"
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

interface WsSessionMeta {
  tenantId: string;
  spaceId?: string;
  userId?: string;
}

interface PresenceState extends Record<string, SqlStorageValue> { user_id: string; file_path: string | null; cursor_line: number | null; cursor_col: number | null; last_seen: number }

interface BroadcastBody {
  spaceId?: string;
  event: string;
  data: unknown;
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

  override async fetch(request: Request): Promise<Response> {
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
      const meta: WsSessionMeta = { tenantId, ...(spaceId !== undefined ? { spaceId } : {}), ...(userId ? { userId } : {}) };
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
        // When woken via hibernation, re-populate in-memory map from websocket attachment
        if (!this.sessions.has(ws)) {
          const attachment = ws.deserializeAttachment() as WsSessionMeta | null;
          const attached = this.ctx.getTags(ws);
          // Tags format: ["tenantId:<tid>", "spaceId:<sid>"]
          const tenantTag = attached.find((t) => t.startsWith("tenantId:")) ?? "";
          const spaceTag = attached.find((t) => t.startsWith("spaceId:")) ?? undefined;
          const restoredMeta: WsSessionMeta = attachment ?? {
            tenantId: tenantTag.replace("tenantId:", ""),
            ...(spaceTag !== undefined
              ? { spaceId: spaceTag.replace("spaceId:", "") }
              : {}),
          };
          this.sessions.set(ws, restoredMeta);
        }
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
        const meta = this.sessions.get(ws) ?? ws.deserializeAttachment() as WsSessionMeta | null;
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
