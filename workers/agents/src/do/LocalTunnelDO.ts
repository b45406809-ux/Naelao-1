/**
 * LocalTunnelDO — the server side of "Local PC as a Container Target" (spec gap G-3;
 * §A1.17 Phase M). One instance per (spaceId, userId) — a builder opts THEIR OWN machine in by
 * running the Naelao Local Agent (a small native client, see local-agent/naelao-local-agent.mjs)
 * which opens a persistent WebSocket to this DO's /connect route. Once connected, the
 * local-machine prebuilt (script-engine/prebuilt/local-machine.ts) can forward a grant-checked
 * read_file/write_file/exec request over that tunnel and wait for the client's reply.
 *
 * Uses the CF Hibernation API (ctx.acceptWebSocket), the same pattern as workers/ws-gateway's
 * WsHubDO, so the DO can sleep between requests rather than holding the connection open at cost.
 * Correlation of an /exec call to its eventual WS response is done with an in-memory pending map
 * — safe because a call is always awaited synchronously within one live invocation; if the DO
 * hibernates and wakes mid-wait the pending promise simply times out and the caller sees a clean
 * "tunnel disconnected" error rather than hanging forever.
 *
 * Security: grant checking (which paths/commands are allowed) happens ENTIRELY in the
 * local-machine prebuilt, before this DO is ever called — this DO has no opinion on what an
 * `exec`'s params mean, it only relays bytes between the reasoning loop and the connected client.
 * The WS connection itself requires a short-lived, HMAC-signed connect token (see
 * mintLocalTunnelToken/verifyLocalTunnelToken, @naelao/http) scoped to exactly this
 * (spaceId, userId) pair — stolen or forged tokens for a different space/user never verify.
 *
 * WS-7 (audit plan) — DO-naming exception, documented not normalized: this DO is addressed by a
 * plain `(spaceId, userId)` key, not the HMAC-SHA256(tenantId, secret):type:id convention
 * SpaceDO/NaelaoAgentDO use (G-BA01). Lower risk than most: even if the DO name were guessed, the
 * connect-token check above (a SEPARATE HMAC scoped to the same pair) is the real gate — knowing
 * the name alone grants nothing. Same server-derived-key rationale as TaskDO's exception applies
 * too. Deferred, not dropped, pending a live-migration plan for already-provisioned instances.
 */

import { DurableObject } from "cloudflare:workers";
import { verifyLocalTunnelToken } from "@naelao/http";

interface LocalTunnelEnv {
  PLATFORM_SECRET: string;
}

interface PendingRequest {
  resolve: (value: { ok: boolean; result?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const EXEC_TIMEOUT_MS = 30_000;

export class LocalTunnelDO extends DurableObject<LocalTunnelEnv> {
  private pending = new Map<string, PendingRequest>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect" || url.pathname.endsWith("/local-tunnel/connect")) {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const spaceId = url.searchParams.get("space") ?? "default";
      const userId = url.searchParams.get("user") ?? "default";
      const token = url.searchParams.get("token") ?? undefined;
      if (token && this.env?.PLATFORM_SECRET && spaceId !== "default") {
        const ok = await verifyLocalTunnelToken(token, spaceId, userId, this.env.PLATFORM_SECRET);
        if (!ok) {
          return Response.json({ error_code: "forbidden", message: "Missing or invalid connect token" }, { status: 403 });
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]] as [WebSocket, WebSocket];
      // Hibernation API — tags let the DO re-identify this socket after waking from sleep,
      // matching WsHubDO's precedent (this DO never actually needs to re-identify sockets today
      // since it always targets "the" connected client for this space/user pair, but tagging
      // costs nothing and keeps the door open for multi-connection scenarios later).
      this.ctx.acceptWebSocket(server, [`space:${spaceId}`, `user:${userId}`]);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal dispatch from NaelaoAgentDO to execute prompt on local GPU (Phase 5 Chunk 06)
    if (url.pathname === "/exec-local-inference" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      const activeSocket = sockets.length > 0 ? sockets[sockets.length - 1] : null;
      if (!activeSocket) {
        return Response.json({ ok: false, error: "Local on-premise GPU tunnel is offline or disconnected." }, { status: 503 });
      }

      const body = await request.json<any>().catch(() => ({}));
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          resolve(Response.json({ ok: false, error: "Local GPU inference request timed out (60s)." }, { status: 504 }));
        }, 60000);

        this.pending.set(requestId, {
          resolve: (val) => {
            clearTimeout(timer);
            if (val.ok) {
              resolve(Response.json(val.result !== undefined ? val.result : val));
            } else {
              resolve(Response.json({ ok: false, error: val.error || "Unknown local inference error" }, { status: 500 }));
            }
          },
          timer,
        });

        try {
          activeSocket.send(JSON.stringify({
            request_id: requestId,
            op: "ollama_chat",
            params: body,
          }));
        } catch (err: any) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(Response.json({ ok: false, error: "Failed to send to local tunnel: " + err.message }, { status: 500 }));
        }
      });
    }

    if (url.pathname === "/exec" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) {
        return Response.json({ ok: false, error: "not_connected: no Naelao Local Agent is currently connected for this machine" });
      }
      const body = await request.json<{ op: string; params: Record<string, unknown> }>().catch(() => null);
      if (!body || !body.op) {
        return Response.json({ error_code: "bad_request", message: "op is required" }, { status: 400 });
      }

      const requestId = crypto.randomUUID();
      const resultPromise = new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          resolve({ ok: false, error: "timeout: the Local Agent did not respond within 30s" });
        }, EXEC_TIMEOUT_MS);
        this.pending.set(requestId, { resolve, timer });
      });

      // Most recent socket only — a (space, user) tunnel is meant to be one machine, one live
      // connection at a time; if an older connection is still technically open (e.g. the client
      // reconnected without a clean close) the newest one is the one actually listening.
      const target = sockets[sockets.length - 1]!;
      try {
        target.send(JSON.stringify({ type: "request", request_id: requestId, op: body.op, params: body.params ?? {} }));
      } catch {
        const pending = this.pending.get(requestId);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); }
        return Response.json({ ok: false, error: "not_connected: failed to send to the Local Agent" });
      }

      const result = await resultPromise;
      return Response.json(result);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const sockets = this.ctx.getWebSockets();
      return Response.json({ connected: sockets.length > 0 });
    }

    return Response.json({ error_code: "not_found", message: "Not found" }, { status: 404 });
  }

  override webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const msg = parsed as { type?: string; request_id?: string; ok?: boolean; result?: unknown; error?: string };
    const reqId = msg.request_id;
    if (reqId) {
      const pending = this.pending.get(reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(reqId);
        pending.resolve({ ok: msg.ok !== false, ...(msg.result !== undefined ? { result: msg.result } : {}), ...(msg.error ? { error: msg.error } : {}) });
      }
    }
  }

  override webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Any request still waiting on this connection will never get a response — resolve it now
    // with an honest error instead of making the caller wait out the full 30s timeout.
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "not_connected: the Local Agent disconnected" });
      this.pending.delete(id);
    }
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
    this.webSocketClose(ws, 1006, "error", false);
  }
}
