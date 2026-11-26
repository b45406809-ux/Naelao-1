// MS-38 (V-spec MR-REC-2/3, MR-SEC-4): inventory and cost reconciliation findings. Behind MANAGED_RECONCILIATION_ENABLED.
//
// - Daily inventory sweep: every adapter that exposes `listUpstreamResources` is compared with `managed_service_accounts`.
//   Output is `orphaned_upstream`, `missing_upstream` or `state_mismatch` findings. Findings are the only effect: nothing is ever
//   deleted, suspended or changed upstream or locally. A listing that fails or is truncated writes and resolves nothing.
// - Monthly cost comparison: operator-imported provider cost receipts (0192) against settled Managed reservations (0180) per
//   provider and service/offering, in USD at the platform credit rate. Findings feed the operator queue; nothing is charged or refunded.
// - Findings are deduplicated by a unique key, so repeated sweeps update `last_seen_at`/`seen_count` instead of adding rows. A finding
//   whose condition no longer reproduces is marked resolved by the sweep; an acknowledged one stays acknowledged until then.
import { CREDITS_PER_USD } from "@naelao/billing-core";
import type { AgentsEnv } from "../index.js";
import type { ProviderAdapterV1, ProviderResource } from "./providers/contract.js";

export const FINDING_KINDS = ["orphaned_upstream", "missing_upstream", "state_mismatch", "cost_discrepancy"] as const;
export type FindingKind = typeof FINDING_KINDS[number];
export type FindingStatus = "open" | "acknowledged" | "resolved";
const INVENTORY_KINDS: FindingKind[] = ["orphaned_upstream", "missing_upstream", "state_mismatch"];

export const MAX_INVENTORY_PAGES = 50;
export const MAX_INVENTORY_RESOURCES = 10_000;
/** 1 credit = $0.01 = 10,000 micro-USD (CREDITS_PER_USD is the platform's single conversion). */
export const MICROS_PER_CREDIT = 1_000_000 / CREDITS_PER_USD;
/** Lifecycle states in which a registry row is expected to exist upstream. */
const LIVE_STATES = ["active", "billing_hold", "suspended", "retirement_review_required"];
/** Lifecycle states in which the registry says the resource is gone (or going), so an active upstream copy is a mismatch. */
const GONE_STATES = ["retired", "revoked"];

export type Db = AgentsEnv["PLATFORM_DB"];
export function managedReconciliationEnabled(env: Pick<AgentsEnv, "MANAGED_RECONCILIATION_ENABLED">) {
  return env.MANAGED_RECONCILIATION_ENABLED === "true";
}

/** Findings must not carry credentials (MR-SEC-4): scrub key-shaped values from every string before it is stored. */
export function scrubSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\b(?:nem|whsec|sk|pk|rk|key)_[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(scrubSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50)
      .filter(([key]) => !/secret|token|password|credential|api_?key|authorization/i.test(key)).map(([key, item]) => [key, scrubSecrets(item)]));
  }
  return value;
}

export type FindingInput = {
  kind: FindingKind; provider: string; serviceId?: string | null; offeringId?: string | null; tenantId?: string | null;
  accountId?: string | null; resourceRef?: string | null; period?: string | null; dedupKey: string; detail: Record<string, unknown>;
};

/** Inserts the finding once; later sightings refresh it (and reopen a resolved one). Returns "created" or "seen". */
export async function recordFinding(db: Db, input: FindingInput, nowMs: number): Promise<"created" | "seen"> {
  const detail = JSON.stringify(scrubSecrets(input.detail));
  const inserted = await db.prepare(`INSERT OR IGNORE INTO managed_service_reconciliation_findings(
    id,kind,provider,service_id,offering_id,tenant_id,account_id,resource_ref,period,detail_json,status,dedup_key,seen_count,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'open',?,1,?,?,?,?)`)
    .bind(`mrf_${crypto.randomUUID().replaceAll("-", "")}`, input.kind, input.provider, input.serviceId ?? null, input.offeringId ?? null, input.tenantId ?? null,
      input.accountId ?? null, input.resourceRef ?? null, input.period ?? null, detail, input.dedupKey, nowMs, nowMs, nowMs, nowMs).run();
  if (inserted.meta.changes > 0) return "created";
  await db.prepare(`UPDATE managed_service_reconciliation_findings SET seen_count=seen_count+1,last_seen_at=?,detail_json=?,updated_at=?,
      offering_id=COALESCE(?,offering_id),tenant_id=COALESCE(?,tenant_id),account_id=COALESCE(?,account_id),
      status=CASE WHEN status='resolved' THEN 'open' ELSE status END,
      resolved_at=CASE WHEN status='resolved' THEN NULL ELSE resolved_at END,resolved_by=CASE WHEN status='resolved' THEN NULL ELSE resolved_by END
    WHERE dedup_key=?`).bind(nowMs, detail, nowMs, input.offeringId ?? null, input.tenantId ?? null, input.accountId ?? null, input.dedupKey).run();
  return "seen";
}

