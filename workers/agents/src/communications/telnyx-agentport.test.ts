import { describe, expect, it, vi } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import { defaultPhonePolicy } from "./phones.js";
import { sweepManagedAgentPortShareRevocations } from "./agentport-share-reconciliation.js";
import { authorizeTelnyxSmsViaAgentPort, revokeTelnyxAgentPortShare, shareTelnyxSmsWithAgentPort } from "./telnyx-agentport.js";

describe("Telnyx AgentPort account sharing", () => {
  it("registers only the owner-selected SMS capability, authorizes before send, and revokes durably", async () => {
    const f = fixture();
    const identity = await ensureIdentity(f.env, scope);
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,policy_json,status) VALUES('binding-1',?,'assistant','byo','telnyx','account-1','number-1','+14155550100',?,'active')`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    let serviceExists = false;
    const requests: Array<{path:string;method:string;body:Record<string,unknown>}> = [];
    f.env.AGENTPORT_WORKER.fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/internal/agentport", "");
      const method = request.method;
      const body = method === "GET" ? {} : await request.clone().json().catch(() => ({})) as Record<string,unknown>;
      requests.push({ path, method, body });
      if (path === "/agents" && method === "POST") return Response.json({ agent: { id: "naelao_agent", status: "active" } }, { status: 201 });
      if (path === "/principals") return Response.json({ principal: { id: body.id, external_id: scope.userId } }, { status: 201 });
      if (path === "/services/telnyx-v2%3Atenant" && !serviceExists) return Response.json({ error_code: "service_unavailable" }, { status: 404 });
      if (path === "/services/telnyx-v2%3Atenant") return Response.json({ service: { id: "telnyx-v2:tenant", status: "active", account_models: ["agent_native"], capabilities: ["phone.sms.send"] } });
      if (path === "/services") { serviceExists = true; return Response.json({ service: { id: "telnyx-v2:tenant", accountModels: ["agent_native"] } }, { status: 201 }); }
      if (path === "/accounts" && method === "POST") return Response.json({ account: { id: "ap_telnyx", status: "pending" } }, { status: 201 });
      if (path.endsWith("/activate")) return Response.json({ active: true });
      if (path.endsWith("/grants")) return Response.json({ grant: { id: "grant-1" } }, { status: 201 });
      if (path.endsWith("/actions/authorize")) return Response.json({ decision: "allow", authorizationId: "receipt-1" });
      if (path.endsWith("/revoke")) return Response.json({ revoked: true });
      return Response.json({ error_code: "unexpected_route" }, { status: 404 });
    }) as unknown as Fetcher;

    await expect(shareTelnyxSmsWithAgentPort(f.env, scope, identity, "binding-1"))
      .resolves.toMatchObject({ shared: true, capability: "phone.sms.send", deduplicated: false });
    const account = await f.db.prepare(`SELECT connection_mode,provider_payer_type,agentport_principal_id,agentport_agent_id,
      agentport_account_id,agentport_link_status FROM managed_service_accounts WHERE id='telnyx-binding-1'`)
      .first<Record<string,string>>();
    expect(account).toMatchObject({ connection_mode: "user_connected", provider_payer_type: "user", agentport_principal_id: expect.stringMatching(/^prn_user_/),
      agentport_agent_id: expect.stringMatching(/^naelao_/), agentport_account_id: "ap_telnyx", agentport_link_status: "active" });
    expect(requests.find(item => item.path === "/accounts" && item.method === "POST")?.body).toMatchObject({
      accountModel: "agent_native", externalAccountId: "telnyx-binding-1", credentialRef: "telnyx-binding-1",
    });
    expect(requests.find(item => item.path.endsWith("/grants"))?.body.permissions).toEqual(["phone.sms.send"]);
    expect(await f.db.prepare("SELECT operation_name,status FROM managed_service_operations ORDER BY operation_name").all())
      .toMatchObject({ results: [{ operation_name: "agentport_sync", status: "complete" }] });
    await expect(authorizeTelnyxSmsViaAgentPort(f.env, scope, "binding-1", "action-1")).resolves.toEqual({ linked: true });
    expect(requests.find(item => item.path.endsWith("/actions/authorize"))?.body).toMatchObject({ agentId: account?.agentport_agent_id, action: "phone.sms.send" });
    expect(JSON.stringify(requests.find(item => item.path.endsWith("/actions/authorize"))?.body)).not.toContain("message");
    await expect(revokeTelnyxAgentPortShare(f.env, scope, identity, "binding-1")).resolves.toMatchObject({ revoked: true, alreadyUnlinked: false });
    expect((await f.db.prepare("SELECT agentport_link_status FROM managed_service_accounts WHERE id='telnyx-binding-1'").first<{agentport_link_status:string}>())?.agentport_link_status).toBe("revoked");
    expect(await f.db.prepare("SELECT status FROM managed_service_operations WHERE operation_name='agentport_revoke'").first<{status:string}>())
      .toMatchObject({ status: "complete" });
    await expect(authorizeTelnyxSmsViaAgentPort(f.env, scope, "binding-1", "action-2")).resolves.toEqual({ linked: false });
  });

  it("does not share a provider-managed number to a customer principal", async () => {
    const f = fixture();
    const identity = await ensureIdentity(f.env, scope);
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,policy_json,status) VALUES('binding-managed',?,'assistant','managed','telnyx','platform','number-1','+14155550100',?,'active')`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const calls = f.env.AGENTPORT_WORKER.fetch as ReturnType<typeof vi.fn>;
    const callsBefore = calls.mock.calls.length;
    await expect(shareTelnyxSmsWithAgentPort(f.env, scope, identity, "binding-managed")).rejects.toThrow("telnyx_agentport_customer_owned_only");
    expect(calls).toHaveBeenCalledTimes(callsBefore);
  });

  it("journals and retries an uncertain AgentPort revoke against the exact account", async () => {
    const f = fixture();
    const identity = await ensureIdentity(f.env, scope);
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,policy_json,status) VALUES('binding-retry',?,'assistant','byo','telnyx','account-1','number-1','+14155550100',?,'active')`)
      .bind(identity.id, JSON.stringify(defaultPhonePolicy)).run();
    let serviceExists = false;
    let failRevoke = true;
    f.env.AGENTPORT_WORKER.fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/internal/agentport", "");
      const method = request.method;
      const body = method === "GET" ? {} : await request.clone().json().catch(() => ({})) as Record<string,unknown>;
      if (path === "/agents" && method === "POST") return Response.json({ agent: { id: "naelao_agent", status: "active" } }, { status: 201 });
      if (path === "/principals") return Response.json({ principal: { id: body.id, external_id: scope.userId } }, { status: 201 });
      if (path === "/services/telnyx-v2%3Atenant" && !serviceExists) return Response.json({ error_code: "service_unavailable" }, { status: 404 });
      if (path === "/services/telnyx-v2%3Atenant") return Response.json({ service: { id: "telnyx-v2:tenant", status: "active", account_models: ["agent_native"], capabilities: ["phone.sms.send"] } });
      if (path === "/services") { serviceExists = true; return Response.json({ service: { id: "telnyx-v2:tenant" } }, { status: 201 }); }
      if (path === "/accounts" && method === "POST") return Response.json({ account: { id: "ap_telnyx_retry", status: "pending" } }, { status: 201 });
      if (path.endsWith("/activate")) return Response.json({ active: true });
      if (path.endsWith("/grants")) return Response.json({ grant: { id: "grant-retry" } }, { status: 201 });
      if (path.endsWith("/revoke")) {
        if (failRevoke) return Response.json({ error_code: "temporary_failure" }, { status: 503 });
        return Response.json({ revoked: true });
      }
      return Response.json({ error_code: "unexpected_route" }, { status: 404 });
    }) as unknown as Fetcher;

    await shareTelnyxSmsWithAgentPort(f.env, scope, identity, "binding-retry");
    await expect(revokeTelnyxAgentPortShare(f.env, scope, identity, "binding-retry")).rejects.toThrow("agentport_temporary_failure");
    const journal = await f.db.prepare(`SELECT status,next_reconcile_at,request_json FROM managed_service_operations
      WHERE operation_name='agentport_revoke' AND account_id='telnyx-binding-retry'`).first<{status:string;next_reconcile_at:string|null;request_json:string}>();
    expect(journal).toMatchObject({ status: "uncertain", next_reconcile_at: expect.any(String) });
    expect(journal?.request_json).toContain("ap_telnyx_retry");
    await f.db.prepare("UPDATE managed_service_operations SET next_reconcile_at='2000-01-01T00:00:00.000Z' WHERE operation_name='agentport_revoke'").run();
    failRevoke = false;
    await expect(sweepManagedAgentPortShareRevocations(f.env, new Date("2026-11-12T12:00:00Z"), 5))
      .resolves.toMatchObject({ checked: 1, reconciled: 1, deferred: 0, failed: 0 });
    expect(await f.db.prepare(`SELECT agentport_link_status FROM managed_service_accounts WHERE id='telnyx-binding-retry'`)
      .first<{agentport_link_status:string}>()).toEqual({ agentport_link_status: "revoked" });
    expect(await f.db.prepare(`SELECT status,next_reconcile_at FROM managed_service_operations WHERE operation_name='agentport_revoke'`)
      .first<{status:string;next_reconcile_at:string|null}>()).toEqual({ status: "complete", next_reconcile_at: null });
  });
});
