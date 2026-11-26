// MS-50: AgentMail inventory listing. Mock only: fetch is an in-memory fake, the DB is in-memory SQLite with the real migrations; no provider is called.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../../index.js";
import { fixture } from "../../../../../tests/fixtures/assistant-communications.js";
import { MAX_INVENTORY_PAGES, sweepManagedInventory, sweepManagedReconciliation, type InventoryAdapter } from "../managed-reconciliation-findings.js";
import { AGENTMAIL_INVENTORY_CONNECTION_MODE, AGENTMAIL_INVENTORY_PAGE_SIZE, createAgentMailInventoryAdapter } from "./agentmail.js";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../../infra/migrations", name), "utf8");
const NOW = new Date("2026-12-04T03:00:00Z");

type Inbox = { inbox_id: string; email?: string; status?: string };
function harness(flag: string | null = "true", over: Record<string, unknown> = {}) {
  const f = fixture();
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0292_managed_offering_testing_allowlist_and_telnyx_classification.sql", "0303_managed_service_reconciliation_findings.sql"]) f.db.db.exec(migration(name));
  const env = f.env as unknown as AgentsEnv & Record<string, unknown>;
  Object.assign(env, { AGENTMAIL_API_KEY: "am_platform_key_value", ...over });
  if (flag !== null) env.MANAGED_RECONCILIATION_ENABLED = flag;
  const sql = f.db.db;
  const account = (id: string, ref: string, lifecycle = "active", over: { mode?: string; region?: string | null } = {}) => sql.prepare(`INSERT INTO managed_service_accounts(
    id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,owner_type,owner_id,provider_payer_type,lifecycle_state,region,created_at,updated_at)
    VALUES(?,?,?,'agentmail','agentmail',?,?,'organization','tenant-1','platform',?,?,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`)
    .run(id, "tenant-1", "space-1", over.mode ?? "naelao_managed", ref, lifecycle, over.region ?? null);
  const findings = () => sql.prepare("SELECT kind,status,resource_ref FROM managed_service_reconciliation_findings ORDER BY dedup_key").all() as Array<Record<string, unknown>>;
  return { env, sql, account, findings };
}