async function resolveUnseen(db: Db, where: { provider: string; serviceId: string; kinds: FindingKind[] }, seen: Set<string>, nowMs: number) {
  const placeholders = where.kinds.map(() => "?").join(",");
  const open = await db.prepare(`SELECT id,dedup_key FROM managed_service_reconciliation_findings
    WHERE provider=? AND service_id=? AND kind IN (${placeholders}) AND status IN ('open','acknowledged')`)
    .bind(where.provider, where.serviceId, ...where.kinds).all<{ id: string; dedup_key: string }>();
  let resolved = 0;
  for (const row of open.results) {
    if (seen.has(row.dedup_key)) continue;
    const result = await db.prepare("UPDATE managed_service_reconciliation_findings SET status='resolved',resolved_at=?,resolved_by='sweep',updated_at=? WHERE id=? AND status IN ('open','acknowledged')")
      .bind(nowMs, nowMs, row.id).run();
    resolved += result.meta.changes;
  }
  return resolved;
}

/** Claims a sweep period; false when another tick already ran or is running it. */
async function claimRun(db: Db, kind: "inventory" | "cost", period: string, nowMs: number) {
  const claimed = await db.prepare("INSERT OR IGNORE INTO managed_service_reconciliation_runs(kind,period,status,started_at) VALUES(?,?,'running',?)").bind(kind, period, nowMs).run();
  return claimed.meta.changes > 0;
}
const completeRun = (db: Db, kind: string, period: string, summary: unknown, nowMs: number) =>
  db.prepare("UPDATE managed_service_reconciliation_runs SET status='complete',summary_json=?,finished_at=? WHERE kind=? AND period=?").bind(JSON.stringify(summary), nowMs, kind, period).run();
/** A failed sweep gives its claim back so the next cron tick retries it. */
const releaseRun = (db: Db, kind: string, period: string) =>
  db.prepare("DELETE FROM managed_service_reconciliation_runs WHERE kind=? AND period=? AND status='running'").bind(kind, period).run();

export type InventoryAdapter = { provider: string; serviceId: string; adapter: ProviderAdapterV1 };
export type InventorySweepResult = { adapters: number; skipped: number; failed: number; truncated: number; created: number; seen: number; resolved: number };

type AccountRow = { id: string; tenant_id: string; provider_resource_ref: string; lifecycle_state: string; offering_id: string | null };

/** Lists every upstream resource of one adapter, or null if the listing failed or was cut off (then nothing is compared). */
async function listAll(adapter: ProviderAdapterV1): Promise<ProviderResource[] | null> {
  const all: ProviderResource[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
    const result = await adapter.listUpstreamResources!(cursor);
    if (!result || !Array.isArray(result.items)) return null;
    all.push(...result.items);
    if (all.length > MAX_INVENTORY_RESOURCES) return null;
    if (!result.next_cursor) return all;
    if (result.next_cursor === cursor) return null;
    cursor = result.next_cursor;
  }
  return null;
}

