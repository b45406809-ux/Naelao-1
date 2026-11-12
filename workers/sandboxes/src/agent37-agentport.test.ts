import { describe, expect, it, vi } from "vitest";
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import {
  AGENT37_AGENTPORT_CAPABILITIES,
  authorizeAgent37AgentPortAction,
  revokeAgent37ComputerAgentPortShare,
  shareAgent37ComputerWithAgentPort,
} from "./agent37-agentport.js";
import { sweepAgent37AgentPortRevocations } from "./agent37-agentport-reconciliation.js";

class Db {
  share: Record<string, unknown> | null = null;
  readonly operations = new Map<string, Record<string, unknown>>();
  ownerLinkId: string | null = null;
  now = "2026-11-12T12:00:00.000Z";
  prepare(sql: string) {
    const db = this;
    let values: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) { values = bound; return statement; },
      async first<T>() { return db.first<T>(sql, values); },
      async all<T>() { return db.all<T>(sql, values); },
      async run() { return db.run(sql, values); },
    };
    return statement;
  }
  first<T>(sql: string, values: unknown[]): T | null {
    if (sql.includes("FROM sandbox_agentport_operations")) {
      if(sql.includes("json_extract(request_json")){
        const accountId=sql.includes("idempotency_key<>")?values[4]:values[3];
        const found=[...this.operations.values()].find(row=>row.tenant_id===values[0]&&row.owner_id===values[1]
          &&row.computer_id===values[2]&&["pending","unknown"].includes(String(row.status))
          &&(!sql.includes("idempotency_key<>")||row.idempotency_key!==values[3])
          &&JSON.parse(String(row.request_json)).agentportAccountId===accountId);
        return (found?{pending:1}:null) as T|null;
      }
      const row = this.operations.get(`${values[0]}:${values[1]}:${values[2]}:${values[3]}`);
      return (row ?? null) as T | null;
    }
    if (sql.includes("FROM sandbox_agentport_shares") && sql.includes("capabilities_json")) {
      return (this.share as T | null) ?? null;
    }
    if (sql.includes("FROM sandbox_agentport_shares")) {
      return this.share as T | null;
    }
    if (sql.includes("FROM managed_service_owner_links"))
      return (this.ownerLinkId ? { id: this.ownerLinkId } : null) as T | null;
    return null;
  }
  async all<T>(sql: string, values: unknown[]) {
    if (sql.includes("FROM sandbox_agentport_operations") && sql.includes("JOIN sandbox_agentport_shares")) {
      const rows: Record<string,unknown>[] = [];
      for (const operation of this.operations.values()) {
        if (operation.operation !== "revoke") continue;
        const due = operation.status === "unknown" && typeof operation.next_reconcile_at === "string" && operation.next_reconcile_at <= String(values[0])
          || operation.status === "pending" && typeof operation.lease_until === "string" && operation.lease_until <= String(values[1])
          || operation.status === "pending" && operation.lease_until == null && String(operation.created_at) <= "2026-11-12T11:58:00.000Z";
        if (!due || !this.share) continue;
        rows.push({ id:operation.id,operation_status:operation.status,tenant_id:operation.tenant_id,owner_id:operation.owner_id,
          computer_id:operation.computer_id,request_json:operation.request_json,reconcile_attempts:operation.reconcile_attempts,
          agentport_account_id:this.share.agentport_account_id,share_status:this.share.status });
      }
      return { results: rows.slice(0,Number(values.at(-1))) as T[], success:true, meta:{duration:0,changes:rows.length} };
    }
    return { results: [] as T[], success:true, meta:{duration:0,changes:0} };
  }
  async run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT OR IGNORE INTO sandbox_agentport_operations")) {
      const key = `${values[1]}:${values[2]}:${values[3]}:${values[5]}`;
      if (!this.operations.has(key)) this.operations.set(key, {
        id: values[0], tenant_id: values[1], owner_id: values[2], computer_id: values[3], operation: values[4],
        idempotency_key: values[5], request_sha256: values[6], status: "pending",request_json:values[7],created_at:values[8],
        lease_until:null,next_reconcile_at:null,reconcile_attempts:0,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO managed_service_owner_links")) {
      this.ownerLinkId = String(values[0]);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO sandbox_agentport_shares")) {
      if (this.share?.status === "active") return { success: true, meta: { changes: 0 } };
      this.share = {
        id: values[0], tenant_id: values[1], owner_id: values[2], space_id: values[3], project_id: values[4],
        computer_id: values[5], connection_id: values[6], service_id: values[7], agentport_principal_id: values[8],
        agentport_agent_id: values[9], agentport_account_id: values[10], owner_link_id: values[11], capabilities_json: values[12],
        status: "pending", error_code: null,
      };
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE sandbox_agentport_shares SET status='active'")) {
      if (!this.share) return { success: true, meta: { changes: 0 } };
      this.share.status = "active"; this.share.error_code = null;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE sandbox_agentport_shares SET status='unknown'")) {
      if (this.share) { this.share.status = "unknown"; this.share.error_code = values[0]; }
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE sandbox_agentport_shares SET status='revoking'")) {
      if (this.share) this.share.status = "revoking";
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE sandbox_agentport_shares SET status='revoked'")) {
      if (this.share) { this.share.status = "revoked"; this.share.revoked_at = values[0]; }
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE sandbox_agentport_operations SET status=?")) {
      const row = [...this.operations.values()].find(value=>value.id===values[4]);
      if (row) { row.status = values[0]; row.error_code = values[1]; row.lease_until=null; row.next_reconcile_at=values[2]; }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("UPDATE sandbox_agentport_operations SET status='pending'")) {
      const row = [...this.operations.values()].find(value=>value.id===values[2]);
      if (row && ["pending","unknown"].includes(String(row.status))) {
        row.status="pending";row.lease_until=values[0];row.next_reconcile_at=null;row.reconcile_attempts=Number(row.reconcile_attempts??0)+1;return {success:true,meta:{changes:1}};
      }
      return {success:true,meta:{changes:0}};
    }
    if (sql.includes("UPDATE sandbox_agentport_shares SET status='revoking'")) {
      if (this.share) { this.share.status="revoking"; return {success:true,meta:{changes:1}}; }
      return {success:true,meta:{changes:0}};
    }
    if (sql.includes("UPDATE sandbox_agentport_shares SET status='revoked'")) {
      if (this.share) { this.share.status="revoked";this.share.revoked_at=values[0];this.share.error_code=null;return {success:true,meta:{changes:1}}; }
      return {success:true,meta:{changes:0}};
    }
    if (sql.includes("UPDATE sandbox_agentport_shares SET status='unknown'")) {
      if (this.share) { this.share.status="unknown";this.share.error_code=values[0];return {success:true,meta:{changes:1}}; }
      return {success:true,meta:{changes:0}};
    }
    if (sql.includes("UPDATE sandbox_agentport_operations SET status='complete'")) {
      const row=[...this.operations.values()].find(value=>value.id===values[1]);
      if (row) {row.status="complete";row.lease_until=null;row.next_reconcile_at=null;return {success:true,meta:{changes:1}};}
      return {success:true,meta:{changes:0}};
    }
    if (sql.includes("UPDATE sandbox_agentport_operations SET status='unknown'")) {
      const row=[...this.operations.values()].find(value=>value.id===values[1]);
      if (row) {row.status="unknown";row.lease_until=null;row.next_reconcile_at=values[2];row.error_code=values[0];return {success:true,meta:{changes:1}};}
      return {success:true,meta:{changes:0}};
    }
    return { success: true, meta: { changes: 1 } };
  }
  operationKeyForId(id:string){return [...this.operations.entries()].find(([,value])=>value.id===id)?.[0].split(":").at(-1)??"";}
}

