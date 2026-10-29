/**
 * ConcurrencyDO (spec §28 "DO Deep Dive: ConcurrencyDO", byte ~551944) — "enforces how many
 * agent runs a user can have active simultaneously." This build wires it specifically to cap
 * simultaneous SUB-AGENT TREES per (spaceId, accountKey): the existing MAX_SUB_AGENTS_PER_SPAWN
 * (16) bounds the fan-out WITHIN one agent.spawn call; this bounds how many separate spawn
 * trees can be running AT THE SAME TIME across an account, so a runaway or malicious caller
 * can't fire off spawn-tree after spawn-tree and exhaust the account's execution capacity.
 * General enough to gate ordinary agent runs too later — same acquire/release contract the
 * spec describes for that case.
 *
 * Deadlock fix (spec gap "ConcurrencyDO — Deadlock Scenario", byte ~1602578): the spec's
 * described design leaves a slot held forever if the holder crashes before releasing. Every
 * acquired slot here carries its own TTL (expires_at) and a DO Alarm sweeps expired slots —
 * so a crashed/evicted holder's slot is reclaimed automatically, not leaked.
 *
 * Race fix (spec gap "ConcurrencyDO — check-then-insert race"): acquire() does its COUNT and
 * its INSERT in the same synchronous DO SQLite call sequence with no `await` between them, so
 * two concurrent acquire() calls can never both observe the same under-the-limit count and
 * both succeed — the DO's single-threaded execution model makes this atomic by construction.
 *
 * WS-7 (audit plan) — DO-naming exception, documented not normalized: callers address this DO by
 * a plain server-derived key (spaceId/accountKey), not the HMAC-SHA256(tenantId, secret):type:id
 * convention SpaceDO/NaelaoAgentDO use (G-BA01). Same rationale as TaskDO's exception (see its
 * file header): the key is never a raw client-supplied value forwarded as-is, so there's no
 * cross-tenant enumeration path through this worker's own API — only a compromised worker with
 * direct DO-binding access could enumerate names, already mitigated by workers_dev=false +
 * requireInternalHmac. Deferred, not dropped, pending a live-migration plan.
 */

import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { deleteBytesCas, putBytesCas } from "../script-engine/r2-cas.js";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // spec: "auto-release abandoned slots" via DO Alarms
const DEFAULT_TTL_MS = 30 * 60 * 1000; // a slot no one explicitly releases within 30m is stale
const MAX_SLOT_KEY_LENGTH = 512;
const MAX_HOLDER_ID_LENGTH = 128;
const FILE_LOCK_TTL_MS = 30_000;
const MAX_OUTBOUND_PACER_DELAY_MS = 30_000;
export const SLOT_HOLD_TTL_MS = 15_000;
export const NODE_LEASE_TTL_MS = 15_000;

export interface ConcurrencyDOEnv {
  PLATFORM_SECRET?: string;
  SCRIPTS_R2?: R2Bucket;
}