export async function sweepManagedInventory(env: Pick<AgentsEnv, "PLATFORM_DB">, adapters: InventoryAdapter[], now = new Date()): Promise<InventorySweepResult> {
  const db = env.PLATFORM_DB, nowMs = now.getTime();
  const result: InventorySweepResult = { adapters: 0, skipped: 0, failed: 0, truncated: 0, created: 0, seen: 0, resolved: 0 };
  for (const entry of adapters) {
    if (typeof entry.adapter.listUpstreamResources !== "function") { result.skipped++; continue; }
    result.adapters++;
    let upstream: ProviderResource[] | null;
    try { upstream = await listAll(entry.adapter); } catch { result.failed++; continue; }
    if (!upstream) { result.truncated++; continue; }
    const accounts = (await db.prepare(`SELECT id,tenant_id,provider_resource_ref,lifecycle_state,offering_id FROM managed_service_accounts
      WHERE provider=? AND service_id=?`).bind(entry.provider, entry.serviceId).all<AccountRow>()).results;
    const byRef = new Map(accounts.map(account => [account.provider_resource_ref, account]));
    const upstreamByRef = new Map(upstream.filter(r => r.provider === entry.provider && r.service_id === entry.serviceId).map(r => [r.provider_resource_ref, r]));
    const seenKeys = new Set<string>();
    const note = async (input: FindingInput) => {
      seenKeys.add(input.dedupKey);
      (await recordFinding(db, input, nowMs)) === "created" ? result.created++ : result.seen++;
    };
    const base = { provider: entry.provider, serviceId: entry.serviceId };
    const key = (kind: FindingKind, ref: string) => `${kind}:${entry.provider}:${entry.serviceId}:${ref}`;

    for (const resource of upstreamByRef.values()) {
      const account = byRef.get(resource.provider_resource_ref);
      const ref = resource.provider_resource_ref;
      if (!account) {
        // Upstream has it, the registry does not. A deleted upstream copy needs no attention.
        if (resource.status === "active") await note({ ...base, kind: "orphaned_upstream", resourceRef: ref, dedupKey: key("orphaned_upstream", ref),
          detail: { upstream_status: resource.status, resource_type: resource.resource_type, ...(resource.address ? { address: resource.address } : {}) } });
        continue;
      }
      if ((resource.status === "active" && GONE_STATES.includes(account.lifecycle_state))
        || (resource.status === "deleted" && LIVE_STATES.includes(account.lifecycle_state))) {
        await note({ ...base, kind: "state_mismatch", resourceRef: ref, accountId: account.id, tenantId: account.tenant_id, offeringId: account.offering_id,
          dedupKey: key("state_mismatch", ref), detail: { upstream_status: resource.status, local_lifecycle_state: account.lifecycle_state } });
      }
    }
    for (const account of accounts) {
      if (!LIVE_STATES.includes(account.lifecycle_state) || upstreamByRef.has(account.provider_resource_ref)) continue;
      await note({ ...base, kind: "missing_upstream", resourceRef: account.provider_resource_ref, accountId: account.id, tenantId: account.tenant_id,
        offeringId: account.offering_id, dedupKey: key("missing_upstream", account.provider_resource_ref), detail: { local_lifecycle_state: account.lifecycle_state } });
    }
    result.resolved += await resolveUnseen(db, { provider: entry.provider, serviceId: entry.serviceId, kinds: INVENTORY_KINDS }, seenKeys, nowMs);
  }
  return result;
}

export type CostSweepResult = { period: string; groups: number; created: number; seen: number; resolved: number };

/** Previous UTC month as [start, end) ISO strings plus its 'YYYY-MM' label. */
export function previousMonthWindow(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { period: start.toISOString().slice(0, 7), start, end };
}

type CostGroup = { provider: string; service_id: string; currency: string; cost_micros: number; receipts: number };
type SettleGroup = { provider: string; service_id: string; credits: number; reservations: number };