const computer = { id: "computer-a", tenant_id: "tenant-a", owner_id: "user-a", space_id: "space-a", project_id: "project-a", connection_id: "connection-secret-id" };

function fixture() {
  const db = new Db();
  const services = new Map<string, Record<string, unknown>>();
  let account: { id: string; status: string; externalAccountId: string } | null = null;
  let grant: { agentId: string; permissions: string[] } | null = null;
  let failGrant = false;
  let failRevoke = false;
  const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url), path = url.pathname.replace("/internal/agentport", "");
    const body = request.method === "GET" ? null : await request.json().catch(() => null) as Record<string, unknown> | null;
    requests.push({ path, body });
    if (path === "/principals") return Response.json({ principal: { id: body?.id, external_id: body?.externalId } }, { status: 201 });
    if (path === "/agents") return Response.json({ agent: { id: body?.id } }, { status: 201 });
    if (path === "/services" && request.method === "POST") {
      const service = { ...body, status: "active" }; services.set(String(body?.id), service);
      return Response.json({ service }, { status: 201 });
    }
    if (path.startsWith("/services/") && request.method === "GET") {
      const found = services.get(decodeURIComponent(path.split("/").at(-1) ?? ""));
      return found ? Response.json({ service: found }) : Response.json({ error_code: "service_unavailable" }, { status: 404 });
    }
    if (path === "/accounts" && request.method === "POST") {
      if (!account) account = { id: "acct-agent37-a", status: "pending", externalAccountId: String(body?.externalAccountId) };
      return Response.json({ account: { id: account.id, status: account.status } }, { status: account.status === "pending" ? 201 : 200 });
    }
    if (path.endsWith("/activate")) {
      if (account) account.status = "active";
      return Response.json({ active: true });
    }
    if (path.endsWith("/reactivate")) {
      if (account) account.status = "active";
      return Response.json({ active: true, reactivated: true });
    }
    if (path.endsWith("/grants")) {
      if (failGrant) { failGrant = false; return Response.json({ error_code: "temporary_failure" }, { status: 503 }); }
      grant = { agentId: String(body?.agentId), permissions: body?.permissions as string[] };
      return Response.json({ grant }, { status: 201 });
    }
    if (path.endsWith("/actions/authorize")) {
      const allow = account?.status === "active" && !!grant && grant.agentId === body?.agentId && grant.permissions.includes(String(body?.action));
      return allow ? Response.json({ decision: "allow", contentStored: false }) : Response.json({ error_code: "permission_denied" }, { status: 403 });
    }
    if (path.endsWith("/revoke")) {
      if(failRevoke){failRevoke=false;return Response.json({error_code:"temporary_failure"},{status:503});}
      if (account) account.status = "revoked";
      grant = null;
      return Response.json({ revoked: true });
    }
    return Response.json({ error_code: "unexpected_request" }, { status: 404 });
  });
  const env = { PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: "platform-secret", AGENTPORT_WORKER: { fetch } as unknown as Fetcher };
  return { db, env, requests, fetch, get account() { return account; }, get grant() { return grant; }, failNextGrant() { failGrant = true; },failNextRevoke(){failRevoke=true;} };
}

