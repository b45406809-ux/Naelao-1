// MS-47 items 2 and 3: owner suspend/resume and subscription reactivation.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";

const sql = (name: string) => readFileSync(new URL(`../../../../infra/migrations/${name}`, import.meta.url), "utf8");
const BASE = "/spaces/space/assistant-communications";
const AT = new Date().toISOString();

export function lifecycleHarness(flag = true) {
  const f = fixture();
  const db = f.db.db;
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0301_managed_service_subscriptions.sql", "0305_managed_subscription_charges.sql"]) {
    db.exec(sql(name));
  }
  db.exec("PRAGMA foreign_keys = OFF");
  const account = (id: string, space: string, provider: string, service: string, ref: string, state = "active") =>
    db.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,credential_ref,
      owner_type,owner_id,provider_payer_type,lifecycle_state,access_mode,metadata_json,created_at,updated_at)
      VALUES(?,'tenant',?,?,?,'naelao_managed',?,'cred','organization','tenant','platform',?,'managed','{}',?,?)`).run(id, space, provider, service, ref, state, AT, AT);
  account("res-email", "space", "naelao", "email", "inb_1");
  account("res-other-space", "other", "naelao", "email", "inb_2");
  account("res-phone", "space", "telnyx", "phone", "num_1");
  const sending: Array<{ inbox_id: string; paused: boolean; reason?: string }> = [];
  Object.assign(f.env, {
    MANAGED_RESOURCES_PANEL_ENABLED: flag ? "true" : "false", MANAGED_OFFERINGS_ENABLED: "true", MANAGED_SUBSCRIPTIONS_ENABLED: "true",
    NAELAO_EMAIL: { fetch: async (request: Request) => {
      const body = await request.json() as { inbox_id: string; paused: boolean; reason?: string };
      sending.push(body);
      return Response.json({ data: { inbox_id: body.inbox_id, sending_paused: body.paused } });
    } } as unknown as Fetcher,
  });
  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerCommunicationRoutes(app);
  const post = async (body: Record<string, unknown>, role = "owner", method = "POST") => app.request(method === "GET" ? `${BASE}?action=${String(body.action)}&resource_id=${String(body.resource_id)}` : BASE, { method, headers: { "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user",
    "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken("secret", "tenant"), "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }, f.env);
  return { post, sending, db, env: f.env as unknown as AgentsEnv, account };
}

const state = (h: ReturnType<typeof lifecycleHarness>, id = "res-email") =>
  h.db.prepare("SELECT lifecycle_state AS s, json_extract(metadata_json,'$.suspended_by') AS by, row_version AS v FROM managed_service_accounts WHERE id=?").get(id);

describe("owner suspend and resume (MS-47 item 2)", () => {
  it("suspends: pauses sending under the owner tag, marks the row, keeps billing; resume lifts only that pause", async () => {
    const h = lifecycleHarness();
    const suspended = await h.post({ action: "resource-suspend", resource_id: "res-email" });
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toEqual({ resourceId: "res-email", status: "suspended" });
    expect(h.sending).toEqual([{ inbox_id: "inb_1", paused: true, reason: "owner_suspended" }]);
    expect(state(h)).toEqual({ s: "suspended", by: "owner", v: 2 });
    // Idempotent: a repeat does not call the provider again.
    expect((await h.post({ action: "resource-suspend", resource_id: "res-email" })).status).toBe(200);
    expect(h.sending).toHaveLength(1);
    const resumed = await h.post({ action: "resource-resume", resource_id: "res-email" });
    expect(await resumed.json()).toEqual({ resourceId: "res-email", status: "active" });
    expect(h.sending.at(-1)).toEqual({ inbox_id: "inb_1", paused: false, reason: "owner_suspended" });
    expect(state(h)).toEqual({ s: "active", by: null, v: 3 });
  });

  it("refuses to resume while the subscription is suspended for non-payment, and sends nothing", async () => {
    const h = lifecycleHarness();
    await h.post({ action: "resource-suspend", resource_id: "res-email" });
    h.db.prepare(`INSERT INTO managed_service_subscriptions(id,tenant_id,resource_id,subscription_type,offering_id,price_version,interval,current_period_start,current_period_end,
      renewal_state,grace_days,created_at,updated_at) VALUES('sub-1','tenant','inb_1','naelao_email_inbox','off','v1','month',1,2,'suspended',7,1,1)`).run();
    const refused = await h.post({ action: "resource-resume", resource_id: "res-email" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error_code: "subscription_suspended" });
    expect(h.sending).toHaveLength(1);
    expect(state(h)).toMatchObject({ s: "suspended" });
  });

  it("answers not-found for flag off, GET, a non-owner, another Space and an unknown resource; unsupported for other providers", async () => {
    const off = lifecycleHarness(false);
    expect((await off.post({ action: "resource-suspend", resource_id: "res-email" })).status).toBe(404);
    const h = lifecycleHarness();
    expect((await h.post({ action: "resource-suspend", resource_id: "res-email" }, "member")).status).toBe(404);
    expect((await h.post({ action: "resource-suspend", resource_id: "res-other-space" })).status).toBe(404);
    expect((await h.post({ action: "resource-suspend", resource_id: "nope" })).status).toBe(404);
    expect((await h.post({ action: "resource-suspend", resource_id: "res-phone" })).status).toBe(501);
    expect((await h.post({ action: "resource-resume", resource_id: "res-email" })).status).toBe(200); // already active: no-op
    expect(h.sending).toHaveLength(0);
    expect(state(h)).toMatchObject({ s: "active" });
    const get = await h.post({ action: "resource-suspend", resource_id: "res-email" }, "owner", "GET");
    expect(get.status).toBe(404);
  });

  it("keeps the resource active and reports provider_unavailable when the pause cannot be applied", async () => {
    const h = lifecycleHarness();
    (h.env as unknown as { NAELAO_EMAIL: Fetcher }).NAELAO_EMAIL = { fetch: async () => new Response("down", { status: 503 }) } as unknown as Fetcher;
    const response = await h.post({ action: "resource-suspend", resource_id: "res-email" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error_code: "provider_unavailable" });
    expect(state(h)).toMatchObject({ s: "active" });
  });
});

describe("resource-reactivate route (MS-47 item 3)", () => {
  it("is not-found for a non-owner and when the subscription flag is off, 409 without a suspended subscription, and never calls the provider", async () => {
    const h = lifecycleHarness();
    expect((await h.post({ action: "resource-reactivate", resource_id: "res-email" }, "member")).status).toBe(404);
    const noSub = await h.post({ action: "resource-reactivate", resource_id: "res-email" });
    expect(noSub.status).toBe(409);
    expect(await noSub.json()).toEqual({ error_code: "invalid_state" });
    h.db.prepare(`INSERT INTO managed_service_subscriptions(id,tenant_id,resource_id,subscription_type,offering_id,price_version,interval,current_period_start,current_period_end,
      renewal_state,grace_days,created_at,updated_at) VALUES('sub-1','tenant','inb_1','naelao_email_inbox','off','v1','month',1,2,'active',7,1,1)`).run();
    expect(await (await h.post({ action: "resource-reactivate", resource_id: "res-email" })).json()).toEqual({ error_code: "invalid_state" });
    (h.env as unknown as Record<string, string>).MANAGED_SUBSCRIPTIONS_ENABLED = "false";
    expect((await h.post({ action: "resource-reactivate", resource_id: "res-email" })).status).toBe(404);
    expect(h.sending).toHaveLength(0);
  });
});