export async function sweepManagedCostComparison(env: Pick<AgentsEnv, "PLATFORM_DB">, now = new Date()): Promise<CostSweepResult> {
  const db = env.PLATFORM_DB, nowMs = now.getTime();
  const { period, start, end } = previousMonthWindow(now);
  const receipts = (await db.prepare(`SELECT provider,service_id,currency,SUM(provider_cost_micros) AS cost_micros,COUNT(*) AS receipts
    FROM managed_service_provider_cost_receipts WHERE period_start>=? AND period_end<=? GROUP BY provider,service_id,currency`)
    .bind(start.toISOString(), end.toISOString()).all<CostGroup>()).results;
  const settled = (await db.prepare(`SELECT provider,service_id,SUM(settled_credits) AS credits,COUNT(*) AS reservations
    FROM managed_service_credit_reservations WHERE status='settled' AND settled_at>=? AND settled_at<? GROUP BY provider,service_id`)
    .bind(start.toISOString(), end.toISOString()).all<SettleGroup>()).results;
  const settledBy = new Map(settled.map(row => [`${row.provider}\0${row.service_id}`, row]));
  const result: CostSweepResult = { period, groups: 0, created: 0, seen: 0, resolved: 0 };
  const seenKeys = new Set<string>();
  const offerings = async (provider: string, serviceId: string) => {
    const rows = (await db.prepare("SELECT id FROM managed_service_offerings WHERE provider=? AND service_id=?").bind(provider, serviceId).all<{ id: string }>()).results;
    return rows.length === 1 ? rows[0]!.id : null;
  };
  const note = async (input: FindingInput) => {
    seenKeys.add(input.dedupKey);
    (await recordFinding(db, input, nowMs)) === "created" ? result.created++ : result.seen++;
  };
  const groups = new Set([...receipts.map(r => `${r.provider}\0${r.service_id}`), ...settled.map(r => `${r.provider}\0${r.service_id}`)]);
  for (const group of groups) {
    const [provider, serviceId] = group.split("\0") as [string, string];
    result.groups++;
    const offeringId = await offerings(provider, serviceId);
    const groupReceipts = receipts.filter(r => r.provider === provider && r.service_id === serviceId);
    const settle = settledBy.get(group);
    const settledCredits = Number(settle?.credits ?? 0);
    const settledMicros = settledCredits * MICROS_PER_CREDIT;
    const common = { kind: "cost_discrepancy" as const, provider, serviceId, offeringId, period };
    const key = (reason: string) => `cost_discrepancy:${provider}:${serviceId}:${period}:${reason}`;
    const usd = groupReceipts.find(r => r.currency === "USD");
    const other = groupReceipts.filter(r => r.currency !== "USD");
    if (other.length) await note({ ...common, dedupKey: key("currency_not_comparable"), detail: { reason: "currency_not_comparable",
      currencies: other.map(r => ({ currency: r.currency, provider_cost_micros: Number(r.cost_micros), receipts: Number(r.receipts) })), settled_credits: settledCredits } });
    const usdMicros = Number(usd?.cost_micros ?? 0);
    const detail = { provider_cost_micros_usd: usdMicros, settled_credits: settledCredits, settled_micros_usd: settledMicros,
      receipts: Number(usd?.receipts ?? 0), reservations: Number(settle?.reservations ?? 0), credits_per_usd: CREDITS_PER_USD };
    if (usd && usdMicros > 0 && settledCredits === 0) await note({ ...common, dedupKey: key("cost_without_settlements"), detail: { reason: "cost_without_settlements", ...detail } });
    else if (usd && usdMicros > settledMicros) await note({ ...common, dedupKey: key("negative_margin"), detail: { reason: "negative_margin", margin_micros_usd: settledMicros - usdMicros, ...detail } });
    if (settledCredits > 0 && !usd && !other.length) await note({ ...common, dedupKey: key("settlements_without_cost_receipts"), detail: { reason: "settlements_without_cost_receipts", ...detail } });
  }
  // Findings for this period that no longer reproduce (late receipts imported, charges corrected) are resolved by the sweep.
  const open = await db.prepare("SELECT id,dedup_key FROM managed_service_reconciliation_findings WHERE kind='cost_discrepancy' AND period=? AND status IN ('open','acknowledged')")
    .bind(period).all<{ id: string; dedup_key: string }>();
  for (const row of open.results) {
    if (seenKeys.has(row.dedup_key)) continue;
    result.resolved += (await db.prepare("UPDATE managed_service_reconciliation_findings SET status='resolved',resolved_at=?,resolved_by='sweep',updated_at=? WHERE id=?").bind(nowMs, nowMs, row.id).run()).meta.changes;
  }
  return result;
}

/** Cost comparison waits until day 3 of the month so statements for the previous month can be imported first. */
export const COST_SWEEP_FIRST_DAY = 3;

export type ReconciliationSweepResult = { inventory?: InventorySweepResult; cost?: CostSweepResult };

/** Cron entry point: flag off is a no-op; each period runs once (claimed in D1), and a failure releases the claim for the next tick. */
export async function sweepManagedReconciliation(env: Pick<AgentsEnv, "PLATFORM_DB" | "MANAGED_RECONCILIATION_ENABLED">, adapters: InventoryAdapter[], now = new Date()): Promise<ReconciliationSweepResult> {
  if (!managedReconciliationEnabled(env)) return {};
  const db = env.PLATFORM_DB, nowMs = now.getTime(), out: ReconciliationSweepResult = {};
  const day = now.toISOString().slice(0, 10);
  if (await claimRun(db, "inventory", day, nowMs)) {
    try { out.inventory = await sweepManagedInventory(env, adapters, now); await completeRun(db, "inventory", day, out.inventory, nowMs); }
    catch (error) { await releaseRun(db, "inventory", day); throw error; }
  }
  if (now.getUTCDate() >= COST_SWEEP_FIRST_DAY) {
    const { period } = previousMonthWindow(now);
    if (await claimRun(db, "cost", period, nowMs)) {
      try { out.cost = await sweepManagedCostComparison(env, now); await completeRun(db, "cost", period, out.cost, nowMs); }
      catch (error) { await releaseRun(db, "cost", period); throw error; }
    }
  }
  return out;
}