/** Fake AgentMail: per-host inbox lists served `pageSize` at a time with opaque tokens. Records every request. */
function fakeFetch(hosts: Record<string, Inbox[]>, pageSize = AGENTMAIL_INVENTORY_PAGE_SIZE) {
  const requests: Array<{ method: string; url: string; auth: string | null }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", url: url.toString(), auth: new Headers(init?.headers).get("authorization") });
    const list = hosts[url.origin];
    if (!list || url.pathname !== "/v0/inboxes") return new Response("{}", { status: 404 });
    const start = url.searchParams.get("page_token") ? Number(url.searchParams.get("page_token")!.replace("tok", "")) : 0;
    const page = list.slice(start, start + pageSize);
    return new Response(JSON.stringify({ count: page.length, limit: pageSize, inboxes: page, ...(start + pageSize < list.length ? { next_page_token: `tok${start + pageSize}` } : {}) }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, requests };
}
const entry = (env: AgentsEnv, impl: typeof fetch): InventoryAdapter => ({
  provider: "agentmail", serviceId: "agentmail", connectionMode: AGENTMAIL_INVENTORY_CONNECTION_MODE, adapter: createAgentMailInventoryAdapter(env, impl),
});
const inboxes = (n: number, prefix = "box"): Inbox[] => Array.from({ length: n }, (_, i) => ({ inbox_id: `${prefix}${i}@agentmail.to`, email: `${prefix}${i}@agentmail.to` }));
const US = "https://api.agentmail.to", EU = "https://api.agentmail.eu";

describe("MS-50 AgentMail inventory listing", () => {
  it("follows next_page_token until absent with limit 100, platform key as bearer, GET only", async () => {
    const h = harness();
    const list = inboxes(5);
    list.forEach((box, i) => h.account(`acc-${i}`, box.inbox_id));
    const f = fakeFetch({ [US]: list }, 2);
    const result = await sweepManagedInventory(h.env, [entry(h.env, f.impl)], NOW);
    expect(result).toMatchObject({ adapters: 1, created: 0, truncated: 0, failed: 0 });
    expect(f.requests).toHaveLength(3);
    expect(f.requests.every(r => r.method === "GET" && r.auth === "Bearer am_platform_key_value")).toBe(true);
    expect(f.requests[0]!.url).toBe(`${US}/v0/inboxes?limit=100`);
    expect(f.requests[1]!.url).toBe(`${US}/v0/inboxes?limit=100&page_token=tok2`);
    expect(h.findings()).toEqual([]);
  });

  it("reports orphan, missing and state_mismatch; missing status is active; deactivated is gone", async () => {
    const h = harness();
    h.account("acc-ok", "ok@agentmail.to"); h.account("acc-gone", "gone@agentmail.to");
    h.account("acc-retired", "retired@agentmail.to", "retired"); h.account("acc-deact", "deact@agentmail.to");
    const f = fakeFetch({ [US]: [
      { inbox_id: "ok@agentmail.to" }, { inbox_id: "stray@agentmail.to", email: "stray@agentmail.to" },
      { inbox_id: "retired@agentmail.to", status: "active" }, { inbox_id: "deact@agentmail.to", status: "deactivated" },
      { inbox_id: "old-deact@agentmail.to", status: "deactivated" },
    ] });
    await sweepManagedInventory(h.env, [entry(h.env, f.impl)], NOW);
    expect(h.findings()).toEqual([
      expect.objectContaining({ kind: "missing_upstream", resource_ref: "gone@agentmail.to" }),
      expect.objectContaining({ kind: "orphaned_upstream", resource_ref: "stray@agentmail.to" }),
      expect.objectContaining({ kind: "state_mismatch", resource_ref: "deact@agentmail.to" }),
      expect.objectContaining({ kind: "state_mismatch", resource_ref: "retired@agentmail.to" }),
    ]);
  });

  it("ignores user_connected registry rows (the platform key cannot see them)", async () => {
    const h = harness();
    h.account("acc-user", "theirs@agentmail.to", "active", { mode: "user_connected" });
    const f = fakeFetch({ [US]: [] });
    await sweepManagedInventory(h.env, [entry(h.env, f.impl)], NOW);
    expect(h.findings()).toEqual([]);
  });

  it("lists each configured host in use and no other", async () => {
    const h = harness("true", { AGENTMAIL_REGION: "us" });
    h.account("acc-eu", "eu@agentmail.eu", "active", { region: "eu" });
    h.account("acc-us", "us@agentmail.to");
    const f = fakeFetch({ [US]: [{ inbox_id: "us@agentmail.to" }], [EU]: [{ inbox_id: "eu@agentmail.eu" }, { inbox_id: "eu-stray@agentmail.eu" }] });
    await sweepManagedInventory(h.env, [entry(h.env, f.impl)], NOW);
    expect(f.requests.map(r => new URL(r.url).origin)).toEqual([US, EU]);
    expect(h.findings()).toEqual([expect.objectContaining({ kind: "orphaned_upstream", resource_ref: "eu-stray@agentmail.eu" })]);
    const only = harness("true", { AGENTMAIL_REGION: "us" });
    const g = fakeFetch({ [US]: [] });
    await sweepManagedInventory(only.env, [entry(only.env, g.impl)], NOW);
    expect(g.requests.map(r => new URL(r.url).origin)).toEqual([US]);
  });

  it("a cap hit is truncated: writes nothing and resolves nothing", async () => {
    const h = harness();
    h.account("acc-1", "missing@agentmail.to");
    h.sql.prepare(`INSERT INTO managed_service_reconciliation_findings(id,kind,provider,service_id,resource_ref,detail_json,status,dedup_key,seen_count,first_seen_at,last_seen_at,created_at,updated_at)
      VALUES('mrf_${"a".repeat(32)}','orphaned_upstream','agentmail','agentmail','old@agentmail.to','{}','open','orphaned_upstream:agentmail:agentmail:old@agentmail.to',1,1,1,1,1)`).run();
    const f = fakeFetch({ [US]: inboxes(MAX_INVENTORY_PAGES * 2 + 5) }, 2);
    const result = await sweepManagedInventory(h.env, [entry(h.env, f.impl)], NOW);
    expect(result).toMatchObject({ truncated: 1, created: 0, resolved: 0 });
    expect(f.requests).toHaveLength(MAX_INVENTORY_PAGES);
    expect(h.findings()).toEqual([expect.objectContaining({ resource_ref: "old@agentmail.to", status: "open" })]);
  });

  it("a failing upstream or a missing platform key is a failed listing with no findings and no key leak", async () => {
    const h = harness();
    h.account("acc-1", "x@agentmail.to");
    const bad = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    expect(await sweepManagedInventory(h.env, [entry(h.env, bad)], NOW)).toMatchObject({ failed: 1, created: 0 });
    const noKey = harness("true", { AGENTMAIL_API_KEY: undefined });
    noKey.account("acc-1", "x@agentmail.to");
    const f = fakeFetch({ [US]: [] });
    expect(await sweepManagedInventory(noKey.env, [entry(noKey.env, f.impl)], NOW)).toMatchObject({ failed: 1, created: 0 });
    expect(f.requests).toHaveLength(0);
    expect(noKey.findings()).toEqual([]);
  });

  it("rejects a forged cursor and a malformed response", async () => {
    const h = harness();
    const f = fakeFetch({ [US]: [] });
    const adapter = createAgentMailInventoryAdapter(h.env, f.impl);
    await expect(adapter.listUpstreamResources!("bogus")).rejects.toThrow("invalid_cursor");
    await expect(adapter.listUpstreamResources!("eu:abc")).rejects.toThrow("invalid_cursor");
    const junk = createAgentMailInventoryAdapter(h.env, (async () => new Response(JSON.stringify({ inboxes: [{ nope: 1 }] }), { status: 200 })) as typeof fetch);
    await expect(junk.listUpstreamResources!()).rejects.toThrow("invalid_inventory_response");
  });

  it("never mutates: the adapter has no deprovision and its execute throws", async () => {
    const h = harness();
    const adapter = createAgentMailInventoryAdapter(h.env, fakeFetch({ [US]: [] }).impl);
    expect(adapter.deprovision).toBeUndefined();
    await expect(adapter.execute({ tenantId: "t", operation: "delete", provider_resource_ref: "x" }, { operation_id: "o", idempotency_key: "k" })).rejects.toThrow("capability_unsupported");
  });

  it("flag off: the reconciliation sweep does not list anything", async () => {
    const h = harness("false");
    const f = fakeFetch({ [US]: inboxes(1) });
    expect(await sweepManagedReconciliation(h.env, [entry(h.env, f.impl)], NOW)).toEqual({});
    expect(f.requests).toHaveLength(0);
    expect(h.findings()).toEqual([]);
  });
});
