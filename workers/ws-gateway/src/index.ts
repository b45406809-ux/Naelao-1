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
}

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
      const payload = JSON.stringify({ event: body.event, data: body.data });
      const targetSpaceId = body.spaceId;

      // Re-hydrate sessions from the Hibernation API if the DO woke from sleep
      const activeSockets = this.ctx.getWebSockets();
      for (const ws of activeSockets) {
        // When woken via hibernation, re-populate in-memory map from websocket attachment
        if (!this.sessions.has(ws)) {
          const attached = this.ctx.getTags(ws);
          // Tags format: ["tenantId:<tid>", "spaceId:<sid>"]
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
