// MS-38: inventory and cost reconciliation findings. Local/mock only: the fixture is in-memory SQLite with the real migrations, adapters are
// fakes (plus the real Naelao Email app for the list route), and no provider is called.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";
import emailApp from "../../../email/src/index.js";
import { createInbox, fixture as emailFixture, seedTenant, SECRET, type Fixture as EmailFixture } from "../../../email/src/test-helpers.js";
import { createNaelaoEmailAdapter } from "./providers/naelao-email.js";
import type { ProviderAdapterV1, ProviderResource } from "./providers/contract.js";
import {
  MICROS_PER_CREDIT, managedReconciliationEnabled, previousMonthWindow, recordFinding, scrubSecrets, sweepManagedCostComparison,
  sweepManagedInventory, sweepManagedReconciliation, type InventoryAdapter,
} from "./managed-reconciliation-findings.js";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../infra/migrations", name), "utf8");
const OPERATOR = "operator-test-secret";
const NOW = new Date("2026-12-04T03:00:00Z");

function harness(flag: string | null = "true") {
  const f = fixture();
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0292_managed_offering_testing_allowlist_and_telnyx_classification.sql", "0303_managed_service_reconciliation_findings.sql"]) f.db.db.exec(migration(name));
  const env = f.env as unknown as AgentsEnv & Record<string, unknown>;
  env.MANAGED_SERVICES_OPERATOR_SECRET = OPERATOR;
  if (flag !== null) env.MANAGED_RECONCILIATION_ENABLED = flag;
  const sql = f.db.db;
  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerCommunicationRoutes(app);
  const call = (method: string, path: string, body?: unknown, key = OPERATOR, actor = "operator-1") => app.fetch(new Request(`https://agents.test/internal/managed-services/${path}`, {
    method, headers: { "content-type": "application/json", "x-managed-services-operator-key": key, "x-managed-services-operator-id": actor },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const account = (id: string, ref: string, lifecycle = "active", over: { tenant?: string; provider?: string; service?: string } = {}) => sql.prepare(`INSERT INTO managed_service_accounts(
    id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,owner_type,owner_id,provider_payer_type,lifecycle_state,created_at,updated_at)
    VALUES(?,?,?,?,?,'naelao_managed',?,'organization',?,'platform',?,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`)
    .run(id, over.tenant ?? "tenant-1", "space-1", over.provider ?? "fakeprov", over.service ?? "fake", ref, over.tenant ?? "tenant-1", lifecycle);
  const findings = () => sql.prepare("SELECT kind,status,resource_ref,tenant_id,account_id,seen_count,detail_json FROM managed_service_reconciliation_findings ORDER BY dedup_key").all() as Array<Record<string, unknown>>;
  const count = (table: string) => (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { ...f, env, sql, call, account, findings, count };
}

const resource = (ref: string, status: "active" | "deleted" = "active", over: Partial<ProviderResource> = {}): ProviderResource =>
  ({ provider: "fakeprov", service_id: "fake", resource_type: "thing", provider_resource_ref: ref, status, ...over });

/** A fake adapter listing the given resources in pages of `pageSize`, recording every call (to prove it only lists). */
function fakeAdapter(resources: () => ProviderResource[], pageSize = 100, fail = false) {
  const calls: Array<string | undefined> = [];
  const adapter = {
    provider: "fakeprov", capabilities: () => [], lookup: async () => null, execute: async () => { throw new Error("must not execute"); },
    deprovision: async () => { throw new Error("must not deprovision"); },
    async listUpstreamResources(cursor?: string) {
      calls.push(cursor);
      if (fail) throw new Error("upstream down");
      const all = resources(), start = cursor ? Number(cursor) : 0;
      return { items: all.slice(start, start + pageSize), ...(start + pageSize < all.length ? { next_cursor: String(start + pageSize) } : {}) };
    },
  } as unknown as ProviderAdapterV1;
  const entry: InventoryAdapter = { provider: "fakeprov", serviceId: "fake", adapter };
  return { entry, calls, adapter };
}

describe("MS-38 flag and wiring", () => {
  it("is off unless the flag is exactly true, and a flag-off sweep does nothing", async () => {
    expect(managedReconciliationEnabled({})).toBe(false);
    expect(managedReconciliationEnabled({ MANAGED_RECONCILIATION_ENABLED: "false" })).toBe(false);
    expect(managedReconciliationEnabled({ MANAGED_RECONCILIATION_ENABLED: "true" })).toBe(true);
    const h = harness("false");
    const a = fakeAdapter(() => [resource("r1")]);
    expect(await sweepManagedReconciliation(h.env, [a.entry], NOW)).toEqual({});
    expect(a.calls).toHaveLength(0);
    expect(h.count("managed_service_reconciliation_findings")).toBe(0);
    expect(h.count("managed_service_reconciliation_runs")).toBe(0);
  });
});

describe("MS-38 inventory sweep", () => {
  it("finds a seeded orphan, missing resource and state mismatch exactly once across repeated sweeps", async () => {
    const h = harness();
    h.account("acc-ok", "ok"); h.account("acc-missing", "gone"); h.account("acc-retired", "was-retired", "retired");
    const a = fakeAdapter(() => [resource("ok"), resource("stray"), resource("was-retired")]);
    const first = await sweepManagedInventory(h.env, [a.entry], NOW);
    expect(first).toMatchObject({ adapters: 1, created: 3, seen: 0, failed: 0 });
    const second = await sweepManagedInventory(h.env, [a.entry], new Date(NOW.getTime() + 86_400_000));
    expect(second).toMatchObject({ created: 0, seen: 3 });
    expect(h.findings()).toEqual([
      expect.objectContaining({ kind: "missing_upstream", resource_ref: "gone", tenant_id: "tenant-1", account_id: "acc-missing", status: "open", seen_count: 2 }),
      expect.objectContaining({ kind: "orphaned_upstream", resource_ref: "stray", tenant_id: null, account_id: null, status: "open", seen_count: 2 }),
      expect.objectContaining({ kind: "state_mismatch", resource_ref: "was-retired", tenant_id: "tenant-1", account_id: "acc-retired", status: "open", seen_count: 2 }),
    ]);
  });

  it("treats an upstream-deleted resource behind a live account as a mismatch, and ignores deleted orphans", async () => {
    const h = harness();
    h.account("acc-1", "r1");
    const a = fakeAdapter(() => [resource("r1", "deleted"), resource("old-orphan", "deleted")]);
    await sweepManagedInventory(h.env, [a.entry], NOW);
    expect(h.findings().map(f => [f.kind, f.resource_ref])).toEqual([["state_mismatch", "r1"]]);
  });

  it("never deletes or changes anything: only lists upstream, leaves every account row untouched", async () => {
    const h = harness();
    h.account("acc-missing", "gone"); h.account("acc-retired", "was-retired", "retired");
    const before = JSON.stringify(h.sql.prepare("SELECT * FROM managed_service_accounts ORDER BY id").all());
    const a = fakeAdapter(() => [resource("stray"), resource("was-retired")]);
    await sweepManagedInventory(h.env, [a.entry], NOW);
    expect(JSON.stringify(h.sql.prepare("SELECT * FROM managed_service_accounts ORDER BY id").all())).toBe(before);
    expect(a.calls).toEqual([undefined]); // listed, nothing else (deprovision/execute throw if called)
  });

  it("walks every page, and a resource on a later page is not reported missing", async () => {
    const h = harness();
    const refs = Array.from({ length: 7 }, (_, i) => `r${i}`);
    refs.forEach((ref, i) => h.account(`acc-${i}`, ref));
    const a = fakeAdapter(() => refs.map(r => resource(r)), 3);
    expect(await sweepManagedInventory(h.env, [a.entry], NOW)).toMatchObject({ created: 0 });
    expect(a.calls).toEqual([undefined, "3", "6"]);
    expect(h.count("managed_service_reconciliation_findings")).toBe(0);
  });

  it("resolves findings that stop reproducing, reopens a recurrence, and keeps an acknowledged one until it clears", async () => {
    const h = harness();
    let upstream = [resource("stray")];
    const a = fakeAdapter(() => upstream);
    await sweepManagedInventory(h.env, [a.entry], NOW);
    const id = (h.sql.prepare("SELECT id FROM managed_service_reconciliation_findings").get() as { id: string }).id;
    expect((await h.call("POST", `reconciliation-findings/${id}/acknowledge`, { reason: "Known test inbox, will be cleaned up." })).status).toBe(200);
    await sweepManagedInventory(h.env, [a.entry], NOW);
    expect(h.findings()[0]).toMatchObject({ status: "acknowledged", seen_count: 2 });
    upstream = [];
    expect(await sweepManagedInventory(h.env, [a.entry], NOW)).toMatchObject({ resolved: 1 });
    expect(h.findings()[0]).toMatchObject({ status: "resolved" });
    upstream = [resource("stray")];
    await sweepManagedInventory(h.env, [a.entry], NOW);
    expect(h.findings()).toEqual([expect.objectContaining({ status: "open", seen_count: 3 })]);
    expect(h.count("managed_service_reconciliation_findings")).toBe(1);
  });

  it("writes nothing and resolves nothing when the listing fails or is truncated", async () => {
    const h = harness();
    h.account("acc-1", "r1");
    await recordFinding(h.env.PLATFORM_DB, { kind: "missing_upstream", provider: "fakeprov", serviceId: "fake", resourceRef: "r1", dedupKey: "missing_upstream:fakeprov:fake:r1", detail: {} }, NOW.getTime());
    const failing = fakeAdapter(() => [], 100, true);
    expect(await sweepManagedInventory(h.env, [failing.entry], NOW)).toMatchObject({ failed: 1, created: 0, resolved: 0 });
    // A cursor that never advances is a truncated listing.
    const looping = { entry: { provider: "fakeprov", serviceId: "fake", adapter: { listUpstreamResources: async (cursor?: string) => ({ items: [], next_cursor: cursor ?? "same" }) } as unknown as ProviderAdapterV1 } };
    expect(await sweepManagedInventory(h.env, [looping.entry], NOW)).toMatchObject({ truncated: 1, resolved: 0 });
    expect(h.findings()).toEqual([expect.objectContaining({ status: "open" })]);
  });

  it("skips accounts still provisioning or failed, and adapters without listUpstreamResources", async () => {
    const h = harness();
    h.account("acc-p", "r-prov", "provisioning"); h.account("acc-f", "r-failed", "failed");
    const a = fakeAdapter(() => []);
    const none = { provider: "fakeprov", serviceId: "fake", adapter: { provider: "fakeprov" } as unknown as ProviderAdapterV1 };
    expect(await sweepManagedInventory(h.env, [a.entry, none], NOW)).toMatchObject({ adapters: 1, skipped: 1, created: 0 });
  });

  it("a daily run is claimed once per UTC day; a failed run gives the claim back", async () => {
    const h = harness();
    let boom = true;
    const adapter = { provider: "fakeprov", listUpstreamResources: async () => { if (boom) throw new Error("x"); return { items: [resource("stray")] }; } } as unknown as ProviderAdapterV1;
    const entry: InventoryAdapter = { provider: "fakeprov", serviceId: "fake", adapter };
    expect((await sweepManagedReconciliation(h.env, [entry], NOW)).inventory).toMatchObject({ failed: 1 });
    // failure inside the adapter is contained and the day is complete; a throw from the sweep itself releases the claim
    boom = false;
    expect((await sweepManagedReconciliation(h.env, [entry], new Date(NOW.getTime() + 3_600_000))).inventory).toBeUndefined();
    expect(h.count("managed_service_reconciliation_findings")).toBe(0);
    const next = await sweepManagedReconciliation(h.env, [entry], new Date(NOW.getTime() + 86_400_000));
    expect(next.inventory).toMatchObject({ created: 1 });
    await sweepManagedReconciliation(h.env, [entry], new Date(NOW.getTime() + 86_400_000 + 60_000));
    expect(h.findings()[0]).toMatchObject({ seen_count: 1 });
    // a sweep that throws releases its claim
    const bad = { provider: "fakeprov", serviceId: "fake", adapter: entry.adapter };
    const broken = { ...h.env, PLATFORM_DB: new Proxy(h.env.PLATFORM_DB, { get: (t, k) => (k === "prepare" ? (sql: string) => { if (/FROM managed_service_accounts/.test(sql)) throw new Error("db down"); return t.prepare(sql); } : (t as never)[k]) }) } as unknown as AgentsEnv;
    const day = new Date(NOW.getTime() + 2 * 86_400_000);
    await expect(sweepManagedReconciliation(broken, [bad], day)).rejects.toThrow("db down");
    expect((await sweepManagedReconciliation(h.env, [bad], day)).inventory).toBeDefined();
  });
});

describe("MS-38 inventory against the real Naelao Email app", () => {
  function emailBinding(f: EmailFixture) {
    const seen: string[] = [];
    return { seen, fetch: async (request: Request) => { seen.push(`${request.method} ${new URL(request.url).pathname}`); return emailApp.fetch(request, f.env as never); } } as unknown as Fetcher & { seen: string[] };
  }

  it("lists only adapter-managed tenants over the HMAC route and compares them with the registry", async () => {
    const email = emailFixture();
    const managedKey = await seedTenant(email, "naelao-t1"), otherKey = await seedTenant(email, "agentport-x"), directKey = await seedTenant(email, "direct-y");
    const known = await createInbox(email, managedKey, "known"), stray = await createInbox(email, managedKey, "stray");
    await createInbox(email, otherKey, "ap-box"); await createInbox(email, directKey, "direct-box");
    const h = harness();
    h.account("acc-known", known, "active", { provider: "naelao", service: "email", tenant: "t1" });
    h.account("acc-gone", "inb_vanished", "active", { provider: "naelao", service: "email", tenant: "t1" });
    const binding = emailBinding(email);
    const adapter = createNaelaoEmailAdapter({ MANAGED_OFFERINGS_ENABLED: "true", NAELAO_EMAIL: binding, PLATFORM_DB: h.env.PLATFORM_DB, PLATFORM_SECRET: SECRET } as never);
    const entry: InventoryAdapter = { provider: "naelao", serviceId: "email", adapter };
    const page = await adapter.listUpstreamResources!();
    expect(page.items.map(r => r.provider_resource_ref).sort()).toEqual([known, stray].sort());
    expect(page.items.every(r => r.provider === "naelao" && r.service_id === "email" && r.status === "active")).toBe(true);
    await sweepManagedInventory(h.env, [entry], NOW);
    expect(h.findings().map(f => [f.kind, f.resource_ref])).toEqual([["missing_upstream", "inb_vanished"], ["orphaned_upstream", stray]]);
    // Only the read-only list route was used; no tenant key is opened and nothing was deleted upstream.
    expect(new Set(binding.seen)).toEqual(new Set(["POST /internal/v1/inventory/inboxes"]));
    expect(email.db.prepare("SELECT COUNT(*) AS n FROM nemail_inboxes WHERE status='deleted'").get()).toEqual({ n: 0 });
    expect(JSON.stringify(h.findings())).not.toMatch(/nem_/);
  });

  it("pages with a cursor, marks deleted inboxes deleted, fails closed without the flag, and refuses a missing HMAC", async () => {
    const email = emailFixture();
    const key = await seedTenant(email, "naelao-t1");
    const ids = [await createInbox(email, key, "a"), await createInbox(email, key, "b"), await createInbox(email, key, "c")];
    email.db.prepare("UPDATE nemail_inboxes SET status='deleted' WHERE id=?").run(ids[0]);
    const route = (body: unknown, token?: string) => emailApp.fetch(new Request("https://email.test/internal/v1/inventory/inboxes", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "naelao-inventory", ...(token ? { "x-naelao-internal-token": token } : {}) }, body: JSON.stringify(body) }), email.env as never);
    expect((await route({ tenant_prefix: "naelao-", limit: 1 })).status).toBe(403);
    expect((await route({ tenant_prefix: "naelao-", limit: 1 }, "forged")).status).toBe(403);
    const { mintInternalToken } = await import("@naelao/http");
    const token = await mintInternalToken(SECRET, "naelao-inventory");
    expect((await route({ tenant_prefix: "Bad_prefix%" }, token)).status).toBe(400);
    const first = await (await route({ tenant_prefix: "naelao-", limit: 2 }, token)).json() as { data: { items: Array<{ id: string; status: string }>; next_cursor?: string } };
    expect(first.data.items).toHaveLength(2);
    const second = await (await route({ tenant_prefix: "naelao-", limit: 2, cursor: first.data.next_cursor }, token)).json() as { data: { items: Array<{ id: string; status: string }>; next_cursor?: string } };
    expect(second.data.next_cursor).toBeUndefined();
    const all = [...first.data.items, ...second.data.items];
    expect(all.map(i => i.id).sort()).toEqual([...ids].sort());
    expect(all.find(i => i.id === ids[0])!.status).toBe("deleted");
    const off = createNaelaoEmailAdapter({ MANAGED_OFFERINGS_ENABLED: "false", NAELAO_EMAIL: emailBinding(email), PLATFORM_DB: harness().env.PLATFORM_DB, PLATFORM_SECRET: SECRET } as never);
    await expect(off.listUpstreamResources!()).rejects.toMatchObject({ code: "offering_unavailable" });
  });
});

describe("MS-38 monthly cost comparison", () => {
  const WINDOW = previousMonthWindow(NOW);
  const receipt = (h: ReturnType<typeof harness>, n: number, over: { provider?: string; service?: string; cost?: number; currency?: string; start?: string; end?: string } = {}) =>
    h.sql.prepare(`INSERT INTO managed_service_provider_cost_receipts(id,tenant_id,space_id,provider,service_id,statement_ref_hash,receipt_ref_hash,account_ref_hash,usage_kind,quantity_unit,
      period_start,period_end,quantity_micros,provider_cost_micros,currency,evidence_sha256,provenance,imported_by,imported_at)
      VALUES(?,?,?,?,?,?,?,?,'email','email',?,?,1,?,?,?,'operator_imported','op','2026-12-01T00:00:00Z')`)
      .run(`r${n}`, "tenant-1", "space-1", over.provider ?? "fakeprov", over.service ?? "fake", "a".repeat(64), String(n).padStart(64, "0"), "b".repeat(64),
        over.start ?? "2026-11-01T00:00:00.000Z", over.end ?? "2026-11-30T00:00:00.000Z", over.cost ?? 1_000_000, over.currency ?? "USD", "c".repeat(64));
  const settle = (h: ReturnType<typeof harness>, n: number, credits: number, over: { settledAt?: string; status?: string; provider?: string } = {}) =>
    h.sql.prepare(`INSERT INTO managed_service_credit_reservations(id,org_id,space_id,region,operation_id,provider,service_id,operation_name,payer_id,credits,settled_credits,price_version,status,created_at,updated_at,settled_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`res${n}`, "tenant-1", "space-1", "global", `op${n}`, over.provider ?? "fakeprov", "fake", "send", "tenant-1", Math.max(credits, 1), credits, "v1",
      over.status ?? "settled", "2026-11-05T00:00:00Z", "2026-11-05T00:00:00Z", over.settledAt ?? "2026-11-15T00:00:00.000Z");

  it("uses the previous UTC month and the platform credit rate", () => {
    expect(WINDOW.period).toBe("2026-11");
    expect(WINDOW.start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(WINDOW.end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(MICROS_PER_CREDIT).toBe(10_000);
  });

  it("flags provider cost that exceeds settled charges, once, with the margin in the detail", async () => {
    const h = harness();
    h.sql.exec("PRAGMA foreign_keys=OFF");
    h.sql.prepare("INSERT INTO managed_service_offerings(id,provider,service_id,capability_version,resource_type,category,display_name,access_modes_json,strategies_json,regions_json,configuration_schema_json,charge_components_json,quote_policy,data_handling_json,status,created_at,updated_at) VALUES('off_fake','fakeprov','fake',1,'thing','email','Fake','[]','[]','[]','{}','[]','none','{}','draft',1,1)").run();
    receipt(h, 1, { cost: 2_000_000 }); receipt(h, 2, { cost: 1_000_000 });   // $3.00 provider cost
    settle(h, 1, 100); settle(h, 2, 100);                                      // 200 credits = $2.00
    settle(h, 3, 999, { settledAt: "2026-12-02T00:00:00.000Z" });              // outside the window
    settle(h, 4, 999, { status: "held" });                                     // not settled
    expect(await sweepManagedCostComparison(h.env, NOW)).toMatchObject({ period: "2026-11", groups: 1, created: 1 });
    expect(await sweepManagedCostComparison(h.env, NOW)).toMatchObject({ created: 0, seen: 1 });
    const [finding] = h.sql.prepare("SELECT kind,offering_id,period,status,tenant_id,detail_json FROM managed_service_reconciliation_findings").all() as Array<Record<string, string | null>>;
    expect(finding).toMatchObject({ kind: "cost_discrepancy", offering_id: "off_fake", period: "2026-11", status: "open", tenant_id: null });
    expect(JSON.parse(finding!.detail_json!)).toMatchObject({ reason: "negative_margin", provider_cost_micros_usd: 3_000_000, settled_credits: 200, settled_micros_usd: 2_000_000, margin_micros_usd: -1_000_000 });
  });

  it("flags cost with no settlements, settlements with no receipts and non-USD receipts; a healthy group raises nothing", async () => {
    const h = harness();
    receipt(h, 1, { service: "nocharge", cost: 500_000 });
    settle(h, 1, 50, { provider: "nocost" });
    receipt(h, 2, { provider: "euro", currency: "EUR", cost: 100 });
    receipt(h, 3, { provider: "fine", cost: 1_000_000 }); h.sql.prepare("INSERT INTO managed_service_credit_reservations(id,org_id,space_id,region,operation_id,provider,service_id,operation_name,payer_id,credits,settled_credits,price_version,status,created_at,updated_at,settled_at) VALUES('f1','t','s','global','fo','fine','fake','send','t',150,150,'v','settled','x','x','2026-11-10T00:00:00.000Z')").run();
    h.sql.prepare("UPDATE managed_service_provider_cost_receipts SET service_id='fake' WHERE id IN ('r1')").run(); // keep r1 under provider fakeprov / service fake
    h.sql.prepare("UPDATE managed_service_provider_cost_receipts SET service_id='nocharge' WHERE id='r1'").run();
    const result = await sweepManagedCostComparison(h.env, NOW);
    expect(result.created).toBe(3);
    const reasons = (h.sql.prepare("SELECT provider,detail_json FROM managed_service_reconciliation_findings ORDER BY provider").all() as Array<{ provider: string; detail_json: string }>)
      .map(r => [r.provider, JSON.parse(r.detail_json).reason]);
    expect(reasons).toEqual([["euro", "currency_not_comparable"], ["fakeprov", "cost_without_settlements"], ["nocost", "settlements_without_cost_receipts"]]);
  });

  it("resolves the finding once a late settlement or receipt fixes the month", async () => {
    const h = harness();
    receipt(h, 1, { cost: 1_000_000 });
    await sweepManagedCostComparison(h.env, NOW);
    expect(h.findings()[0]).toMatchObject({ status: "open" });
    settle(h, 1, 150);
    expect(await sweepManagedCostComparison(h.env, NOW)).toMatchObject({ resolved: 1, created: 0 });
    expect(h.findings()[0]).toMatchObject({ status: "resolved" });
  });

  it("runs once per month from day 3 through the cron entry point", async () => {
    const h = harness();
    receipt(h, 1);
    const early = await sweepManagedReconciliation(h.env, [], new Date("2026-12-02T03:00:00Z"));
    expect(early.cost).toBeUndefined();
    const ran = await sweepManagedReconciliation(h.env, [], new Date("2026-12-03T03:00:00Z"));
    expect(ran.cost).toMatchObject({ period: "2026-11", created: 1 });
    expect((await sweepManagedReconciliation(h.env, [], new Date("2026-12-09T03:00:00Z"))).cost).toBeUndefined();
    expect(h.count("managed_service_reconciliation_findings")).toBe(1);
  });
});

describe("MS-38 operator routes", () => {
  async function seeded() {
    const h = harness();
    h.account("acc-1", "gone");
    await sweepManagedInventory(h.env, [fakeAdapter(() => [resource("stray")]).entry], NOW);
    return h;
  }

  it("answers the not-found shape with the flag off, before any auth check", async () => {
    const h = harness("false");
    expect((await h.call("GET", "reconciliation-findings", undefined, "wrong")).status).toBe(404);
    expect((await h.call("POST", "reconciliation-findings/mrf_x/acknowledge", { reason: "long enough reason" }, "wrong")).status).toBe(404);
    expect((await harness(null).call("GET", "reconciliation-findings")).status).toBe(404);
  });

  it("refuses non-operators and a missing operator secret", async () => {
    const h = await seeded();
    expect((await h.call("GET", "reconciliation-findings", undefined, "wrong")).status).toBe(403);
    expect((await h.call("GET", "reconciliation-findings", undefined, "")).status).toBe(403);
    const id = (h.sql.prepare("SELECT id FROM managed_service_reconciliation_findings").get() as { id: string }).id;
    expect((await h.call("POST", `reconciliation-findings/${id}/acknowledge`, { reason: "long enough reason" }, "wrong")).status).toBe(403);
    expect(h.findings().every(f => f.status === "open")).toBe(true);
    delete (h.env as Record<string, unknown>).MANAGED_SERVICES_OPERATOR_SECRET;
    expect((await h.call("GET", "reconciliation-findings")).status).toBe(503);
  });

  it("lists with filters and paging, without secrets or raw detail columns", async () => {
    const h = await seeded();
    const all = await (await h.call("GET", "reconciliation-findings")).json() as { findings: Array<Record<string, unknown>> };
    expect(all.findings.map(f => f.kind).sort()).toEqual(["missing_upstream", "orphaned_upstream"]);
    expect(all.findings[0]).toHaveProperty("detail");
    expect(all.findings[0]).not.toHaveProperty("detail_json");
    const orphans = await (await h.call("GET", "reconciliation-findings?kind=orphaned_upstream&status=open")).json() as { findings: unknown[] };
    expect(orphans.findings).toHaveLength(1);
    const p1 = await (await h.call("GET", "reconciliation-findings?limit=1")).json() as { findings: Array<{ id: string }>; next_cursor?: string };
    expect(p1.findings).toHaveLength(1);
    const p2 = await (await h.call("GET", `reconciliation-findings?limit=1&cursor=${encodeURIComponent(p1.next_cursor!)}`)).json() as { findings: Array<{ id: string }>; next_cursor?: string };
    expect(p2.findings[0]!.id).not.toBe(p1.findings[0]!.id);
    expect(p2.next_cursor).toBeUndefined();
    expect((await h.call("GET", "reconciliation-findings?status=bogus")).status).toBe(400);
    expect((await h.call("GET", "reconciliation-findings?limit=9999")).status).toBe(400);
  });

  it("acknowledges with actor and reason, idempotently; unknown ids look like not found", async () => {
    const h = await seeded();
    const id = (h.sql.prepare("SELECT id FROM managed_service_reconciliation_findings WHERE kind='orphaned_upstream'").get() as { id: string }).id;
    expect((await h.call("POST", `reconciliation-findings/${id}/acknowledge`, { reason: "short" })).status).toBe(400);
    expect((await h.call("POST", `reconciliation-findings/${id}/acknowledge`, { reason: "Known stray inbox, tracked in ticket." }, OPERATOR, "bad actor!")).status).toBe(400);
    const ok = await h.call("POST", `reconciliation-findings/${id}/acknowledge`, { reason: "Known stray inbox, tracked in ticket." }, OPERATOR, "operator-9");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ finding: { id, status: "acknowledged", acknowledged_by: "operator-9", acknowledgement_reason: "Known stray inbox, tracked in ticket." } });
    const again = await h.call("POST", `reconciliation-findings/${id}/acknowledge`, { reason: "Different reason entirely, ignored." }, OPERATOR, "operator-10");
    expect(await again.json()).toMatchObject({ finding: { acknowledged_by: "operator-9" } });
    expect((await h.call("POST", "reconciliation-findings/mrf_00000000000000000000000000000000/acknowledge", { reason: "Known stray inbox, tracked in ticket." })).status).toBe(404);
    expect((await h.call("POST", "reconciliation-findings/not-an-id/acknowledge", { reason: "Known stray inbox, tracked in ticket." })).status).toBe(404);
    expect(h.count("managed_service_reconciliation_findings")).toBe(2);
  });
});

describe("MS-38 secret scrubbing (MR-SEC-4)", () => {
  it("drops credential-shaped keys and values from stored detail", async () => {
    const scrubbed = scrubSecrets({ ok: "fine", api_key: "x", nested: { note: `leak nem_${"a".repeat(30)} Bearer abc.def`, token: "t" }, list: [`whsec_${"b".repeat(20)}`] });
    expect(JSON.stringify(scrubbed)).not.toMatch(/nem_a|whsec_b|abc\.def|"api_key"|"token"/);
    expect(scrubbed).toMatchObject({ ok: "fine" });
    const h = harness();
    await recordFinding(h.env.PLATFORM_DB, { kind: "orphaned_upstream", provider: "p", dedupKey: "k", detail: { note: `x nem_${"c".repeat(30)}`, secret: "s" } }, NOW.getTime());
    expect(String(h.findings()[0]!.detail_json)).toBe('{"note":"x [redacted]"}');
  });
});
