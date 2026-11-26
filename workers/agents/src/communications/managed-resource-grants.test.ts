// MS-44: owner-approved AgentPort grant on a reused Managed resource (resource-grant action), behind MANAGED_RESOURCES_PANEL_ENABLED.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";

const sql = (name: string) => readFileSync(new URL(`../../../../infra/migrations/${name}`, import.meta.url), "utf8");
const BASE = "/spaces/space/assistant-communications";

function harness(flag = true) {
  const f = fixture();
  const db = f.db.db;
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0301_managed_service_subscriptions.sql", "0158_agentport_registry.sql"]) db.exec(sql(name));
  db.exec("ALTER TABLE agentport_agents ADD COLUMN host_resource_id TEXT");
  db.exec("PRAGMA foreign_keys = OFF");
  const AT = new Date().toISOString();
  const account = (id: string, space: string, ap: string | null, state: string) =>
    db.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,credential_ref,agentport_account_id,
      owner_type,owner_id,provider_payer_type,lifecycle_state,created_at,updated_at) VALUES(?,'tenant',?,'agentmail','agentmail','naelao_managed','ref','cred',?,'user','user','user',?,?,?)`)
      .run(id, space, ap, state, AT, AT);
  account("res-1", "space", "acct-1", "active"); account("res-noacct", "space", null, "active"); account("res-other", "other-space", "acct-2", "active"); account("res-gone", "space", "acct-3", "revoked");
  db.prepare("INSERT INTO agentport_principals(id,tenant_id,principal_type,external_id,created_at,updated_at) VALUES('prin-1','tenant','organization','tenant',?,?)").run(AT, AT);
  const agent = (id: string, host: string, status: string) => db.prepare(`INSERT INTO agentport_agents(id,tenant_id,principal_id,created_by,host_platform,host_resource_id,status,created_at,updated_at)
    VALUES(?,'tenant','prin-1','user','naelao',?,?,?,?)`).run(id, host, status, AT, AT);
  agent("agent-1", "space-assistant:space", "active"); agent("agent-elsewhere", "space-assistant:other-space", "active"); agent("agent-off", "space", "revoked");
  const grants: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
  Object.assign(f.env, { MANAGED_RESOURCES_PANEL_ENABLED: flag ? "true" : "false" });
  (f.env as unknown as { AGENTPORT_WORKER: Fetcher }).AGENTPORT_WORKER = { fetch: async (request: Request) => {
    grants.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.json() as Record<string, unknown> });
    return Response.json({ grant: { id: "grt" } }, { status: 201 });
  } } as unknown as Fetcher;
  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerCommunicationRoutes(app);
  const post = async (body: Record<string, unknown>, role = "owner") => app.request(BASE, { method: "POST", headers: { "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user",
    "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken("secret", "tenant"), "content-type": "application/json" }, body: JSON.stringify({ action: "resource-grant", ...body }) }, f.env);
  return { post, grants };
}

describe("resource-grant (MS-44)", () => {
  it("grants only the named actions to the named agent on a resource with an AgentPort account", async () => {
    const h = harness();
    const response = await h.post({ resource_id: "res-1", agent_id: "agent-1", actions: ["email.send", "email.send"] });
    expect(response.status).toBe(200);
    expect(h.grants).toHaveLength(1);
    expect(h.grants[0]!.path).toBe("/internal/agentport/accounts/acct-1/grants");
    expect(h.grants[0]!.body).toEqual({ agentId: "agent-1", grantedBy: "user", permissions: ["email.send"] });
    expect(h.grants[0]!.headers.get("x-agentport-owner-id")).toBe("tenant");
  });

  it("answers 409 without a call when the resource has no AgentPort account, and 404 for foreign resources or agents", async () => {
    const h = harness();
    expect(await (await h.post({ resource_id: "res-noacct", agent_id: "agent-1", actions: ["a"] })).json()).toEqual({ error_code: "grant_unavailable" });
    for (const body of [{ resource_id: "res-other", agent_id: "agent-1" }, { resource_id: "res-gone", agent_id: "agent-1" }, { resource_id: "res-1", agent_id: "agent-elsewhere" },
      { resource_id: "res-1", agent_id: "agent-off" }, { resource_id: "res-1", agent_id: "nobody" }]) {
      expect((await h.post({ ...body, actions: ["a"] })).status).toBe(404);
    }
    expect((await h.post({ resource_id: "res-1", agent_id: "agent-1", actions: [] })).status).toBe(400);
    expect(h.grants).toHaveLength(0);
  });

  it("is not-found for flag off and for a non-owner", async () => {
    expect((await harness(false).post({ resource_id: "res-1", agent_id: "agent-1", actions: ["a"] })).status).toBe(404);
    const h = harness();
    expect((await h.post({ resource_id: "res-1", agent_id: "agent-1", actions: ["a"] }, "member")).status).toBe(404);
    expect(h.grants).toHaveLength(0);
  });
});
