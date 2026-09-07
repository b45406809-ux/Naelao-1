// WebSocket Gateway via Durable Object — one WsHubDO per tenant, manages live WS connections
// Dashboard clients connect to receive live session/agent events.
import { DurableObject } from "cloudflare:workers";
import { MultiplayerPresencePayload, WorkspaceMutationEvent } from "@naelao/types";

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
}

interface BroadcastBody {
  spaceId?: string;
  event?: string;
  type?: string;
  data?: unknown;
  payload?: unknown;
}

// WsHubDO — one DO per tenant. Manages all WebSocket connections for that tenant.
// Uses Hibernation API (ctx.acceptWebSocket) so the DO can hibernate between events
// and connections are preserved across hibernation cycles.
export class WsHubDO extends DurableObject<Env> {
  // In-memory session map — only valid while the DO is active (not hibernated).
  private sessions = new Map<WebSocket, WsSessionMeta>();
  private presenceMap = new Map<string, MultiplayerPresencePayload>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Enable WebSocket Hibernation auto-response for pings/pongs
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponse("ping", "pong"));
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
      const meta: WsSessionMeta = { tenantId, ...(spaceId !== undefined ? { spaceId } : {}) };
      this.sessions.set(server, meta);

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
      const eventName = body.event ?? body.type ?? "workspace.broadcast";
      const eventData = body.data ?? body.payload ?? {};
      const payload = JSON.stringify({ event: eventName, data: eventData, type: eventName, payload: eventData });
      const targetSpaceId = body.spaceId;

      // Re-hydrate sessions from the Hibernation API if the DO woke from sleep
      const activeSockets = this.ctx.getWebSockets();
      for (const ws of activeSockets) {
        if (!this.sessions.has(ws)) {
          const attached = this.ctx.getTags(ws);
          const tenantTag = attached.find((t) => t.startsWith("tenantId:")) ?? "";
          const spaceTag = attached.find((t) => t.startsWith("spaceId:")) ?? undefined;
          const restoredMeta: WsSessionMeta = {
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
    if (typeof message === "string") {
      let parsed: any;
      try {
        parsed = JSON.parse(message);
      } catch {
        ws.send(JSON.stringify({ error: "invalid_json" }));
        return;
      }

      if (parsed !== null && typeof parsed === "object") {
        if (parsed.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (parsed.type === "presence.update" && parsed.payload) {
          const presence: MultiplayerPresencePayload = parsed.payload;
          this.presenceMap.set(presence.userId, { ...presence, lastHeartbeat: Date.now() });
          this.broadcast(ws, { type: "presence.state", presences: Array.from(this.presenceMap.values()) });
          return;
        }

        if (parsed.type === "workspace.mutation" && parsed.payload) {
          const mutation: WorkspaceMutationEvent = parsed.payload;
          this.broadcast(ws, { type: "workspace.broadcast", mutation });
          return;
        }
      }
    }
  }

  override webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.sessions.delete(ws);
    for (const [userId, presence] of this.presenceMap.entries()) {
      if (Date.now() - presence.lastHeartbeat > 30000) {
        this.presenceMap.delete(userId);
      }
    }
    this.broadcast(ws, { type: "presence.state", presences: Array.from(this.presenceMap.values()) });
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
    this.sessions.delete(ws);
  }

  private broadcast(excludeWs: WebSocket | null, message: any): void {
    const serialized = JSON.stringify(message);
    const activeSockets = this.ctx.getWebSockets();
    for (const ws of activeSockets) {
      if (ws !== excludeWs) {
        try {
          ws.send(serialized);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }
}

class WebSocketRequestResponse {
  constructor(public request: string, public response: string) {}
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

    const doId = env.WS_HUB.idFromName(`ws:${tenantId}`);
    const stub = env.WS_HUB.get(doId);

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
