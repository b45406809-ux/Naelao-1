import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { requireManagedServiceCapability } from "./managed-service-capabilities.js";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";

function harness() {
  const f = fixture();
  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerCommunicationRoutes(app);
  (f.env as unknown as { MANAGED_SERVICES_OPERATOR_SECRET: string }).MANAGED_SERVICES_OPERATOR_SECRET = "operator-test-secret";
  const call = (action: "verify" | "disable", body: Record<string, unknown>, key = "operator-test-secret") => app.fetch(
    new Request(`https://agents.test/internal/managed-services/capabilities/agentmail/agentmail/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-managed-services-operator-key": key, "x-managed-services-operator-id": "operator-1" },
      body: JSON.stringify(body),
    }), f.env,
  );
  return { ...f, app, call };
}

describe("managed service capability verification", () => {
  it("requires the operator key and writes verified evidence plus an audit receipt", async () => {
    const h = harness();
    const body = {
      version: 1,
      reason: "Provider region and price were reviewed for the authorized pilot account.",
      valid_until: "2026-12-01T00:00:00.000Z",
      regions: ["us"],
      evidence: [{ url: "https://docs.agentmail.to/messages", checkedAt: "2026-11-11T00:00:00.000Z", note: "API contract reviewed" }],
      metering: { priceVersion: "agentmail-rental-v1", chargeModel: "monthly-rental" },
    };
    expect((await h.call("verify", body, "wrong-secret")).status).toBe(403);
    const verified = await h.call("verify", body);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ verified: true, provider: "agentmail", serviceId: "agentmail", version: 1 });
    expect(h.db.db.prepare("SELECT status,regions_json,verified_by,metering_json FROM managed_service_capability_versions WHERE provider='agentmail'").get()).toMatchObject({
      status: "verified", regions_json: '["us"]', verified_by: "operator-1", metering_json: JSON.stringify(body.metering),
    });
    expect(h.db.db.prepare("SELECT action,actor_id,reason FROM managed_service_capability_audit").get()).toMatchObject({ action: "verified", actor_id: "operator-1" });
    expect(await requireManagedServiceCapability(h.env.PLATFORM_DB, {
      provider: "agentmail", serviceId: "agentmail", operation: "provision", connectionMode: "naelao_managed", region: "us", now: new Date("2026-11-12T00:00:00.000Z"),
    })).toMatchObject({ version: 1, status: "verified", regions: ["us"] });
  });

  it("rejects incomplete verification, and capability disable is auditable and blocks admission", async () => {
    const h = harness();
    const invalid = await h.call("verify", { version: 1, reason: "short", valid_until: "2026-12-01T00:00:00.000Z", regions: [], evidence: [], metering: {} });
    expect(invalid.status).toBe(400);
    expect(h.db.db.prepare("SELECT status FROM managed_service_capability_versions WHERE provider='agentmail'").get()).toEqual({ status: "draft" });
    const disabled = await h.call("disable", { version: 1, reason: "Provider contract is no longer approved for managed use." });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ disabled: true });
    expect(h.db.db.prepare("SELECT action FROM managed_service_capability_audit").get()).toEqual({ action: "disabled" });
    await expect(requireManagedServiceCapability(h.env.PLATFORM_DB, {
      provider: "agentmail", serviceId: "agentmail", operation: "provision", connectionMode: "naelao_managed", region: "us",
    })).rejects.toThrow("managed_service_capability_unverified");
  });

  it("serves an owner-only dashboard without provider resource or credential references", async () => {
    const h = harness();
    const at = new Date().toISOString();
    h.db.db.prepare(`INSERT INTO managed_service_owner_links(id,tenant_id,owner_type,owner_id,agentport_principal_id,linked_by_user_id,
      consent_source,consented_at,status,created_at,updated_at) VALUES('owner-link-1','tenant','user','user','principal-1','user',
      'agentmail_user_connect',?,'active',?,?)`).run(at,at,at);
    h.db.db.prepare(`INSERT INTO managed_service_accounts(
      id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,credential_ref,owner_link_id,
      owner_type,owner_id,provider_payer_type,lifecycle_state,created_at,updated_at)
      VALUES('msa-1','tenant','space','agentmail','agentmail','user_connected','provider-secret-ref','vault-secret-ref','owner-link-1',
      'user','user','user','active',?,?)`).run(at, at);
    h.db.db.prepare(`INSERT INTO managed_service_operations(
      operation_id,tenant_id,space_id,account_id,provider,service_id,operation_name,idempotency_key,request_sha256,status,error_code,created_at,updated_at)
      VALUES('op-1','tenant','space','msa-1','agentmail','agentmail','provision','idem-1',?, 'uncertain','provider_timeout',?,?)`)
      .run("a".repeat(64), at, at);
    h.db.db.prepare(`INSERT INTO managed_service_credit_reservations(
      id,org_id,space_id,region,operation_id,provider,service_id,operation_name,payer_id,credits,price_version,status,created_at,updated_at)
      VALUES('hold-1','tenant','space','us','op-1','agentmail','agentmail','provision','tenant',300,'agentmail-v1','uncertain',?,?)`)
      .run(at, at);

    const headers = {
      "x-naelao-tenant-id": "tenant",
      "x-naelao-user-id": "user",
      "x-naelao-role": "product_end_user",
      "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
    };
    const denied = await h.app.request("/spaces/space/assistant-communications?action=managed-service-dashboard", {
      headers: { ...headers, "x-naelao-user-id": "other" },
    }, h.env);
    expect(denied.status).toBe(403);

    const response = await h.app.request("/spaces/space/assistant-communications?action=managed-service-dashboard", { headers }, h.env);
    expect(response.status).toBe(200);
    const dashboard = await response.json() as Record<string, any>;
    expect(dashboard).toMatchObject({
      planTier: "free",
      accounts: [{ id: "msa-1", provider: "agentmail", status: "active", connectionMode: "user_connected", ownerLinkId:"owner-link-1", wakeEnabled: false }],
      operations: [{ id: "op-1", status: "uncertain", errorCode: "provider_timeout" }],
      usage30d: [{ provider: "agentmail", heldCredits: 300, settledCredits: 0, operations: 1 }],
    });
    expect(JSON.stringify(dashboard)).not.toContain("provider-secret-ref");
    expect(JSON.stringify(dashboard)).not.toContain("vault-secret-ref");
    expect(JSON.stringify(dashboard)).not.toContain("credential_ref");
  });
});