export class ConcurrencyDO extends DurableObject<ConcurrencyDOEnv> {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS slots (
        key         TEXT NOT NULL,
        holder_id   TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        PRIMARY KEY (key, holder_id)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_key ON slots(key)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_expires ON slots(expires_at)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS locks (
      key TEXT PRIMARY KEY, holder_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`);
    try { this.ctx.storage.sql.exec("ALTER TABLE locks ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS lock_fences (key TEXT PRIMARY KEY, fencing_token INTEGER NOT NULL)");
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS outbound_pacers (
      domain TEXT PRIMARY KEY, next_release_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS appointment_slot_holds (
      slot_key TEXT PRIMARY KEY, holder_id TEXT NOT NULL, acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0
    )`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_appointment_holds_expiry ON appointment_slot_holds(expires_at)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS node_leases (
      resource_key TEXT NOT NULL, node_id TEXT NOT NULL, holder_type TEXT NOT NULL CHECK(holder_type IN ('HUMAN','AGENT')),
      holder_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(resource_key,node_id)
    )`);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_node_leases_expiry ON node_leases(expires_at)");
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 1024 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    this.ensureInit();
    // First-ever slot creation on a fresh DO instance schedules the sweep; subsequent calls
    // are no-ops (setAlarm is idempotent-by-overwrite, but we only need one recurring cadence).
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/acquire") {
        return this.handleAcquire(request);
      }
      if (request.method === "POST" && url.pathname === "/release") {
        return this.handleRelease(request);
      }
      if (request.method === "GET" && url.pathname === "/status") {
        const key = url.searchParams.get("key") ?? "";
        if (!key || key.length > MAX_SLOT_KEY_LENGTH) return Response.json({ error_code: "bad_request" }, { status: 400 });
        return this.handleStatus(key);
      }
      if (request.method === "POST" && (url.pathname === "/lock/acquire" || url.pathname === "/locks/acquire")) {
        return this.acquireLock(request);
      }
      if (request.method === "POST" && (url.pathname === "/lock/release" || url.pathname === "/locks/release")) {
        return this.releaseLock(request);
      }
      if (request.method === "POST" && url.pathname === "/locks/renew") return this.renewLock(request);
      if (request.method === "POST" && ["/resource-queue/request", "/resource-queue/release", "/resource-queue/renew", "/resource-queue/cancel"].includes(url.pathname)) {
        return this.resourceQueue(request, url.pathname.split("/").at(-1)!);
      }
      if (request.method === "POST" && url.pathname === "/workspace/publish") {
        const publish = () => this.publishWorkspaceMutation(request);
        return typeof this.ctx.blockConcurrencyWhile === "function"
          ? this.ctx.blockConcurrencyWhile(publish)
          : publish();
      }
      if (request.method === "POST" && url.pathname === "/node-leases/claim") return this.claimNodeLease(request);
      if (request.method === "POST" && url.pathname === "/node-leases/renew") return this.renewNodeLease(request);
      if (request.method === "POST" && url.pathname === "/node-leases/release") return this.releaseNodeLease(request);
      if (request.method === "GET" && url.pathname === "/node-leases/status") return this.nodeLeaseStatus(url);
      if (request.method === "POST" && url.pathname === "/outbound/pace") {
        let body: unknown;
        try { body = await request.json(); } catch { return Response.json({ error_code: "bad_request" }, { status: 400 }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error_code: "bad_request" }, { status: 400 });
        const input = body as { domain?: unknown; maxPerSecond?: unknown };
        if (typeof input.domain !== "string" || (input.maxPerSecond !== undefined && typeof input.maxPerSecond !== "number")) return Response.json({ error_code: "bad_request" }, { status: 400 });
        try { return Response.json(await this.paceOutboundRequest({ domain: input.domain, ...(input.maxPerSecond === undefined ? {} : { maxPerSecond: input.maxPerSecond }) })); }
        catch (error) {
          if (error instanceof Error && error.message === "outbound_pacer_queue_full")
            return Response.json({ error_code: "pacer_queue_full" }, { status: 429 });
          return Response.json({ error_code: "bad_request" }, { status: 400 });
        }
      }
      if (request.method === "POST" && url.pathname === "/slot-holds/acquire") return this.acquireSlotHold(await request.json().catch(() => undefined));
      if (request.method === "POST" && url.pathname === "/slot-holds/confirm") return this.confirmSlotBooking(await request.json().catch(() => undefined));
      if (request.method === "POST" && url.pathname === "/slot-holds/release") return this.releaseSlotHold(await request.json().catch(() => undefined));
      return Response.json({ error_code: "not_found" }, { status: 404 });
    } catch (err) {
      return Response.json({ error_code: "internal_error", message: String(err) }, { status: 500 });
    }
  }

  /** FIFO admission primitive. Expired holders require reconciliation before the next grant. */
  private async resourceQueue(request: Request, action: string): Promise<Response> {
    const body = await request.json<{ resource?: unknown; holder?: unknown; token?: unknown; priority?: unknown; capacity?: unknown }>().catch(() => ({} as { resource?: unknown; holder?: unknown; token?: unknown; priority?: unknown; capacity?: unknown }));
    if (typeof body.resource !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/.test(body.resource) ||
        typeof body.holder !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.holder)
        || body.capacity !== undefined && (!Number.isSafeInteger(body.capacity) || (body.capacity as number) < 1 || (body.capacity as number) > 25)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const resource = body.resource, holder = body.holder;
    const storageKey = `resource-queue:${resource}`;
    const result = await this.ctx.storage.transaction(async tx => {
      type Lease = { holder: string; token: number; expiresAt: number };
      type Queue = { fence: number; capacity?: number; active?: Lease; activeLeases?: Lease[]; waiters: Array<{ holder: string; expiresAt: number; priority: number; enqueuedAt: number }> };
      const state = await tx.get<Queue>(storageKey) ?? { fence: 0, waiters: [] };
      const now = Date.now();
      const activeLeases = state.activeLeases ?? (state.active ? [state.active] : []);
      delete state.active;
      state.activeLeases = activeLeases;
      const requestedCapacity = action === "request" && typeof body.capacity === "number" ? body.capacity : state.capacity ?? 1;
      if (state.capacity === undefined) state.capacity = activeLeases.length ? 1 : requestedCapacity;
      else if (action === "request" && !activeLeases.length && !state.waiters.length) state.capacity = requestedCapacity;
      else state.capacity = Math.min(state.capacity, requestedCapacity);
      state.waiters = state.waiters.filter(item => item.expiresAt > now && !activeLeases.some(active => active.holder === item.holder));
      if (action === "renew") {
        const active = activeLeases.find(item => item.holder === holder);
        if (!active || body.token !== active.token || active.expiresAt <= now) return { renewed: false, reconciliation_required: Boolean(active) };
        active.expiresAt = now + 30_000;
        await tx.put(storageKey, state);
        return { renewed: true, token: active.token, expiresAt: active.expiresAt };
      }
      if (action === "cancel") {
        if (activeLeases.some(item => item.holder === holder)) return { cancelled: false, active: true };
        const before = state.waiters.length;
        state.waiters = state.waiters.filter(item => item.holder !== holder);
        await tx.put(storageKey, state);
        return { cancelled: state.waiters.length < before };
      }
      if (action === "release") {
        const index = activeLeases.findIndex(item => item.holder === holder && body.token === item.token);
        if (index < 0) return { released: false };
        activeLeases.splice(index, 1);
      } else if (activeLeases.some(item => item.holder === holder)) {
        const active = activeLeases.find(item => item.holder === holder)!;
        return active.expiresAt > now ? { acquired: true, token: active.token, expiresAt: active.expiresAt } : { acquired: false, reconciliation_required: true };
      } else if (!state.waiters.some(item => item.holder === holder)) {
        if (state.waiters.length >= 100) return { acquired: false, queue_full: true };
        const priority = Number.isSafeInteger(body.priority) ? Math.max(-10, Math.min(10, body.priority as number)) : 0;
        state.waiters.push({ holder, expiresAt: now + 300_000, priority, enqueuedAt: now });
      } else {
        state.waiters.find(item => item.holder === holder)!.expiresAt = now + 300_000;
      }
      while (activeLeases.length < state.capacity && state.waiters.length) {
        state.waiters.sort((a, b) => (b.priority + Math.floor((now - b.enqueuedAt) / 30_000)) - (a.priority + Math.floor((now - a.enqueuedAt) / 30_000)) || a.enqueuedAt - b.enqueuedAt);
        const next = state.waiters.shift()!;
        activeLeases.push({ holder: next.holder, token: ++state.fence, expiresAt: now + 30_000 });
      }
      await tx.put(storageKey, state);
      if (action === "release") return { released: true };
      const active = activeLeases.find(item => item.holder === holder);
      if (active) return active.expiresAt > now ? { acquired: true, token: active.token, expiresAt: active.expiresAt } : { acquired: false, reconciliation_required: true };
      return { acquired: false, position: state.waiters.findIndex(item => item.holder === holder) + 1,
        reconciliation_required: activeLeases.some(item => item.expiresAt <= now), active: activeLeases.length, capacity: state.capacity };
    });
    return Response.json(result);
  }

  /** A persisted leaky bucket: reservations survive DO eviction and are serialized by the DO. */
  async paceOutboundRequest(input: { domain: string; maxPerSecond?: number }): Promise<{ releasedAt: number; delayedMs: number }> {
    this.ensureInit();
    let domain: string;
    if (typeof input.domain !== "string" || !input.domain || input.domain.length > 512
      || (input.maxPerSecond !== undefined && (!Number.isSafeInteger(input.maxPerSecond) || input.maxPerSecond < 1))) throw new Error("invalid_pacer_input");
    try {
      const parsed = new URL(input.domain.includes("://") ? input.domain : `https://${input.domain}`);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) throw new Error("invalid_domain");
      domain = parsed.hostname.toLowerCase();
    }
    catch { throw new Error("invalid_domain"); }
    // Five requests/second is a platform safety ceiling, not merely the default.  In
    // particular, do not let an untrusted connector raise the ceiling by passing 1000 here.
    const rate = Math.min(5, input.maxPerSecond ?? 5);
    const interval = Math.ceil(1_000 / rate);
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec(`SELECT next_release_at FROM outbound_pacers WHERE domain = ?`, domain).toArray() as Array<{ next_release_at: number }>;
    const releasedAt = Math.max(now, rows[0]?.next_release_at ?? now);
    if (releasedAt - now > MAX_OUTBOUND_PACER_DELAY_MS) throw new Error("outbound_pacer_queue_full");
    this.ctx.storage.sql.exec(
      `INSERT INTO outbound_pacers (domain, next_release_at) VALUES (?, ?)
       ON CONFLICT(domain) DO UPDATE SET next_release_at=excluded.next_release_at`, domain, releasedAt + interval
    );
    const delayedMs = releasedAt - now;
    if (delayedMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayedMs));
    return { releasedAt, delayedMs };
  }

  private async acquireLock(request: Request): Promise<Response> {
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error_code: "bad_request" }, { status: 400 }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const body = value as { key?: unknown; holderId?: unknown; holder_id?: unknown; ttlMs?: unknown; ttl_ms?: unknown };
    const key = body.key;
    const holderId = body.holderId ?? body.holder_id;
    const requestedTtl = body.ttlMs ?? body.ttl_ms ?? FILE_LOCK_TTL_MS;
    if (typeof key !== "string" || !key || key.length > MAX_SLOT_KEY_LENGTH
      || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH
      || !Number.isSafeInteger(requestedTtl) || (requestedTtl as number) <= 0) return Response.json({ error_code: "bad_request" }, { status: 400 });
    // File locks are deliberately short lived. Callers may request less, never more.
    const ttlMs = Math.min(FILE_LOCK_TTL_MS, requestedTtl as number);
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec(`SELECT holder_id, expires_at, fencing_token FROM locks WHERE key = ?`, key).toArray() as Array<{ holder_id: string; expires_at: number; fencing_token?: number }>;
    const held = rows[0];
    if (held && held.expires_at > now && held.holder_id !== holderId) {
      return Response.json({ acquired: false, heldBy: held.holder_id, remainingMs: Math.max(0, held.expires_at - now) });
    }
    let fencingToken = held?.fencing_token ?? 0;
    if (!held || held.expires_at <= now || fencingToken < 1) {
      const next = this.ctx.storage.sql.exec("SELECT fencing_token FROM lock_fences WHERE key = ?", key).toArray() as Array<{ fencing_token: number }>;
      fencingToken = Math.max(next[0]?.fencing_token ?? 0, fencingToken) + 1;
      this.ctx.storage.sql.exec(`INSERT INTO lock_fences(key,fencing_token) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET fencing_token=excluded.fencing_token`, key, fencingToken);
    }
    const expiresAt = now + ttlMs;
    this.ctx.storage.sql.exec(
      `INSERT INTO locks (key, holder_id, acquired_at, expires_at, fencing_token) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET holder_id=excluded.holder_id, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, fencing_token=excluded.fencing_token`,
      key, holderId, now, expiresAt, fencingToken
    );
    await this.scheduleNextAlarm();
    return Response.json({ acquired: true, holderId, expiresAt, ttlMs, fencingToken });
  }

  private async renewLock(request: Request): Promise<Response> {
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error_code: "bad_request" }, { status: 400 }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const body = value as { key?: unknown; holderId?: unknown; fencingToken?: unknown; ttlMs?: unknown };
    const key = body.key; const holderId = body.holderId; const token = body.fencingToken;
    const requestedTtl = body.ttlMs ?? FILE_LOCK_TTL_MS;
    const now = Date.now();
    if (typeof key !== "string" || !key || key.length > MAX_SLOT_KEY_LENGTH
      || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH
      || !Number.isSafeInteger(token) || (token as number) < 1
      || !Number.isSafeInteger(requestedTtl) || (requestedTtl as number) <= 0) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const ttlMs = Math.min(FILE_LOCK_TTL_MS, requestedTtl as number);
    const expiresAt = now + ttlMs;
    const result = this.ctx.storage.sql.exec("UPDATE locks SET expires_at=? WHERE key=? AND holder_id=? AND fencing_token=? AND expires_at>?", expiresAt, key, holderId, token, now);
    await this.scheduleNextAlarm();
    return result.rowsWritten ? Response.json({ renewed: true, expiresAt, ttlMs, fencingToken: token }) : Response.json({ renewed: false, error_code: "lease_lost" }, { status: 409 });
  }

  private async publishWorkspaceMutation(request: Request): Promise<Response> {
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error_code: "bad_request" }, { status: 400 }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const body = value as { key?: unknown; holderId?: unknown; fencingToken?: unknown; path?: unknown; operation?: unknown; expectedHash?: unknown; contentBase64?: unknown; metadata?: unknown; contentType?: unknown };
    const lockKey = body.key; const holderId = body.holderId;
    const path = body.path; const token = body.fencingToken;
    const hashValid = body.expectedHash === null || (typeof body.expectedHash === "string" && /^[a-f0-9]{64}$/.test(body.expectedHash));
    let metadataBytes = 0;
    const metadataValid = body.metadata === undefined || (!!body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      && Object.entries(body.metadata as Record<string, unknown>).length <= 20
      && Object.entries(body.metadata as Record<string, unknown>).every(([key, item]) => {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof item !== "string" || item.length > 1024) return false;
        metadataBytes += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(item).byteLength;
        return metadataBytes <= 1500;
      }));
    if (typeof lockKey !== "string" || !lockKey || lockKey.length > MAX_SLOT_KEY_LENGTH
      || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH
      || typeof path !== "string" || !path.startsWith("spaces/") || new TextEncoder().encode(path).byteLength > 1024
      || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")
      || !lockKey.endsWith(`workspace-file:${path}`)
      || !Number.isSafeInteger(token) || (token as number) < 1
      || (body.operation !== "write" && body.operation !== "delete")
      || !Object.prototype.hasOwnProperty.call(body, "expectedHash") || !hashValid || !metadataValid
      || (body.contentType !== undefined && (typeof body.contentType !== "string" || body.contentType.length > 255 || /[\r\n\0]/.test(body.contentType))))
      return Response.json({ error_code: "bad_request", message: "invalid workspace CAS request" }, { status: 400 });
    if (body.operation === "write" && (typeof body.contentBase64 !== "string" || body.contentBase64.length > 1024 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)))
      return Response.json({ error_code: "bad_request", message: "invalid workspace content" }, { status: 400 });
    if (!this.env.SCRIPTS_R2) return Response.json({ error_code: "workspace_storage_unavailable" }, { status: 503 });
    const now = Date.now();
    const lease = this.ctx.storage.sql.exec("SELECT holder_id,expires_at,fencing_token FROM locks WHERE key=?", lockKey).toArray() as Array<{ holder_id: string; expires_at: number; fencing_token: number }>;
    if (lease[0]?.holder_id !== holderId || lease[0]?.fencing_token !== token || lease[0].expires_at <= now)
      return Response.json({ error_code: "lease_lost" }, { status: 409 });
    const current = await this.env.SCRIPTS_R2.head(path);
    const storedFence = Number(current?.customMetadata?.["fencingToken"] ?? 0);
    if (storedFence > token) return Response.json({ error_code: "stale_fencing_token" }, { status: 409 });
    try {
      const metadata = { ...(body.metadata as Record<string, string> | undefined), fencingToken: String(token) };
      if (body.operation === "delete") {
        const result = await deleteBytesCas(this.env.SCRIPTS_R2, path, body.expectedHash as string | null, metadata);
        return Response.json({ ...result, fencingToken: token });
      }
      const bytes = Uint8Array.from(atob(body.contentBase64 as string), (character) => character.charCodeAt(0));
      const result = await putBytesCas(this.env.SCRIPTS_R2, path, bytes, body.expectedHash as string | null, metadata, body.contentType ? { contentType: body.contentType as string } : undefined);
      return Response.json({ ...result, fencingToken: token });
    } catch {
      return Response.json({ error_code: "revision_conflict" }, { status: 409 });
    }
  }

  private async releaseLock(request: Request): Promise<Response> {
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error_code: "bad_request" }, { status: 400 }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const body = value as { key?: unknown; holderId?: unknown; holder_id?: unknown; fencingToken?: unknown };
    const key = body.key;
    const holderId = body.holderId ?? body.holder_id;
    const token = body.fencingToken;
    if (typeof key !== "string" || !key || key.length > MAX_SLOT_KEY_LENGTH
      || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH
      || !Number.isSafeInteger(token) || (token as number) < 1) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const before = this.ctx.storage.sql.exec(`SELECT holder_id,fencing_token FROM locks WHERE key = ?`, key).toArray() as Array<{ holder_id: string; fencing_token: number }>;
    this.ctx.storage.sql.exec(`DELETE FROM locks WHERE key = ? AND holder_id = ? AND fencing_token = ?`, key, holderId, token);
    await this.scheduleNextAlarm();
    return Response.json({ released: before[0]?.holder_id === holderId && before[0]?.fencing_token === token });
  }

  private parseNodeLease(body: unknown): { resourceKey: string; nodeId: string; holderId: string; holderType: "HUMAN" | "AGENT" } | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const value = body as Record<string, unknown>;
    if (typeof value.resourceKey !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/.test(value.resourceKey) ||
        typeof value.nodeId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.nodeId) ||
        typeof value.holderId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.holderId) ||
        (value.holderType !== "HUMAN" && value.holderType !== "AGENT")) return undefined;
    return { resourceKey: value.resourceKey, nodeId: value.nodeId, holderId: value.holderId, holderType: value.holderType };
  }

  private async claimNodeLease(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined);
    const lease = this.parseNodeLease(body);
    if (!lease) return Response.json({ error_code: "bad_request", message: "valid resourceKey, nodeId, holderId and holderType are required" }, { status: 400 });
    const now = Date.now();
    const current = this.ctx.storage.sql.exec("SELECT holder_type,holder_id,expires_at FROM node_leases WHERE resource_key=? AND node_id=?", lease.resourceKey, lease.nodeId).toArray() as Array<{ holder_type: "HUMAN" | "AGENT"; holder_id: string; expires_at: number }>;
    const held = current[0];
    if (held && held.expires_at > now && (held.holder_id !== lease.holderId || held.holder_type !== lease.holderType) && !(held.holder_type === "AGENT" && lease.holderType === "HUMAN")) {
      return Response.json({ acquired: false, heldBy: held.holder_id, holderType: held.holder_type, expiresAt: held.expires_at, remainingMs: held.expires_at - now }, { status: 409 });
    }
    const expiresAt = now + NODE_LEASE_TTL_MS;
    this.ctx.storage.sql.exec(`INSERT INTO node_leases(resource_key,node_id,holder_type,holder_id,acquired_at,expires_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(resource_key,node_id) DO UPDATE SET holder_type=excluded.holder_type,holder_id=excluded.holder_id,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at`,
      lease.resourceKey, lease.nodeId, lease.holderType, lease.holderId, now, expiresAt);
    await this.scheduleNextAlarm();
    return Response.json({ acquired: true, ...lease, expiresAt, ttlMs: NODE_LEASE_TTL_MS });
  }

  private async renewNodeLease(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined);
    const lease = this.parseNodeLease(body);
    if (!lease) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const now = Date.now(); const expiresAt = now + NODE_LEASE_TTL_MS;
    const result = this.ctx.storage.sql.exec("UPDATE node_leases SET expires_at=? WHERE resource_key=? AND node_id=? AND holder_type=? AND holder_id=? AND expires_at>?", expiresAt, lease.resourceKey, lease.nodeId, lease.holderType, lease.holderId, now);
    await this.scheduleNextAlarm();
    return result.rowsWritten ? Response.json({ renewed: true, expiresAt, ttlMs: NODE_LEASE_TTL_MS }) : Response.json({ renewed: false, error_code: "lease_lost" }, { status: 409 });
  }

  private async releaseNodeLease(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined);
    const lease = this.parseNodeLease(body);
    if (!lease) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const result = this.ctx.storage.sql.exec("DELETE FROM node_leases WHERE resource_key=? AND node_id=? AND holder_type=? AND holder_id=?", lease.resourceKey, lease.nodeId, lease.holderType, lease.holderId);
    await this.scheduleNextAlarm();
    return Response.json({ released: result.rowsWritten > 0 });
  }

  private nodeLeaseStatus(url: URL): Response {
    const resourceKey = url.searchParams.get("resourceKey") ?? ""; const nodeId = url.searchParams.get("nodeId") ?? "";
    if (!/^[A-Za-z0-9._:/-]{1,256}$/.test(resourceKey) || !/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const row = (this.ctx.storage.sql.exec("SELECT holder_type,holder_id,expires_at FROM node_leases WHERE resource_key=? AND node_id=?", resourceKey, nodeId).toArray() as Array<{ holder_type: string; holder_id: string; expires_at: number }>)[0];
    if (!row || row.expires_at <= Date.now()) return Response.json({ active: false });
    return Response.json({ active: true, ...row, remainingMs: row.expires_at - Date.now() });
  }

  private async scheduleNextAlarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec(`SELECT MIN(expires_at) AS expires_at FROM (
      SELECT expires_at FROM slots UNION ALL
      SELECT expires_at FROM locks UNION ALL
      SELECT expires_at FROM appointment_slot_holds WHERE confirmed=0 UNION ALL
      SELECT expires_at FROM node_leases
    )`).toArray() as Array<{ expires_at: number | null }>;
    const next = rows[0]?.expires_at;
    // Cancellation is important for ephemeral slot-hold DOs: keeping a five-minute alarm
    // alive after an explicit release needlessly bills an otherwise idle object.  Durable
    // Object alarms are authoritative, so remove the alarm rather than replacing it with a
    // polling alarm when there is nothing left to expire.
    if (next == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async acquireSlotHold(input: unknown): Promise<Response> {
    this.ensureInit();
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const holderId = body["holderId"] ?? body["holder_id"];
    const suppliedKey = body["slotKey"] ?? body["slot_key"];
    const calendarId = body["calendarId"] ?? body["calendar_id"];
    const slotIsoTime = body["slotIsoTime"] ?? body["slot_iso_time"];
    if (holderId !== undefined && (typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH)) return Response.json({ success: false, reason: "INVALID_SLOT_HOLD" }, { status: 400 });
    if (suppliedKey !== undefined && (typeof suppliedKey !== "string" || !suppliedKey || suppliedKey.length > MAX_SLOT_KEY_LENGTH)) return Response.json({ success: false, reason: "INVALID_SLOT_HOLD" }, { status: 400 });
    if ((calendarId !== undefined || slotIsoTime !== undefined) && (typeof calendarId !== "string" || !calendarId || calendarId.length > 256 || typeof slotIsoTime !== "string" || !slotIsoTime || slotIsoTime.length > 128 || !Number.isFinite(Date.parse(slotIsoTime)))) return Response.json({ success: false, reason: "INVALID_SLOT_HOLD" }, { status: 400 });
    const holderIdText = typeof holderId === "string" ? holderId : "";
    const suppliedKeyText = typeof suppliedKey === "string" ? suppliedKey : "";
    const calendarIdText = typeof calendarId === "string" ? calendarId : "";
    const slotIsoTimeText = typeof slotIsoTime === "string" ? slotIsoTime : "";
    const slotKey = suppliedKeyText || (calendarIdText && slotIsoTimeText ? `${calendarIdText}:${slotIsoTimeText}` : "");
    if (!slotKey || slotKey.length > MAX_SLOT_KEY_LENGTH || !holderIdText) return Response.json({ success: false, reason: "INVALID_SLOT_HOLD" }, { status: 400 });
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM appointment_slot_holds WHERE confirmed=0 AND expires_at <= ?", now);
    const current = this.ctx.storage.sql.exec(
      "SELECT holder_id,expires_at,confirmed FROM appointment_slot_holds WHERE slot_key=?", slotKey
    ).toArray() as Array<{ holder_id: string; expires_at: number; confirmed: number }>;
    const held = current[0];
    if (held && held.holder_id !== holderId) return Response.json({
      success: false,
      reason: held.confirmed ? "SLOT_ALREADY_BOOKED" : "SLOT_TENTATIVELY_HELD",
      remainingSeconds: held.confirmed ? null : Math.max(1, Math.ceil((held.expires_at - now) / 1000)),
    });
    if (held?.confirmed) return Response.json({ success: true, confirmed: true, slotKey });
    // An idempotent retry by the same caller observes the original lease. It must not slide
    // the expiry forward: the mutex is a strict 15-second edge hold, not a renewable lock.
    if (held) return Response.json({
      success: true, slotKey, holderId, ttlMs: SLOT_HOLD_TTL_MS,
      expiresAt: held.expires_at,
      remainingSeconds: Math.max(1, Math.ceil((held.expires_at - now) / 1000)),
    });
    const expiresAt = now + SLOT_HOLD_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO appointment_slot_holds(slot_key,holder_id,acquired_at,expires_at,confirmed) VALUES(?,?,?,?,0)
       ON CONFLICT(slot_key) DO UPDATE SET holder_id=excluded.holder_id,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at,confirmed=0`,
      slotKey, holderIdText, now, expiresAt);
    await this.scheduleNextAlarm();
    return Response.json({ success: true, slotKey, holderId: holderIdText, ttlMs: SLOT_HOLD_TTL_MS, expiresAt });
  }

  async confirmSlotBooking(input: unknown): Promise<Response> {
    this.ensureInit();
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const slotKey = body["slotKey"] ?? body["slot_key"];
    const holderId = body["holderId"] ?? body["holder_id"];
    if (typeof slotKey !== "string" || !slotKey || slotKey.length > MAX_SLOT_KEY_LENGTH || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH) return Response.json({ success: false, reason: "INVALID_SLOT_HOLD" }, { status: 400 });
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      "UPDATE appointment_slot_holds SET confirmed=1 WHERE slot_key=? AND holder_id=? AND confirmed=0 AND expires_at>?", slotKey, holderId, now);
    await this.scheduleNextAlarm();
    return Response.json(result.rowsWritten ? { success: true, confirmed: true, slotKey } : { success: false, reason: "SLOT_HOLD_NOT_OWNED" }, { status: result.rowsWritten ? 200 : 409 });
  }

  async releaseSlotHold(input: unknown): Promise<Response> {
    this.ensureInit();
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const slotKey = body["slotKey"] ?? body["slot_key"];
    const holderId = body["holderId"] ?? body["holder_id"];
    if (typeof slotKey !== "string" || !slotKey || slotKey.length > MAX_SLOT_KEY_LENGTH || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH) return Response.json({ success: false, reason: "INVALID_SLOT_HOLD" }, { status: 400 });
    const result = this.ctx.storage.sql.exec(
      "DELETE FROM appointment_slot_holds WHERE slot_key=? AND holder_id=? AND confirmed=0", slotKey, holderId);
    await this.scheduleNextAlarm();
    return Response.json({ success: true, released: result.rowsWritten > 0 });
  }

  private async handleAcquire(request: Request): Promise<Response> {
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error_code: "bad_request" }, { status: 400 }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const body = value as { key?: unknown; holder_id?: unknown; limit?: unknown; ttl_ms?: unknown };
    const key = body.key;
    const holderId = body.holder_id;
    if (typeof key !== "string" || !key || key.length > MAX_SLOT_KEY_LENGTH
      || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH) {
      return Response.json({ error_code: "bad_request", message: "key and holder_id must be bounded non-empty strings" }, { status: 400 });
    }
    if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1)) {
      return Response.json({ error_code: "bad_request", message: "limit must be a positive integer" }, { status: 400 });
    }
    const limit = body.limit === undefined ? 3 : Math.min(body.limit as number, 100); // one key cannot be configured above 100 slots
    if (body.ttl_ms !== undefined && (!Number.isSafeInteger(body.ttl_ms) || (body.ttl_ms as number) <= 0)) {
      return Response.json({ error_code: "bad_request", message: "ttl_ms must be a positive integer" }, { status: 400 });
    }
    const ttlMs = body.ttl_ms === undefined ? DEFAULT_TTL_MS : Math.min(body.ttl_ms as number, DEFAULT_TTL_MS);

    const now = Date.now();
    // Sweep this key's own stale slots inline too — bounds worst-case staleness to one
    // acquire() call even between alarm ticks, without waiting on the alarm cadence.
    this.ctx.storage.sql.exec(`DELETE FROM slots WHERE key = ? AND expires_at < ?`, key, now);

    // Idempotent re-acquire: a holder that already has this key's slot just extends its TTL.
    const already = this.ctx.storage.sql.exec(`SELECT 1 FROM slots WHERE key = ? AND holder_id = ?`, key, holderId).toArray();
    if (already.length > 0) {
      this.ctx.storage.sql.exec(`UPDATE slots SET expires_at = ? WHERE key = ? AND holder_id = ?`, now + ttlMs, key, holderId);
      return Response.json({ granted: true, active: this.countActive(key) });
    }

    // No `await` between this COUNT and the INSERT below — atomic against concurrent acquire()
    // calls for the same key (DO's single-threaded execution model).
    const active = this.countActive(key);
    if (active >= limit) {
      return Response.json({ granted: false, active, limit });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO slots (key, holder_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)`,
      key, holderId, now, now + ttlMs
    );
    return Response.json({ granted: true, active: active + 1, limit });
  }

  private async handleRelease(request: Request): Promise<Response> {
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error_code: "bad_request" }, { status: 400 }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error_code: "bad_request" }, { status: 400 });
    const body = value as { key?: unknown; holder_id?: unknown };
    const key = body.key;
    const holderId = body.holder_id;
    if (typeof key !== "string" || !key || key.length > MAX_SLOT_KEY_LENGTH
      || typeof holderId !== "string" || !holderId || holderId.length > MAX_HOLDER_ID_LENGTH) return Response.json({ error_code: "bad_request" }, { status: 400 });
    this.ctx.storage.sql.exec(`DELETE FROM slots WHERE key = ? AND holder_id = ?`, key, holderId);
    return Response.json({ released: true });
  }

  private handleStatus(key: string): Response {
    return Response.json({ key, active: this.countActive(key) });
  }

  private countActive(key: string): number {
    const rows = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS c FROM slots WHERE key = ? AND expires_at > ?`, key, Date.now()).toArray() as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  }

  // Deadlock fix: reclaim any slot whose TTL lapsed without an explicit release (holder
  // crashed, was evicted, or simply never called back) — spec gap "ConcurrencyDO — Deadlock
  // Scenario" closed.
  override async alarm(): Promise<void> {
    this.ensureInit();
    this.ctx.storage.sql.exec(`DELETE FROM slots WHERE expires_at < ?`, Date.now());
    this.ctx.storage.sql.exec(`DELETE FROM locks WHERE expires_at <= ?`, Date.now());
    this.ctx.storage.sql.exec(`DELETE FROM appointment_slot_holds WHERE confirmed=0 AND expires_at <= ?`, Date.now());
    this.ctx.storage.sql.exec(`DELETE FROM node_leases WHERE expires_at <= ?`, Date.now());
    await this.scheduleNextAlarm();
  }
}