describe("Agent37 AgentPort account share", () => {
  it("persists a provider-reference-only account and an exact selected grant", async () => {
    const f = fixture();
    const selected = ["agent37.exec", "agent37.artifacts.read"];
    const result = await shareAgent37ComputerWithAgentPort(f.env, computer, "share-key-a", selected);
    expect(result).toMatchObject({ shared: true, status: "active", capabilities: [...selected].sort() });
    expect(f.grant?.permissions).toEqual([...selected].sort());
    expect(f.db.share).toMatchObject({ status: "active", connection_id: computer.connection_id, capabilities_json: JSON.stringify([...selected].sort()) });
    const service = f.requests.find(item => item.path === "/services")?.body;
    expect(service?.accountModels).toEqual(["agent_native"]);
    expect(service?.capabilities).toEqual([...AGENT37_AGENTPORT_CAPABILITIES]);
    const account = f.requests.find(item => item.path === "/accounts")?.body;
    expect(account?.accountModel).toBe("agent_native");
    expect(account?.credentialRef).not.toContain(computer.connection_id);
    expect(account?.externalAccountId).not.toContain(computer.id);
    expect(account?.metadata).toMatchObject({ provider: "agent37", customerOwned: true, selectedCapabilities: [...selected].sort() });
  });

  it("fails closed on unselected actions and sends only an opaque authorization receipt", async () => {
    const f = fixture();
    await shareAgent37ComputerWithAgentPort(f.env, computer, "share-key-b", ["agent37.exec"]);
    const agentId = String(f.db.share?.agentport_agent_id);
    await expect(authorizeAgent37AgentPortAction(f.env, { tenantId: computer.tenant_id, ownerId: computer.owner_id,
      computerId: computer.id, connectionId: computer.connection_id, agentId, capability: "agent37.computer.start", operationKey: "op-start" }))
      .rejects.toThrow("agentport_agent37_capability_not_granted");
    await authorizeAgent37AgentPortAction(f.env, { tenantId: computer.tenant_id, ownerId: computer.owner_id,
      computerId: computer.id, connectionId: computer.connection_id, agentId, capability: "agent37.exec", operationKey: "op-exec" });
    const authorization = f.requests.find(item => item.path.endsWith("/actions/authorize"));
    expect(authorization?.body).toMatchObject({ agentId, action: "agent37.exec" });
    expect(authorization?.body).not.toHaveProperty("command");
    expect(authorization?.body?.resourceRef).toBe(f.db.share?.id);
  });

  it("recovers a partially completed share idempotently and revokes the linked grant before removing local access", async () => {
    const f = fixture();
    f.failNextGrant();
    await expect(shareAgent37ComputerWithAgentPort(f.env, computer, "share-key-c", ["agent37.exec"]))
      .rejects.toThrow("agentport_temporary_failure");
    expect(f.db.share?.status).toBe("unknown");
    const recovered = await shareAgent37ComputerWithAgentPort(f.env, computer, "share-key-c", ["agent37.exec"]);
    expect(recovered.status).toBe("active");
    const revoked = await revokeAgent37ComputerAgentPortShare(f.env, computer, "revoke-key-c");
    expect(revoked).toMatchObject({ revoked: true, alreadyUnlinked: false });
    expect(f.db.share?.status).toBe("revoked");
    await expect(authorizeAgent37AgentPortAction(f.env, { tenantId: computer.tenant_id, ownerId: computer.owner_id,
      computerId: computer.id, connectionId: computer.connection_id, agentId: String(f.db.share?.agentport_agent_id),
      capability: "agent37.exec", operationKey: "op-exec-after-revoke" })).rejects.toThrow("agentport_agent37_capability_not_granted");
  });

  it("retries an uncertain revoke only against the persisted AgentPort account",async()=>{
    const f=fixture();
    await shareAgent37ComputerWithAgentPort(f.env,computer,"share-retry",["agent37.exec"]);
    f.failNextRevoke();
    await expect(revokeAgent37ComputerAgentPortShare(f.env,computer,"revoke-retry"))
      .rejects.toThrow("agentport_temporary_failure");
    expect(f.db.share).toMatchObject({status:"unknown",agentport_account_id:"acct-agent37-a"});
    const operation=[...f.db.operations.values()].find(value=>value.operation==="revoke");
    expect(operation).toMatchObject({status:"unknown",request_json:JSON.stringify({agentportAccountId:"acct-agent37-a"}),next_reconcile_at:expect.any(String)});
    if(operation)operation.next_reconcile_at="2000-01-01T00:00:00.000Z";
    await expect(sweepAgent37AgentPortRevocations(f.env,new Date("2026-11-12T12:00:00Z"),5))
      .resolves.toMatchObject({checked:1,reconciled:1,deferred:0,failed:0});
    expect(f.db.share?.status).toBe("revoked");
    expect(operation?.status).toBe("complete");
    expect(f.requests.filter(item=>item.path.endsWith("/revoke")).map(item=>item.path))
      .toEqual(["/accounts/acct-agent37-a/revoke","/accounts/acct-agent37-a/revoke"]);
  });
});
