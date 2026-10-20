/** One named, authenticated machine per DO; no most-recent-user-socket routing. */
import { DurableObject } from "cloudflare:workers";
import { mintInternalToken, readBoundedRequestText, RequestBodyTooLargeError, verifyInternalToken } from "@naelao/http";
import { assertMachineIdentity, machineSocketKey, tunnelHash, type NamedMachine, type MachineProof } from "@naelao/agent-sdk";
import { TunnelRequestJournal, type TunnelRequestRecord } from "../tunnels/request-journal.js";
interface LocalTunnelEnv { PLATFORM_SECRET: string; SPACES_WORKER?: Fetcher }
interface Identity { tenantId: string; spaceId: string; machineId: string }
interface SocketState extends Identity { generation: number; keyVersion: number; expiresAt: number; heartbeatAt: number }
interface Invocation { actorId: string; projectId?: string; runId: string; requestId: string; deadline: number }
export class LocalTunnelError extends Error { readonly code = "local_machine_unavailable"; }
export class LocalTunnelDO extends DurableObject<LocalTunnelEnv> {
  private journal = new TunnelRequestJournal(this.ctx.storage as never);
  private waiting = new Map<string, () => void>();
  private protocolQueue: Promise<void> = Promise.resolve();
  private async activeRequest(id: string, add: boolean) {
    await this.ctx.storage.transaction(async tx => {
      const active = await tx.get<string[]>("active_requests") ?? [];
      await tx.put("active_requests", add ? [...new Set([...active, id])] : active.filter(value => value !== id));
    });
  }

