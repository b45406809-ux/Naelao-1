import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../../../tests/stubs/d1-sqlite.js";
import { enableProviderEventModuleFixture } from "../../../../../tests/fixtures/assistant-communications.js";
import { app } from "../../index.js";

// MS-49: the Meta direct route (/channels/whatsapp/extensions) and the per-channel route (/channels/whatsapp/inbound/:spaceId) call
// ingestProviderEvent when PROVIDER_EVENT_MODULE_ENABLED is on. Provider-facing responses match the flag-off routes.
const tenantId = "tenant-a", spaceId = "space-a", projectId = "project-a", installationId = "install-a", connectionId = "conn-a";
const phoneNumberId = "123456789012345", appSecret = "meta-app-secret";
const handler = new TextEncoder().encode("export default {}");
const migrationFiles = ["0002_orgs.sql", "0003_spaces.sql", "0038_channel_links.sql", "0039_channel_links_project.sql", "0099_channel_model_overrides.sql",
  "0103_channel_extension_bindings.sql", "0112_extension_provider_connections.sql", "0113_whatsapp_extension_phone_routing.sql", "0288_whatsapp_member_routing_mode.sql"];

async function sha256(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function signature(body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}
const message = (id: string) => ({ id, from: "15551230000", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "private customer text" } });
const webhook = (...ids: string[]) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages",
  value: { metadata: { phone_number_id: phoneNumberId, display_phone_number: "+15550000000" }, contacts: [{ wa_id: "15551230000" }], messages: ids.map(message) } }] }] });

