// MS-44: template resource requirements. Local/mock evidence: a real SpaceDO (SQLite shim) behind the real Hono routes, mocked agents worker.
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { certifyStateDeltaArtifact } from "@naelao/security";
import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";
import worker from "./index.js";
import { SpaceDO } from "./do/SpaceDO.js";

const SECRET = "template-resource-secret";
const TENANT = "tenant-res";
const artifact: SpaceBlueprint = {
  id: "tpl_resources", schemaVersion: "2.0", metadata: { name: "Resources" }, templateCategory: "other", projects: [], requiredExtensions: [], requiredCredentials: [],
  resourceRequirements: [
    { key: "inbox", resourceType: "email.inbox", required: true, preferredAccessMode: "managed", capabilities: ["send"], grants: [{ roleKey: "sales", actions: ["email.send"] }] },
    { key: "voice", resourceType: "voice.number", required: false },
  ],
};

async function harness(options: { flag?: boolean; provisionError?: string; linked?: boolean; resources?: Array<Record<string, unknown>>; quotePrice?: number } = {}) {
  const { flag = true, resources = [{ id: "res_existing", display_name: "Sales inbox", region: "us", access_mode: "managed" }], quotePrice = 100 } = options;
  const certificate = await certifyStateDeltaArtifact(artifact, { fixtures: Array.from({ length: 50 }, (_, i) => ({ id: `r-${i}` })) },
    { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, SECRET, TENANT);
  if (!certificate) throw new Error("test_certificate_not_issued");
  const storage = createDOStorage();
  const realDo = new SpaceDO({ storage } as never, { PLATFORM_SECRET: SECRET } as never);
  await realDo.fetch(new Request("https://space/template-resource-proposals"));
  const stub = { fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/template-resource-proposals")) return realDo.fetch(request);
    if (url.pathname === "/extension-installations") return Response.json({ installations: [] });
    if (url.pathname === "/blueprints/instantiate") return Response.json({ projectIds: [] }, { status: 201 });
    return new Response("not found", { status: 404 });
  } };
  const agentCalls: Array<{ method: string; action: string; body: Record<string, unknown> }> = [];
  const counts = { quote: 0, provision: 0, grant: 0 };
  const AGENTS_WORKER = { fetch: async (request: Request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? Object.fromEntries(url.searchParams) : await request.json() as Record<string, unknown>;
    const action = String(body.action);
    agentCalls.push({ method: request.method, action, body });
    if (action === "resource-options") return Response.json({ options: [
      { offeringId: "off_email", displayName: "Naelao Email", region: "us", minMonthlyCredits: quotePrice, initialCredits: quotePrice, components: [{ kind: "rental", credits: quotePrice, interval: "month" }] },
    ], selectedOfferingId: "off_email", reason: "Naelao Email is the only available option." });
    if (action === "resource-quote") { counts.quote++; return Response.json({ quote: { quoteId: `msq_${"a".repeat(31)}${counts.quote}`, minMonthlyCredits: 100, credits: 100 } }); }
    if (action === "resource-provision") {
      counts.provision++;
      return options.provisionError ? Response.json({ error_code: options.provisionError }, { status: 502 }) : Response.json({ operationId: "res_op_1", offeringId: "off_email", resource: { resourceType: "email.inbox", status: "active" },
        ...(options.linked ? { resourceId: "msa_new", agentPortLinked: true } : {}) });
    }
    if (action === "resource-grant") { counts.grant++; return Response.json({ ok: true }); }
    return new Response("nope", { status: 404 });
  } };
  const db = { prepare: (sql: string) => ({ bind: (..._args: unknown[]) => ({
    first: async () => /FROM spaces/.test(sql) ? { id: "space-res", config_json: "{}" }
      : /SELECT id FROM managed_resources/.test(sql) ? (resources.find((r) => r.id === _args[0]) ? { id: _args[0] } : null) : null,
    all: async () => ({ results: /FROM managed_resources/.test(sql) ? resources : [] }),
    run: async () => ({ success: true }),
  }) }) };
  const env = { PLATFORM_SECRET: SECRET, PLATFORM_DB: db, AGENTS_WORKER,
    ...(flag ? { TEMPLATE_RESOURCE_REQUIREMENTS_ENABLED: "true" } : {}),
    SCRIPTS_R2: { get: async (key: string) => key === `blueprints/${TENANT}/${artifact.id}.json` ? { json: async () => ({ blueprint: artifact, conformanceCertificate: certificate }) } : null },
    SPACE_DO: { idFromName: () => "do", get: () => stub } } as never;
  const headers = async (role = "owner") => ({ "x-naelao-tenant-id": TENANT, "x-naelao-user-id": "owner", "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT) });
  const call = async (path: string, init: { method?: string; role?: string; body?: unknown } = {}) =>
    worker.fetch(new Request(`https://spaces/spaces/space-res/${path}`, { method: init.method ?? "GET", headers: await headers(init.role),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), env, {} as ExecutionContext);
  const resourceCalls = () => agentCalls.filter((c) => c.action !== "identity");
  const proposals = async () => (await (await call("template-resource-proposals")).json<{ proposals: Array<{ id: string; requirement_key: string; status: string }> }>()).proposals;
  const activate = () => call(`blueprints/${artifact.id}/activate`, { method: "POST", body: {} });
  return { call, proposals, activate, agentCalls: { get length() { return resourceCalls().length; }, every: (fn: (c: { method: string; action: string }) => boolean) => resourceCalls().every(fn), find: (fn: (c: { action: string; body: Record<string, unknown> }) => boolean) => resourceCalls().find(fn) }, counts, storage };
}

const approveCreate = (id: string, extra: Record<string, unknown> = {}) => ({ id, decision: "approve",
  choice: { kind: "create", offering_id: "off_email", region: "us", acknowledged_min_monthly_credits: 100, acknowledged_initial_credits: 100 }, ...extra });

describe("template resource requirements (MS-44)", () => {
  it("previews reuse first, then create with prices, then connect, with skip only for optional lines, and spends nothing", async () => {
    const h = await harness();
    const preview = await (await h.call(`blueprints/${artifact.id}/activation-preview`)).json<{ resource_requirements: Array<Record<string, unknown> & { options: Array<{ kind: string }> }> }>();
    expect(preview.resource_requirements.map((r) => r.key)).toEqual(["inbox", "voice"]);
    expect(preview.resource_requirements[0]!.options.map((o) => o.kind)).toEqual(["reuse", "create_managed", "connect_byok"]);
    expect(preview.resource_requirements[0]!.options[1]).toMatchObject({ offering_id: "off_email", min_monthly_credits: 100, initial_credits: 100, recommended: true });
    expect(preview.resource_requirements[0]).toMatchObject({ spend_applied: false, grants_applied: false, proposed_grants: [{ roleKey: "sales", actions: ["email.send"] }] });
    expect(preview.resource_requirements[1]!.options.at(-1)).toEqual({ kind: "skip" });
    expect(h.agentCalls.every((c) => c.method === "GET" && c.action === "resource-options")).toBe(true);
    expect(h.counts).toEqual({ quote: 0, provision: 0, grant: 0 });
  });

  it("activation stores pending proposals only: no quote, provision or grant, and a replay stores nothing new", async () => {
    const h = await harness();
    const first = await h.activate();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ resourceProposals: { created: 2, existing: 0, status: "stored" } });
    // Both rows share a created_at millisecond, so the list order is not guaranteed: compare by key.
    expect([...await h.proposals()].sort((a, b) => a.requirement_key.localeCompare(b.requirement_key))).toMatchObject([{ requirement_key: "inbox", status: "proposed" }, { requirement_key: "voice", status: "proposed" }]);
    expect(await (await h.activate()).json()).toMatchObject({ resourceProposals: { created: 0, existing: 2 } });
    expect(h.agentCalls.length).toBe(0);
    expect(h.counts).toEqual({ quote: 0, provision: 0, grant: 0 });
  });

  it("flag off leaves preview, activation and routes unchanged", async () => {
    const h = await harness({ flag: false });
    const preview = await (await h.call(`blueprints/${artifact.id}/activation-preview`)).json<Record<string, unknown>>();
    expect(preview).not.toHaveProperty("resource_requirements");
    expect(await (await h.activate()).json()).not.toHaveProperty("resourceProposals");
    expect((await h.call("template-resource-proposals")).status).toBe(404);
    expect((await h.call("template-resource-proposals", { method: "POST", body: { id: "x", decision: "skip" } })).status).toBe(404);
    expect(h.agentCalls.length).toBe(0);
    expect(h.storage.sql.exec("SELECT COUNT(*) AS n FROM template_resource_proposals").toArray()).toEqual([{ n: 0 }]);
  });

  it("approval provisions exactly once; a repeat or concurrent approval does not provision again", async () => {
    const h = await harness();
    await h.activate();
    const inbox = (await h.proposals()).find((p) => p.requirement_key === "inbox")!;
    const [a, b] = await Promise.all([
      h.call("template-resource-proposals", { method: "POST", body: approveCreate(inbox.id, { grant_agent_ids: { sales: ["agent-1"] } }) }),
      h.call("template-resource-proposals", { method: "POST", body: approveCreate(inbox.id) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const again = await h.call("template-resource-proposals", { method: "POST", body: approveCreate(inbox.id) });
    expect(again.status).toBe(409);
    expect(h.counts.provision).toBe(1);
    expect(h.counts.quote).toBe(1);
    const created = [a, b].find((r) => r.status === 201)!;
    expect(await created.json()).toMatchObject({ status: "approved", choice: "create", operation_id: "res_op_1" });
    // A provision that reports no linked AgentPort account leaves named grants deferred, not applied.
    expect(h.counts.grant).toBe(0);
    expect((await h.proposals()).map((p) => p.requirement_key)).toEqual(["voice"]);
  });

  it("MS-47: a newly provisioned resource with an AgentPort account takes the named grants now", async () => {
    const h = await harness({ linked: true });
    await h.activate();
    const inbox = (await h.proposals()).find((p) => p.requirement_key === "inbox")!;
    const response = await h.call("template-resource-proposals", { method: "POST", body: approveCreate(inbox.id, { grant_agent_ids: { sales: ["agent-1"] } }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "approved", resource_id: "msa_new", grants: [{ agent_id: "agent-1", status: "granted" }] });
    expect(h.counts.grant).toBe(1);
    expect(h.agentCalls.find((c) => c.action === "resource-grant")?.body).toMatchObject({ resource_id: "msa_new", agent_id: "agent-1" });
  });

  it("refuses to provision when the price changed after the owner saw it", async () => {
    const h = await harness();
    await h.activate();
    const inbox = (await h.proposals()).find((p) => p.requirement_key === "inbox")!;
    const stale = approveCreate(inbox.id);
    (stale.choice as Record<string, unknown>).acknowledged_min_monthly_credits = 50;
    const response = await h.call("template-resource-proposals", { method: "POST", body: stale });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "price_changed", min_monthly_credits: 100 });
    expect(h.counts.provision).toBe(0);
    expect((await h.proposals()).find((p) => p.id === inbox.id)?.status).toBe("proposed");
  });

  it("reuses an existing resource without spend and applies grants only to the agents the approver names", async () => {
    const h = await harness();
    await h.activate();
    const inbox = (await h.proposals()).find((p) => p.requirement_key === "inbox")!;
    const foreignRole = await h.call("template-resource-proposals", { method: "POST", body: { id: inbox.id, decision: "approve",
      choice: { kind: "reuse", resource_id: "res_existing" }, grant_agent_ids: { admin: ["agent-1"] } } });
    expect(foreignRole.status).toBe(400);
    const missing = await h.call("template-resource-proposals", { method: "POST", body: { id: inbox.id, decision: "approve", choice: { kind: "reuse", resource_id: "res_other_space" } } });
    expect(missing.status).toBe(409);
    expect((await h.proposals()).find((p) => p.id === inbox.id)?.status).toBe("proposed");
    const approved = await h.call("template-resource-proposals", { method: "POST", body: { id: inbox.id, decision: "approve",
      choice: { kind: "reuse", resource_id: "res_existing" }, grant_agent_ids: { sales: ["agent-1"] } } });
    expect(approved.status).toBe(201);
    expect(await approved.json()).toMatchObject({ choice: "reuse", resource_id: "res_existing", grants: [{ role_key: "sales", agent_id: "agent-1", status: "granted" }] });
    expect(h.counts).toEqual({ quote: 0, provision: 0, grant: 1 });
    expect(h.agentCalls.find((c) => c.action === "resource-grant")?.body).toMatchObject({ resource_id: "res_existing", agent_id: "agent-1", actions: ["email.send"] });
  });

  it("answers not-found to a non-owner and changes nothing", async () => {
    const h = await harness();
    await h.activate();
    const inbox = (await h.proposals()).find((p) => p.requirement_key === "inbox")!;
    for (const role of ["member", "viewer", "editor"]) {
      const list = await h.call("template-resource-proposals", { role });
      expect(list.status).toBe(404);
      expect(await list.json()).toEqual({ error_code: "not_found" });
      const post = await h.call("template-resource-proposals", { method: "POST", role, body: approveCreate(inbox.id) });
      expect(post.status).toBe(404);
      expect(await post.json()).toEqual({ error_code: "not_found" });
    }
    expect(h.counts).toEqual({ quote: 0, provision: 0, grant: 0 });
    expect((await h.proposals()).find((p) => p.id === inbox.id)?.status).toBe("proposed");
  });

  it("lets only optional lines be skipped", async () => {
    const h = await harness();
    await h.activate();
    const [inbox, voice] = [(await h.proposals()).find((p) => p.requirement_key === "inbox")!, (await h.proposals()).find((p) => p.requirement_key === "voice")!];
    const required = await h.call("template-resource-proposals", { method: "POST", body: { id: inbox.id, decision: "skip" } });
    expect(required.status).toBe(409);
    expect(await required.json()).toEqual({ error_code: "required_resource_cannot_be_skipped" });
    expect((await h.call("template-resource-proposals", { method: "POST", body: { id: voice.id, decision: "skip" } })).status).toBe(200);
    expect((await h.call("template-resource-proposals", { method: "POST", body: { id: voice.id, decision: "skip" } })).status).toBe(409);
    expect(h.agentCalls.length).toBe(0);
  });

  it("keeps an uncertain provision outcome and refuses a blind retry", async () => {
    const h = await harness({ provisionError: "outcome_unknown" });
    await h.activate();
    const inbox = (await h.proposals()).find((p) => p.requirement_key === "inbox")!;
    const first = await h.call("template-resource-proposals", { method: "POST", body: approveCreate(inbox.id) });
    expect(first.status).toBe(502);
    expect((await h.proposals()).find((p) => p.id === inbox.id)?.status).toBe("uncertain");
    expect((await h.call("template-resource-proposals", { method: "POST", body: approveCreate(inbox.id) })).status).toBe(409);
    expect(h.counts.provision).toBe(1);
  });

  it("releases the proposal after a definite provision failure so the owner can retry", async () => {
    const h = await harness({ provisionError: "provision_failed" });
    await h.activate();
    const inbox = (await h.proposals()).find((p) => p.requirement_key === "inbox")!;
    expect((await h.call("template-resource-proposals", { method: "POST", body: approveCreate(inbox.id) })).status).toBe(502);
    expect((await h.proposals()).find((p) => p.id === inbox.id)?.status).toBe("proposed");
  });
});