// ---- Operator read / acknowledge (MS-28 operator auth is applied by the route) ----

export class FindingsError extends Error { constructor(readonly code: string, readonly status: 400 | 404) { super(code); } }
const FINDING_COLUMNS = "id,kind,provider,service_id,offering_id,tenant_id,account_id,resource_ref,period,detail_json,status,seen_count,first_seen_at,last_seen_at,acknowledged_by,acknowledged_at,acknowledgement_reason,resolved_at,resolved_by";
const shape = (row: Record<string, unknown>) => ({ ...row, detail: JSON.parse(String(row.detail_json ?? "{}")), detail_json: undefined });

export async function listFindings(db: Db, q: { status?: string | null; kind?: string | null; provider?: string | null; limit?: string | null; cursor?: string | null }) {
  const status = q.status || null, kind = q.kind || null, provider = q.provider || null;
  if ((status && !["open", "acknowledged", "resolved"].includes(status)) || (kind && !(FINDING_KINDS as readonly string[]).includes(kind))
    || (provider && !/^[a-z][a-z0-9_-]{1,63}$/.test(provider))) throw new FindingsError("findings_query_invalid", 400);
  const limit = q.limit === undefined || q.limit === null || q.limit === "" ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new FindingsError("findings_query_invalid", 400);
  const cursor = q.cursor ? Number(q.cursor.split(":")[0]) : null, cursorId = q.cursor ? q.cursor.split(":")[1] ?? "" : "";
  if (q.cursor && (!Number.isSafeInteger(cursor) || !/^mrf_[a-f0-9]{32}$/.test(cursorId))) throw new FindingsError("findings_query_invalid", 400);
  const rows = (await db.prepare(`SELECT ${FINDING_COLUMNS} FROM managed_service_reconciliation_findings
    WHERE (?1 IS NULL OR status=?1) AND (?2 IS NULL OR kind=?2) AND (?3 IS NULL OR provider=?3)
      AND (?4 IS NULL OR last_seen_at<?4 OR (last_seen_at=?4 AND id<?5))
    ORDER BY last_seen_at DESC,id DESC LIMIT ?6`).bind(status, kind, provider, cursor, cursorId, limit + 1).all<Record<string, unknown>>()).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { findings: page.map(shape), ...(rows.length > limit && last ? { next_cursor: `${last.last_seen_at}:${last.id}` } : {}) };
}

/** Open -> acknowledged with the operator's id and reason. Replays are idempotent; a resolved finding cannot be acknowledged. */
export async function acknowledgeFinding(db: Db, input: { id: string; actorId: unknown; reason: unknown; now?: Date }) {
  if (typeof input.actorId !== "string" || !/^[A-Za-z0-9._:@-]{1,160}$/.test(input.actorId)) throw new FindingsError("findings_actor_invalid", 400);
  if (typeof input.reason !== "string" || input.reason.trim().length < 10 || input.reason.length > 500) throw new FindingsError("findings_reason_invalid", 400);
  if (!/^mrf_[a-f0-9]{32}$/.test(input.id)) throw new FindingsError("not_found", 404);
  const nowMs = (input.now ?? new Date()).getTime();
  await db.prepare("UPDATE managed_service_reconciliation_findings SET status='acknowledged',acknowledged_by=?,acknowledged_at=?,acknowledgement_reason=?,updated_at=? WHERE id=? AND status='open'")
    .bind(input.actorId, nowMs, input.reason.trim(), nowMs, input.id).run();
  const row = await db.prepare(`SELECT ${FINDING_COLUMNS} FROM managed_service_reconciliation_findings WHERE id=?`).bind(input.id).first<Record<string, unknown>>();
  if (!row) throw new FindingsError("not_found", 404);
  return { finding: shape(row) };
}