async function harness(flag: boolean) {
  const db = createFakeD1(migrationFiles.map(name => readFileSync(new URL(`../../../../../infra/migrations/${name}`, import.meta.url), "utf8")));
  const handlerHash = await sha256(handler);
  db.db.exec(`INSERT INTO orgs(id,name,owner_id,status) VALUES('${tenantId}','T','owner','active');
    INSERT INTO spaces(id,tenant_id,spacetype_id,name,status,config_json) VALUES('${spaceId}','${tenantId}','type','S','active','{}');
    INSERT INTO channel_links(space_id,tenant_id,channel,enabled,project_id) VALUES('${spaceId}','${tenantId}','whatsapp',1,'${projectId}');
    INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,credential_name,handler_sha256,status,connected_by,connected_at,updated_at)
      VALUES('${tenantId}','${spaceId}','${projectId}','${installationId}','${connectionId}','whatsapp','${phoneNumberId}','WA_TOKEN','${handlerHash}','active','u','t','t');`);
  const env: Record<string, unknown> = { PLATFORM_DB: db, PLATFORM_SECRET: "platform-secret", WHATSAPP_APP_SECRET: appSecret, PUBLIC_AGENTS_URL: "https://agents.test" };
  if (flag) enableProviderEventModuleFixture(db, env as never); else env.PROVIDER_EVENT_MODULE_ENABLED = "false";
  const wakes: Array<Record<string, unknown>> = [];
  env.NAELAO_AGENT_DO = { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => { wakes.push(await r.json() as Record<string, unknown>); return Response.json({ ok: true }); } }) };
  env.SPACES_WORKER = { fetch: async () => Response.json({ instance: { instance_id: installationId, tenant_id: tenantId, space_id: spaceId, project_id: projectId, status: "active", scope: "PROJECT_SHARED" },
    manifest: { bundle: { id: "bundle", version: "1.0.0", connections: [{ id: connectionId, provider: "whatsapp" }] }, channels: [{ kind: "channel", provider: "whatsapp", connectionId, handlerScript: "handler.js" }] },
    release: { signatureValid: true } }) };
  env.SCRIPTS_R2 = { get: async () => ({ size: handler.byteLength, arrayBuffer: async () => handler.slice().buffer }) };
  env.CREDENTIALS_WORKER = { fetch: async (r: Request) => Response.json({ value: r.url.includes("WHATSAPP_APP_SECRET") ? appSecret : "access-token" }) };
  const send = async (path: string, body: string, forged = false) => app.request(path, { method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": forged ? "sha256=" + "0".repeat(64) : await signature(body) }, body }, env as never);
  const rows = async (sql: string) => { try { return (await db.prepare(sql).all<Record<string, unknown>>()).results; } catch { return []; } };
  return { db, env, wakes, send, rows };
}

afterEach(() => vi.unstubAllGlobals());

describe("Meta direct route /channels/whatsapp/extensions through the module (MS-49)", () => {
  const path = "/channels/whatsapp/extensions";
  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: forged 401, forward 200, replay 200, dedup record only when on`, async () => {
      const h = await harness(flag);
      expect((await h.send(path, webhook("wamid.1"), true)).status).toBe(401);
      const first = await h.send(path, webhook("wamid.1"));
      expect(first.status).toBe(200); expect(await first.json()).toEqual({ ok: true, forwarded: 1 });
      expect(h.wakes).toHaveLength(1);
      const replay = await h.send(path, webhook("wamid.1"));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, forwarded: flag ? 0 : 1 });
      expect(h.wakes).toHaveLength(flag ? 1 : 2);
      expect(await h.rows("SELECT provider,event_id,event_type FROM processed_webhook_events")).toEqual(flag ? [{ provider: "meta", event_id: "wamid.1", event_type: "message.received" }] : []);
    });
  }

  it("flag on: a pre-claimed event is a duplicate before any side effect, and one body with two messages claims each", async () => {
    const h = await harness(true);
    await h.db.prepare("INSERT INTO processed_webhook_events(provider,event_id,event_type) VALUES('meta','wamid.a','message.received')").run();
    const response = await h.send(path, webhook("wamid.a", "wamid.b"));
    expect(await response.json()).toEqual({ ok: true, forwarded: 1 });
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.taskId).toBe("wamid.b");
    expect((await h.rows("SELECT event_id FROM processed_webhook_events ORDER BY event_id")).map(r => r.event_id)).toEqual(["wamid.a", "wamid.b"]);
  });

  it("flag on: an unknown phone number and a revoked connection are skipped with 200, never woken, and dead-lettered without the body", async () => {
    const h = await harness(true);
    await h.db.prepare("UPDATE extension_provider_connections SET status='revoked'").run();
    const response = await h.send(path, webhook("wamid.r"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, forwarded: 0 });
    expect(h.wakes).toHaveLength(0);
    const dead = await h.rows("SELECT provider,event_id,reason,resource_ref,body_sha256 FROM provider_event_dead_letters");
    expect(dead).toMatchObject([{ provider: "meta", event_id: "wamid.r", reason: "unknown_resource", resource_ref: phoneNumberId }]);
    expect(JSON.stringify(dead)).not.toContain("private customer text");
    expect(await h.rows("SELECT * FROM processed_webhook_events")).toEqual([]);
  });

  it("flag on: a grant revoked after the lookup and before the wake stops the wake and leaves no claim", async () => {
    const h = await harness(true);
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = (sql: string) => { if (sql.includes("FROM extension_provider_connections") && sql.includes("installation_id||':'||connection_id")) h.db.db.exec("UPDATE extension_provider_connections SET status='revoked'"); return prepare(sql); };
    const response = await h.send(path, webhook("wamid.m"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, forwarded: 0 });
    expect(h.wakes).toHaveLength(0);
    expect(await h.rows("SELECT * FROM processed_webhook_events")).toEqual([]);
  });

  it("flag on: a skipped message (handler missing) releases its claim so a later retry can still be forwarded", async () => {
    const h = await harness(true);
    const r2 = h.env.SCRIPTS_R2; h.env.SCRIPTS_R2 = { get: async () => null };
    expect(await (await h.send(path, webhook("wamid.s"))).json()).toEqual({ ok: true, forwarded: 0 });
    expect(await h.rows("SELECT * FROM processed_webhook_events")).toEqual([]);
    h.env.SCRIPTS_R2 = r2;
    expect(await (await h.send(path, webhook("wamid.s"))).json()).toEqual({ ok: true, forwarded: 1 });
  });
});

describe("Meta per-channel route /channels/whatsapp/inbound/:spaceId through the module (MS-49)", () => {
  const path = `/channels/whatsapp/inbound/${spaceId}`;
  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: forged 401, status callback 200, delivery 200 with the Agent DO woken, replay 200`, async () => {
      const h = await harness(flag);
      expect((await h.send(path, webhook("wamid.1"), true)).status).toBe(401);
      const status = await h.send(path, JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: "x" }] } }] }] }));
      expect(status.status).toBe(200);
      const afterStatus = h.wakes.length; // not a message: the route handles it as it always did, with or without the module
      const first = await h.send(path, webhook("wamid.1"));
      expect(first.status).toBe(200); expect(await first.json()).toEqual({ ok: true });
      expect(h.wakes).toHaveLength(afterStatus + 1);
      const replay = await h.send(path, webhook("wamid.1"));
      expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ok: true });
      expect(h.wakes).toHaveLength(afterStatus + (flag ? 1 : 2));
      expect(await h.rows("SELECT provider,event_id FROM processed_webhook_events")).toEqual(flag ? [{ provider: "meta", event_id: "wamid.1" }] : []);
    });
  }

  it("flag on: a channel disabled before the request is skipped as before; one disabled right before the wake is acknowledged without a wake or a claim", async () => {
    const h = await harness(true);
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = (sql: string) => { if (sql.includes("SELECT 1 AS ok FROM channel_links")) h.db.db.exec("UPDATE channel_links SET enabled=0"); return prepare(sql); };
    const response = await h.send(path, webhook("wamid.g"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, skipped: "channel_disabled" });
    expect(h.wakes).toHaveLength(0); expect(await h.rows("SELECT * FROM processed_webhook_events")).toEqual([]);
    h.db.prepare = prepare;
    const later = await h.send(path, webhook("wamid.h"));
    expect(await later.json()).toEqual({ ok: true, skipped: "channel_disabled" });
  });

  it("flag on: a pre-claimed event is not woken again", async () => {
    const h = await harness(true);
    await h.db.prepare("INSERT INTO processed_webhook_events(provider,event_id,event_type) VALUES('meta','wamid.p','message.received')").run();
    const response = await h.send(path, webhook("wamid.p"));
    expect(response.status).toBe(200); expect(h.wakes).toHaveLength(0);
  });

  it("flag on: a rejected downstream step (voice or media 4xx/5xx) releases the claim so the provider retry is processed", async () => {
    const h = await harness(true);
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId },
      messages: [{ id: "wamid.v", from: "15551230000", timestamp: String(Math.floor(Date.now() / 1000)), type: "audio", audio: { id: "media-1", voice: true } }] } }] }] });
    h.env.CREDENTIALS_WORKER = { fetch: async (r: Request) => r.url.includes("WHATSAPP_APP_SECRET") ? Response.json({ value: appSecret }) : Response.json({}, { status: 404 }) };
    const response = await h.send(path, body);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error_code: "whatsapp_media_access_token_missing" });
    expect(await h.rows("SELECT * FROM processed_webhook_events")).toEqual([]);
  });
});
