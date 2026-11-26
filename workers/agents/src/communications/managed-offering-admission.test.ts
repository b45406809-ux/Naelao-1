import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { resolveOfferingAdmission, type OfferingAdmissionInput } from "@naelao/billing-core";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../infra/migrations", name), "utf8");
const NOW = Date.parse("2026-11-26T00:00:00Z");
const DAY = 86_400_000;
const SECRET = "operator-test-secret";

function harness(flag: string | null = "true") {
  const f = fixture();
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0292_managed_offering_testing_allowlist_and_telnyx_classification.sql"]) {
    f.db.db.exec(migration(name));
  }
  const env = f.env as unknown as AgentsEnv & Record<string, unknown>;
  env.MANAGED_SERVICES_OPERATOR_SECRET = SECRET;
  if (flag !== null) env.MANAGED_OFFERINGS_ENABLED = flag;
  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerCommunicationRoutes(app);
  const post = (path: string, body: Record<string, unknown>, key = SECRET, actor = "operator-1") => app.fetch(
    new Request(`https://agents.test/internal/managed-services/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-managed-services-operator-key": key, "x-managed-services-operator-id": actor },
      body: JSON.stringify(body),
    }), env,
  );
  const sql = f.db.db;
  const setCapability = (over: { status?: string; validUntil?: string | null; operations?: string[]; regions?: string[]; modes?: string[]; verifiedBy?: string | null } = {}) => {
    sql.prepare(`INSERT INTO managed_service_capability_versions(provider,service_id,version,category,operations_json,regions_json,account_modes_json,
      isolation_model,provisioning_json,metering_json,external_effects_json,evidence_json,status,verified_by,verified_at,valid_until,created_at,updated_at)
      VALUES('acme','mail',1,'email',?,?,?,'tenant','{}','{}','[]','[{"url":"https://x.test","checkedAt":"2026-11-01T00:00:00Z"}]',?,?,?,?,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')
      ON CONFLICT(provider,service_id,version) DO UPDATE SET operations_json=excluded.operations_json,regions_json=excluded.regions_json,
        account_modes_json=excluded.account_modes_json,status=excluded.status,verified_by=excluded.verified_by,valid_until=excluded.valid_until`)
      .run(JSON.stringify(over.operations ?? ["provision", "renew"]), JSON.stringify(over.regions ?? ["us"]), JSON.stringify(over.modes ?? ["naelao_managed", "user_connected"]),
        over.status ?? "verified", over.verifiedBy === undefined ? "op" : over.verifiedBy, "2026-11-02T00:00:00Z",
        over.validUntil === undefined ? new Date(NOW + 30 * DAY).toISOString() : over.validUntil);
  };
  return { ...f, sql, post, env, setCapability };
}

const offeringBody = (over: Record<string, unknown> = {}) => ({
  provider: "acme", service_id: "mail", capability_version: 1, resource_type: "email.inbox", category: "email", display_name: "Inbox",
  access_modes: ["managed", "byok"], strategies: ["managed_master", "customer_connection", "first_party"], regions: ["us"],
  configuration_schema: { type: "object" }, charge_components: [{ kind: "provision" }], quote_policy: "required_for_recurring",
  data_handling: { operator: "acme" }, status: "available", reason: "Offering reviewed for the pilot catalog.", ...over,
});
const agreementBody = (over: Record<string, unknown> = {}) => ({
  provider: "acme", agreement_type: "reseller", permitted_offering_ids: ["off_acme_inbox"], permits_managed_provisioning: true,
  permits_master_account_distribution: true, permits_subaccount_distribution: false, permits_shared_resources: false,
  permitted_regions: ["us"], effective_from: NOW - DAY, expires_at: NOW + 60 * DAY, reason: "Agreement terms reviewed with counsel.", ...over,
});
const EVIDENCE = "a".repeat(64);

async function seed(h: ReturnType<typeof harness>, o: Record<string, unknown> = {}, a: Record<string, unknown> = {}, approve = true) {
  h.setCapability();
  expect((await h.post("offerings/off_acme_inbox", offeringBody(o))).status).toBe(200);
  expect((await h.post("agreements/agr_acme", agreementBody({ evidence_sha256: EVIDENCE, ...a }))).status).toBe(200);
  if (approve) expect((await h.post("agreements/agr_acme/approve", { reason: "Approved after evidence review." })).status).toBe(200);
}

const ask = (h: ReturnType<typeof harness>, over: Partial<OfferingAdmissionInput> = {}) => resolveOfferingAdmission(h.db, {
  tenantId: "tenant-a", provider: "acme", serviceId: "mail", operation: "provision", region: "us", strategy: "managed_master", now: NOW, ...over,
});

describe("MS-28 offering and agreement admin routes", () => {
  it("returns the not-found shape for every write route when the flag is off or unset, before auth", async () => {
    for (const flag of ["false", null]) {
      const h = harness(flag);
      for (const path of ["offerings/off_x", "agreements/agr_x", "agreements/agr_x/approve", "agreements/agr_x/revoke"]) {
        const res = await h.post(path, { reason: "long enough reason" }, "wrong-key");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error_code: "not_found" });
      }
      expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_offerings").get()).toEqual({ n: 0 });
    }
  });

  it("refuses non-operators and a missing operator secret", async () => {
    const h = harness();
    h.setCapability();
    expect((await h.post("offerings/off_acme_inbox", offeringBody(), "wrong-key")).status).toBe(403);
    expect((await h.post("agreements/agr_acme", agreementBody(), "")).status).toBe(403);
    expect((await h.post("agreements/agr_acme/approve", { reason: "long enough reason" }, "wrong")).status).toBe(403);
    delete (h.env as Record<string, unknown>).MANAGED_SERVICES_OPERATOR_SECRET;
    expect((await h.post("offerings/off_acme_inbox", offeringBody())).status).toBe(503);
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_offerings").get()).toEqual({ n: 0 });
  });

  it("writes one audit row per offering write with actor, reason and before/after", async () => {
    const h = harness();
    h.setCapability();
    expect((await h.post("offerings/off_acme_inbox", offeringBody({ status: "draft" }), SECRET, "operator-7")).status).toBe(200);
    const update = await h.post("offerings/off_acme_inbox", offeringBody({ status: "testing", testing_tenant_ids: ["tenant-a"] }), SECRET, "operator-8");
    expect(await update.json()).toMatchObject({ saved: true, created: false, status: "testing" });
    const audit = h.sql.prepare("SELECT actor_id,reason,before_json,after_json FROM managed_service_offering_audit ORDER BY created_at,id").all() as
      { actor_id: string; reason: string; before_json: string | null; after_json: string }[];
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor_id: "operator-7", before_json: null, reason: "Offering reviewed for the pilot catalog." });
    expect(JSON.parse(audit[1]!.before_json!)).toMatchObject({ status: "draft" });
    expect(JSON.parse(audit[1]!.after_json)).toMatchObject({ status: "testing", testing_tenant_ids: ["tenant-a"] });
    expect(audit[1]!.actor_id).toBe("operator-8");
  });

  it("rejects invalid offerings, short reasons and unknown capability versions without writing", async () => {
    const h = harness();
    h.setCapability();
    for (const over of [{ reason: "short" }, { status: "live" }, { quote_policy: "sometimes" }, { regions: [] }, { strategies: ["magic"] }, { testing_tenant_ids: ["bad tenant"] }]) {
      expect((await h.post("offerings/off_acme_inbox", offeringBody(over))).status).toBe(400);
    }
    expect((await h.post("offerings/off_acme_inbox", offeringBody({ capability_version: 9 }))).status).toBe(404);
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_offerings").get()).toEqual({ n: 0 });
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_offering_audit").get()).toEqual({ n: 0 });
  });

  it("audits agreement create, approval (sets approved_by/at) and revoke; approval needs evidence; stores only sha256", async () => {
    const h = harness();
    expect((await h.post("agreements/agr_acme", agreementBody())).status).toBe(200);
    const noEvidence = await h.post("agreements/agr_acme/approve", { reason: "Approved after evidence review." });
    expect(noEvidence.status).toBe(400);
    expect(await noEvidence.json()).toEqual({ error_code: "managed_agreement_evidence_required" });
    expect((await h.post("agreements/agr_acme", agreementBody({ evidence_sha256: "not-a-hash" }))).status).toBe(400);
    const approved = await h.post("agreements/agr_acme/approve", { reason: "Approved after evidence review.", evidence_sha256: EVIDENCE }, SECRET, "operator-9");
    expect(await approved.json()).toMatchObject({ saved: true, verificationStatus: "approved" });
    expect(h.sql.prepare("SELECT verification_status,approved_by,evidence_sha256,approved_at IS NOT NULL AS has_at FROM managed_service_commercial_agreements").get())
      .toEqual({ verification_status: "approved", approved_by: "operator-9", evidence_sha256: EVIDENCE, has_at: 1 });
    expect((await h.post("agreements/agr_acme/revoke", { reason: "Counterparty terminated the agreement." })).status).toBe(200);
    expect(await (await h.post("agreements/agr_acme/revoke", { reason: "Counterparty terminated the agreement." })).json()).toMatchObject({ deduplicated: true });
    const audit = h.sql.prepare("SELECT actor_id,json_extract(after_json,'$.action') AS action FROM managed_service_commercial_agreement_audit ORDER BY created_at,id").all();
    expect(audit.map((row) => (row as { action: string }).action)).toEqual(["created_or_edited", "approved", "revoked"]);
    // Revoked is terminal; approval and edits cannot resurrect it.
    expect((await h.post("agreements/agr_acme/approve", { reason: "Approved after evidence review." })).status).toBe(409);
    expect((await h.post("agreements/agr_acme", agreementBody())).status).toBe(409);
  });

  it("cannot set approved through the edit route and an edit to an approved agreement needs fresh approval", async () => {
    const h = harness();
    await seed(h);
    expect((await h.post("agreements/agr_acme", agreementBody({ verification_status: "approved" }))).status).toBe(400);
    expect((await ask(h)).ok).toBe(true);
    expect((await h.post("agreements/agr_acme", agreementBody({ permitted_regions: ["us", "eu"], reason: "Added the EU region to the terms." }))).status).toBe(200);
    expect(h.sql.prepare("SELECT verification_status,approved_by FROM managed_service_commercial_agreements").get()).toEqual({ verification_status: "under_review", approved_by: null });
    expect(await ask(h)).toEqual({ ok: false, error_code: "provider_not_approved" });
  });
});

describe("MS-28 resolveOfferingAdmission (MR-CAT-3, fail closed)", () => {
  it("admits the approved path and returns the offering and agreement", async () => {
    const h = harness();
    await seed(h);
    const result = await ask(h);
    expect(result).toMatchObject({
      ok: true, capabilityVersion: 1,
      offering: { id: "off_acme_inbox", quotePolicy: "required_for_recurring", status: "available", resourceType: "email.inbox" },
      agreement: { id: "agr_acme", approvedBy: "operator-1", agreementType: "reseller" },
    });
  });

  it("fails with offering_unavailable when there is no offering, or it is draft/disabled/restricted/deprecated", async () => {
    const h = harness();
    h.setCapability();
    expect(await ask(h)).toEqual({ ok: false, error_code: "offering_unavailable" });
    await seed(h);
    for (const status of ["draft", "disabled", "restricted", "deprecated"]) {
      expect((await h.post("offerings/off_acme_inbox", offeringBody({ status }))).status).toBe(200);
      expect(await ask(h)).toEqual({ ok: false, error_code: "offering_unavailable" });
    }
  });

  it("admits a testing offering only for allowlisted tenants", async () => {
    const h = harness();
    await seed(h, { status: "testing", testing_tenant_ids: ["tenant-a"] });
    expect((await ask(h, { tenantId: "tenant-a" })).ok).toBe(true);
    expect(await ask(h, { tenantId: "tenant-b" })).toEqual({ ok: false, error_code: "offering_unavailable" });
    h.sql.prepare("UPDATE managed_service_offerings SET testing_tenant_ids_json='not json'").run();
    expect(await ask(h, { tenantId: "tenant-a" })).toEqual({ ok: false, error_code: "offering_unavailable" });
  });

  it("fails with capability_unsupported for unverified, disabled, expired, unsupported operation, region or mode", async () => {
    const h = harness();
    await seed(h);
    for (const over of [{ status: "draft" }, { status: "disabled" }, { validUntil: new Date(NOW - 1).toISOString() }, { validUntil: null },
      { verifiedBy: null }, { operations: ["renew"] }, { regions: ["eu"] }, { modes: ["user_connected"] }]) {
      h.setCapability(over);
      expect(await ask(h)).toEqual({ ok: false, error_code: "capability_unsupported" });
    }
    h.sql.exec("PRAGMA foreign_keys=OFF");
    h.sql.prepare("DELETE FROM managed_service_capability_versions WHERE provider='acme'").run();
    // With the capability row gone (FKs off to simulate it) admission must still fail closed.
    expect(await ask(h)).toEqual({ ok: false, error_code: "capability_unsupported" });
  });

  it("fails with provider_not_approved for a missing, unapproved, expired, not-yet-effective or revoked agreement", async () => {
    const h = harness();
    await seed(h, {}, {}, false);
    expect(await ask(h)).toEqual({ ok: false, error_code: "provider_not_approved" });
    expect((await h.post("agreements/agr_acme/approve", { reason: "Approved after evidence review." })).status).toBe(200);
    expect((await ask(h)).ok).toBe(true);
    expect(await ask(h, { now: NOW + 61 * DAY })).toEqual({ ok: false, error_code: "capability_unsupported" }); // capability expired first
    h.setCapability({ validUntil: new Date(NOW + 200 * DAY).toISOString() });
    expect(await ask(h, { now: NOW + 61 * DAY })).toEqual({ ok: false, error_code: "provider_not_approved" }); // agreement expired
    expect(await ask(h, { now: NOW - 2 * DAY })).toEqual({ ok: false, error_code: "provider_not_approved" }); // not yet effective
    for (const status of ["expired", "under_review", "unverified"]) {
      h.sql.prepare("UPDATE managed_service_commercial_agreements SET verification_status=?").run(status);
      expect(await ask(h)).toEqual({ ok: false, error_code: "provider_not_approved" });
    }
    h.sql.prepare("UPDATE managed_service_commercial_agreements SET verification_status='approved'").run();
    expect((await h.post("agreements/agr_acme/revoke", { reason: "Counterparty terminated the agreement." })).status).toBe(200);
    expect(await ask(h)).toEqual({ ok: false, error_code: "provider_not_approved" });
  });

  it("requires the agreement to permit managed provisioning, list the offering, the strategy and the region", async () => {
    const h = harness();
    await seed(h);
    const check = async (over: Record<string, unknown>, expected: boolean, input: Partial<OfferingAdmissionInput> = {}) => {
      h.sql.prepare("UPDATE managed_service_commercial_agreements SET verification_status='approved',approved_by='op',approved_at=1").run();
      const columns: Record<string, string> = { permits_managed_provisioning: "permits_managed_provisioning", offering: "permitted_offering_ids_json", master: "permits_master_account_distribution", sub: "permits_subaccount_distribution", regions: "permitted_regions_json", type: "agreement_type" };
      const [key, value] = Object.entries(over)[0]!;
      h.sql.prepare(`UPDATE managed_service_commercial_agreements SET ${columns[key]!}=?`).run(value as never);
      expect((await ask(h, input)).ok).toBe(expected);
      await seed(h);
    };
    await check({ permits_managed_provisioning: 0 }, false);
    await check({ offering: '["off_other"]' }, false);
    await check({ master: 0 }, false);
    await check({ regions: '["eu"]' }, false);
    await check({ regions: '["*"]' }, true); // documented wildcard on the agreement
    // native_subaccount needs its own flag (and the offering must list it and the capability support the mode)
    h.sql.prepare("UPDATE managed_service_offerings SET strategies_json='[\"managed_master\",\"native_subaccount\"]'").run();
    h.setCapability({ modes: ["naelao_managed", "provider_managed"] });
    expect(await ask(h, { strategy: "native_subaccount" })).toEqual({ ok: false, error_code: "provider_not_approved" });
    h.sql.prepare("UPDATE managed_service_commercial_agreements SET permits_subaccount_distribution=1").run();
    expect((await ask(h, { strategy: "native_subaccount" })).ok).toBe(true);
    // partner_direct is deferred and never admitted
    h.sql.prepare("UPDATE managed_service_offerings SET strategies_json='[\"partner_direct\"]'").run();
    expect((await ask(h, { strategy: "partner_direct" })).ok).toBe(false);
  });

  it("first_party needs a first_party agreement type", async () => {
    const h = harness();
    await seed(h);
    expect(await ask(h, { strategy: "first_party" })).toEqual({ ok: false, error_code: "provider_not_approved" });
    h.sql.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party'").run();
    expect((await ask(h, { strategy: "first_party" })).ok).toBe(true);
  });

  it("rejects a strategy or region the offering does not list as offering_unavailable", async () => {
    const h = harness();
    await seed(h, { regions: ["us"], strategies: ["managed_master"] });
    expect(await ask(h, { strategy: "customer_connection" })).toEqual({ ok: false, error_code: "offering_unavailable" });
    expect(await ask(h, { region: "eu" })).toEqual({ ok: false, error_code: "offering_unavailable" });
    h.sql.prepare("UPDATE managed_service_offerings SET regions_json='[\"*\"]'").run();
    h.sql.prepare("UPDATE managed_service_commercial_agreements SET permitted_regions_json='[\"*\"]'").run();
    h.setCapability({ regions: ["eu"] });
    expect((await ask(h, { region: "eu" })).ok).toBe(true); // offering wildcard; capability must still name the region
    h.setCapability({ regions: ["us"] });
    expect(await ask(h, { region: "eu" })).toEqual({ ok: false, error_code: "capability_unsupported" });
  });

  it("BYOK needs a verified capability and a non-disabled offering but no agreement", async () => {
    const h = harness();
    h.setCapability();
    expect((await h.post("offerings/off_acme_inbox", offeringBody())).status).toBe(200);
    const byok = await ask(h, { strategy: "customer_connection" });
    expect(byok).toMatchObject({ ok: true, agreement: null });
    h.setCapability({ status: "disabled" });
    expect(await ask(h, { strategy: "customer_connection" })).toEqual({ ok: false, error_code: "capability_unsupported" });
    h.setCapability();
    await h.post("offerings/off_acme_inbox", offeringBody({ status: "disabled" }));
    expect(await ask(h, { strategy: "customer_connection" })).toEqual({ ok: false, error_code: "offering_unavailable" });
  });

  it("picks the most preferred admissible offering and honours a pinned offering id", async () => {
    const h = harness();
    await seed(h, { preference_rank: 50 }, { permitted_offering_ids: ["off_acme_inbox", "off_acme_alt"] });
    expect((await h.post("offerings/off_acme_alt", offeringBody({ preference_rank: 10, status: "disabled" }))).status).toBe(200);
    expect(await ask(h)).toMatchObject({ ok: true, offering: { id: "off_acme_inbox" } });
    await h.post("offerings/off_acme_alt", offeringBody({ preference_rank: 10 }));
    expect(await ask(h)).toMatchObject({ ok: true, offering: { id: "off_acme_alt" } });
    expect(await ask(h, { offeringId: "off_acme_inbox" })).toMatchObject({ ok: true, offering: { id: "off_acme_inbox" } });
    expect(await ask(h, { offeringId: "off_missing" })).toEqual({ ok: false, error_code: "offering_unavailable" });
  });
});
