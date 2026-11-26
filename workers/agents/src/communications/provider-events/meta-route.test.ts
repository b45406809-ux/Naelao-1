import { describe, expect, it } from "vitest";
import worker from "../../index.js";
import type { AgentsEnv } from "../../index.js";
import { fixture, enableProviderEventModuleFixture } from "../../../../../tests/fixtures/assistant-communications.js";

async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, "0")).join("");
}

describe("Meta WhatsApp extensions webhook, flag off and on", () => {
  for (const flag of [false, true]) {
    it(`flag ${flag ? "on" : "off"}: forged 401; a verified message for an unknown phone number is skipped and dead-lettered only when on`, async () => {
      const f = fixture(); if (flag) enableProviderEventModuleFixture(f.db, f.env);
      f.db.db.exec(`CREATE TABLE IF NOT EXISTS spaces (id TEXT, tenant_id TEXT, status TEXT); CREATE TABLE IF NOT EXISTS orgs (id TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS extension_provider_connections (project_id TEXT, installation_id TEXT, connection_id TEXT, credential_name TEXT, handler_sha256 TEXT, tenant_id TEXT, space_id TEXT, provider TEXT, account_id TEXT, status TEXT)`);
      Object.assign(f.env, { WHATSAPP_APP_SECRET: "app-secret" });
      const ts = String(Math.floor(Date.now() / 1000));
      const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "1234567890" }, messages: [{ id: "wamid.1", from: "15550", timestamp: ts, type: "text", text: { body: "hi" } }] } }] }] });
      const sig = `sha256=${await hmacHex("app-secret", raw)}`;
      const post = (body: string, signature: string) => (worker as unknown as { fetch(r: Request, e: AgentsEnv, c: unknown): Promise<Response> })
        .fetch(new Request("http://agents/channels/whatsapp/extensions", { method: "POST", body, headers: { "x-hub-signature-256": signature } }), f.env, { waitUntil() {}, passThroughOnException() {} });
      expect((await post(raw + " ", sig)).status).toBe(401);
      const ok = await post(raw, sig);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, forwarded: 0 });
      if (flag) {
        expect((await f.db.prepare("SELECT provider,event_id,reason,resource_ref FROM provider_event_dead_letters").all<Record<string, string>>()).results)
          .toEqual([{ provider: "meta", event_id: "wamid.1", reason: "unknown_resource", resource_ref: "1234567890" }]);
      }
    });
  }
});