  private async authority(identity: Identity, body: Record<string, unknown>): Promise<NamedMachine> {
    assertMachineIdentity(identity);
    if (!this.env.SPACES_WORKER) throw new LocalTunnelError("tunnel_registry_unavailable");
    const token = await mintInternalToken(this.env.PLATFORM_SECRET, identity.tenantId);
    const response = await this.env.SPACES_WORKER.fetch(new Request("http://spaces-worker/spaces/" + encodeURIComponent(identity.spaceId) + "/tunnel-authority", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId, "x-naelao-internal-token": token },
      body: JSON.stringify({ ...body, machineId: identity.machineId }),
    }));
    if (!response.ok) throw new LocalTunnelError("tunnel_machine_revoked_or_unauthorized");
    const { machine } = await response.json<{ machine: NamedMachine }>();
    if (machineSocketKey(machine) !== machineSocketKey(identity)) throw new LocalTunnelError("tunnel_registry_identity_mismatch");
    return machine;
  }
  private async identity(): Promise<Identity> {
    const value = await this.ctx.storage.get<Identity>("machine_identity");
    if (!value) throw new LocalTunnelError("named_machine_enrollment_required");
    return value;
  }
  private async bind(identity: Identity) {
    const previous = await this.ctx.storage.get<Identity>("machine_identity");
    if (previous && machineSocketKey(previous) !== machineSocketKey(identity)) throw new Error("tunnel_cross_machine_route");
    await this.ctx.storage.put("machine_identity", identity);
  }
  private async internal(request: Request): Promise<Identity> {
    const identity = await this.identity();
    if (!await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, identity.tenantId, this.env.PLATFORM_SECRET)) throw new Error("tunnel_internal_auth_required");
    return identity;
  }
  private target(identity: Identity, generation: number): WebSocket | undefined {
    return this.ctx.getWebSockets().find(ws => {
      const state = ws.deserializeAttachment() as SocketState | null;
      return state && machineSocketKey(state) === machineSocketKey(identity) && state.generation === generation && state.expiresAt > Date.now() && state.heartbeatAt > Date.now() - 45000;
    });
  }
  private invocation(value: Invocation): void {
    const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
    if (!value || !id.test(value.actorId) || value.actorId === "system" || !id.test(value.runId) || !id.test(value.requestId)
      || value.projectId && !id.test(value.projectId) || !Number.isFinite(value.deadline) || value.deadline <= Date.now() || value.deadline > Date.now() + 60000) throw new Error("tunnel_invocation_invalid");
  }
  private allowed(machine: NamedMachine, invocation: Invocation, op: string, params: Record<string, unknown>): boolean {
    if (machine.status !== "active") return false;
    return machine.grants.some(grant => {
      if (grant.actorId !== invocation.actorId || grant.projectId && grant.projectId !== invocation.projectId || grant.expiresAt <= Date.now()) return false;
      if (op === "inference") return grant.inference && typeof params.model === "string" && machine.hardware.models.includes(params.model);
      if (op === "exec") return typeof params.command === "string" && grant.commands.includes(params.command);
      if (op !== "read_file" && op !== "write_file") return false;
      if (typeof params.path !== "string" || params.path.includes("\0")) return false;
      const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
      const target = normalize(params.path);
      if (target.split("/").some(part => part === ".." || part === ".")) return false;
      return grant.roots.some(root => (root.access === "readwrite" || root.access === (op === "read_file" ? "read" : "write"))
        && (target === normalize(root.path) || target.startsWith(normalize(root.path) + "/")));
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "POST") {
        const body = await request.json<{ proof: MachineProof; signature: string; hardware?: unknown; publicKey?: JsonWebKey }>();
        const identity: Identity = { tenantId: body.proof.tenantId, spaceId: body.proof.spaceId, machineId: body.proof.machineId };
        const machine = await this.authority(identity, { ...body, action: "authenticate" });
        await this.bind(identity);
        if (body.proof.operation !== "connect") {
          for (const ws of this.ctx.getWebSockets()) ws.close(1008, "machine identity changed");
          return Response.json({ machine });
        }
        const ticket = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
        await this.ctx.storage.put("connect-ticket:" + await tunnelHash(ticket), { ...identity, generation: machine.sequence, keyVersion: machine.keyVersion, expiresAt: Date.now() + 30000 });
        await this.ctx.storage.setAlarm(Date.now() + 30000);
        return Response.json({ ticket, expiresAt: Date.now() + 30000, machine });
      }
      if (url.pathname === "/connect") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
          return Response.json({ error: "tunnel_secure_upgrade_required" }, { status: 403 });
        const ticket = url.searchParams.get("ticket") ?? "";
        if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error("tunnel_connect_ticket_invalid");
        const key = "connect-ticket:" + await tunnelHash(ticket);
        const state = await this.ctx.storage.transaction(async tx => {
          const value = await tx.get<SocketState>(key);
          if (!value || value.expiresAt <= Date.now()) throw new Error("tunnel_connect_ticket_expired_or_used");
          await tx.delete(key); return value;
        });
        const machine = await this.authority(state, { action: "lookup" });
        if (machine.status !== "active" || machine.keyVersion !== state.keyVersion || machine.sequence !== state.generation) throw new Error("tunnel_connect_ticket_stale");
        await this.disconnectGeneration(await this.identity(), await this.ctx.storage.get<number>("socket_generation") ?? 0, "reconnect");
        for (const ws of this.ctx.getWebSockets()) ws.close(1000, "superseded connection");
        const pair = new WebSocketPair(), client = pair[0], server = pair[1];
        this.ctx.acceptWebSocket(server, ["machine:" + state.machineId]);
        server.serializeAttachment({ ...state, expiresAt: Date.now() + 300000, heartbeatAt: Date.now() });
        await this.ctx.storage.put("socket_generation", state.generation);
        await this.ctx.storage.setAlarm(Date.now() + 15000);
        server.send(JSON.stringify({ type: "ready", generation: state.generation, expiresAt: Date.now() + 300000, heartbeatIntervalMs: 15000 }));
        return new Response(null, { status: 101, webSocket: client });
      }
      const identity = await this.internal(request);
      if (url.pathname === "/status" && request.method === "GET") {
        const machine = await this.authority(identity, { action: "lookup" });
        const generation = await this.ctx.storage.get<number>("socket_generation") ?? 0;
        return Response.json({ connected: machine.status === "active" && machine.sequence === generation && Boolean(this.target(identity, generation)), machineId: machine.machineId, name: machine.name, hardware: machine.hardware });
      }
      const text = await readBoundedRequestText(request, 65536);
      const body = JSON.parse(text) as { op?: string; params?: Record<string, unknown>; invocation: Invocation };
      this.invocation(body.invocation);
      const existing = await this.journal.get(body.invocation.requestId);
      if (url.pathname === "/request/status" || url.pathname === "/cancel") {
        if (!existing || existing.actorId !== body.invocation.actorId || existing.runId !== body.invocation.runId || existing.projectId !== body.invocation.projectId) throw new Error("tunnel_request_owner_mismatch");
        if (url.pathname === "/cancel" && !["succeeded", "failed", "cancelled"].includes(existing.status)) {
          await this.journal.update(existing.id, existing.generation, { status: "indeterminate", error: "cancel_requested_awaiting_machine_ack" });
          this.target(identity, existing.generation)?.send(JSON.stringify({ type: "cancel", request_id: existing.id, generation: existing.generation }));
        }
        return Response.json({ ok: true, result: await this.journal.get(existing.id) });
      }
      if (url.pathname === "/exec" && request.method === "POST") {
        const machine = await this.authority(identity, { action: "lookup", actorId: body.invocation.actorId }), op = body.op ?? "", params = body.params ?? {};
        if (!this.allowed(machine, body.invocation, op, params)) throw new Error("tunnel_machine_grant_denied");
        const socket = this.target(identity, machine.sequence);
        if (!socket) return Response.json({ ok: false, error: "local_machine_offline", machineId: machine.machineId }, { status: 503 });
        const active = await this.ctx.storage.get<string[]>("active_requests") ?? [];
        if (active.length >= 8 && !existing) throw new Error("tunnel_machine_concurrency_limit");
        const prepared = await this.journal.prepare({ id: body.invocation.requestId, ...identity, actorId: body.invocation.actorId, projectId: body.invocation.projectId, runId: body.invocation.runId,
          operation: op, payloadHash: await tunnelHash(JSON.stringify([op, params])), generation: machine.sequence, deadline: body.invocation.deadline, status: "prepared", nextOutputSequence: 0, outputBytes: 0, stdout: "", stderr: "", createdAt: Date.now(), updatedAt: Date.now() });
        if (!prepared.created) return this.receipt(prepared.record);
        await this.activeRequest(prepared.record.id, true);
        // Persist sent before send: a crash here is uncertain, never an automatic replay.
        await this.journal.update(prepared.record.id, machine.sequence, { status: "sent" });
        try {
          if (socket !== this.target(identity, machine.sequence) || machine.sequence !== await this.ctx.storage.get("socket_generation")) throw new Error("tunnel_socket_changed_before_dispatch");
          socket.send(JSON.stringify({ type: "request", request_id: prepared.record.id, generation: machine.sequence, op, params, invocation: body.invocation, payload_hash: prepared.record.payloadHash }));
        } catch {
          await this.journal.update(prepared.record.id, machine.sequence, { status: "indeterminate", error: "tunnel_send_outcome_unknown" });
          return this.receipt((await this.journal.get(prepared.record.id))!);
        }
        await this.ctx.storage.setAlarm(Math.min(body.invocation.deadline, Date.now() + 15000));
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.waiting.delete(prepared.record.id); resolve(); }, Math.min(25000, body.invocation.deadline - Date.now()));
          this.waiting.set(prepared.record.id, () => { clearTimeout(timer); resolve(); });
          void this.journal.get(prepared.record.id).then(record => {
            if (record && ["succeeded", "failed", "cancelled", "indeterminate"].includes(record.status)) { this.waiting.get(record.id)?.(); this.waiting.delete(record.id); }
          });
        });
        return this.receipt((await this.journal.get(prepared.record.id))!);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof RequestBodyTooLargeError ? "tunnel_request_limit" : error instanceof Error ? error.message : "tunnel_request_failed" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 403 });
    }
  }
  private receipt(record: TunnelRequestRecord): Response {
    const complete = ["succeeded", "failed", "cancelled"].includes(record.status);
    return Response.json({ ok: record.status !== "indeterminate" && record.status !== "failed" && record.status !== "cancelled", status: record.status, request_id: record.id, result: complete ? record.result
      : { status: record.status, request_id: record.id, machine_id: record.machineId, stdout: record.stdout, stderr: record.stderr },
      ...(record.error ? { error: record.error } : {}) }, { status: complete ? 200 : record.status === "indeterminate" ? 409 : 202 });
  }
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const processing = this.protocolQueue.then(() => this.receive(ws, message));
    this.protocolQueue = processing.catch(() => undefined); return processing;
  }
  private async receive(ws: WebSocket, message: string | ArrayBuffer) {
    const state = ws.deserializeAttachment() as SocketState | null;
    if (typeof message === "string" && new TextEncoder().encode(message).byteLength > 65536) { ws.close(1009, "frame too large"); return; }
    if (!state || typeof message !== "string") { ws.close(1008, "invalid frame"); return; }
    try {
      const frame = JSON.parse(message) as { type: string; generation: number; original_generation?: number; payload_hash?: string; status?: string; request_id?: string; sequence?: number; stream?: "stdout" | "stderr"; chunk?: string; ok?: boolean; result?: unknown; error?: string; cancelled?: boolean };
      if (frame.generation !== state.generation || state.generation !== await this.ctx.storage.get("socket_generation") || state.expiresAt <= Date.now()) throw new Error("tunnel_stale_socket");
      const machine = await this.authority(state, { action: "lookup" });
      if (machine.status !== "active" || machine.keyVersion !== state.keyVersion || machine.sequence !== state.generation) throw new Error("tunnel_revoked");
      if (frame.type === "heartbeat") {
        ws.serializeAttachment({ ...state, heartbeatAt: Date.now() });
        await this.authority(state, { action: "heartbeat", proof: { sequence: state.generation, keyVersion: state.keyVersion } });
        ws.send(JSON.stringify({ type: "heartbeat_ack", generation: state.generation })); return;
      }
      if (!frame.request_id) throw new Error("tunnel_request_id_required");
      if (frame.type === "reconcile") {
        const record = await this.journal.get(frame.request_id);
        if (!record) return;
        if (record.generation !== frame.original_generation || record.payloadHash !== frame.payload_hash || record.machineId !== state.machineId) throw new Error("tunnel_reconcile_identity_mismatch");
        if (!["succeeded", "failed", "cancelled", "indeterminate"].includes(frame.status ?? "")) throw new Error("tunnel_reconcile_status_invalid");
        if (new TextEncoder().encode(JSON.stringify(frame.result ?? null)).byteLength > 32768) throw new Error("tunnel_result_limit");
        await this.journal.update(record.id, record.generation, { status: frame.status as TunnelRequestRecord["status"], result: frame.result, error: frame.error?.slice(0, 2000) });
        await this.activeRequest(record.id, false); return;
      }
      if (frame.type === "output") {
        if ((await this.journal.get(frame.request_id))?.status === "indeterminate") return;
        if (typeof frame.chunk !== "string" || !Number.isSafeInteger(frame.sequence) || !["stdout", "stderr"].includes(frame.stream ?? "")) throw new Error("tunnel_output_invalid");
        await this.journal.output(frame.request_id, state.generation, frame.sequence!, frame.stream!, frame.chunk); return;
      }
      if (frame.type === "response") {
        if (new TextEncoder().encode(JSON.stringify(frame.result ?? null)).byteLength > 32768) throw new Error("tunnel_result_limit");
        await this.journal.update(frame.request_id, state.generation, { status: frame.status === "indeterminate" ? "indeterminate" : frame.cancelled ? "cancelled" : frame.ok === true ? "succeeded" : "failed", result: frame.result, error: frame.error?.slice(0, 2000) });
        await this.activeRequest(frame.request_id, false);
        this.waiting.get(frame.request_id)?.(); this.waiting.delete(frame.request_id); return;
      }
      throw new Error("tunnel_frame_unknown");
    } catch { ws.close(1008, "invalid or revoked machine frame"); await this.disconnectGeneration(state, state.generation, "socket_untrusted_or_revoked"); }
  }
  private async disconnectGeneration(identity: Identity, generation: number, reason: string) {
    for (const id of await this.ctx.storage.get<string[]>("active_requests") ?? []) {
      const record = await this.journal.get(id);
      if (record?.generation !== generation || record.machineId !== identity.machineId) continue;
      await this.journal.update(id, generation, { status: "indeterminate", error: "tunnel_" + reason + ": outcome unknown; inspect status, never replay automatically" });
      this.waiting.get(id)?.(); this.waiting.delete(id);
      await this.activeRequest(id, false);
    }
  }
  override async webSocketClose(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null;
    if (state) await this.disconnectGeneration(state, state.generation, "disconnected");
  }
  override async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws); }
  override async alarm(): Promise<void> {
    for (const [key, ticket] of await this.ctx.storage.list<{ expiresAt: number }>({ prefix: "connect-ticket:" })) {
      if (ticket.expiresAt <= Date.now()) await this.ctx.storage.delete(key);
    }
    const identity = await this.ctx.storage.get<Identity>("machine_identity");
    if (!identity) return;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state) continue;
      const machine = await this.authority(state, { action: "lookup" }).catch(() => undefined);
      if (!machine || machine.status !== "active" || machine.keyVersion !== state.keyVersion || machine.sequence !== state.generation || state.expiresAt <= Date.now() || state.heartbeatAt <= Date.now() - 45000) {
        ws.close(1008, "machine session expired or revoked"); await this.disconnectGeneration(state, state.generation, "session_expired");
      }
    }
    for (const id of await this.ctx.storage.get<string[]>("active_requests") ?? []) {
      const record = await this.journal.get(id);
      if (record && record.deadline <= Date.now()) {
        this.target(identity, record.generation)?.send(JSON.stringify({ type: "cancel", request_id: id, generation: record.generation }));
        await this.journal.update(id, record.generation, { status: "indeterminate", error: "tunnel_deadline_awaiting_machine_ack" });
        this.waiting.get(id)?.(); this.waiting.delete(id);
      }
    }
    if (this.ctx.getWebSockets().length || (await this.ctx.storage.get<string[]>("active_requests") ?? []).length) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }
  /** Anonymous inference is fail-closed; host policy must select an explicit named machine. */
  async dispatchChatCompletion(_payload?: Record<string, unknown>): Promise<{ ok: false; error: string }> {
    return { ok: false, error: "named_machine_and_inference_grant_required" };
  }
}
