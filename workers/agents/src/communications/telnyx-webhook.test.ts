import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { ensureIdentity } from "./core.js";
import { defaultPhonePolicy } from "./phones.js";
import { registerTelnyxWebhook } from "./telnyx-webhook.js";

describe("Telnyx extension ingress", () => {
  it("authenticates destination and dispatches once under concurrent delivery", async () => {
    const f = fixture();
    f.db.db.exec(readFileSync(new URL("../../../../infra/migrations/0137_telnyx_ingress_receipts.sql", import.meta.url), "utf8"));
    f.fetch.mockImplementation(async (r: Request) => r.url.includes("assistant-access") ? Response.json({ effective_role: "owner" }) : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    const dispatch = vi.fn(async () => Response.json({ message: "" }));
    f.env.AGENTS_WORKER = { fetch: dispatch } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')").bind("binding-1", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('binding-1','ext-1',?,'active')").bind("a".repeat(64)).run();
    const raw = JSON.stringify({ data: { id: "event-1", event_type: "message.received", occurred_at: new Date().toISOString(), payload: { direction: "inbound", from: { phone_number: "+14155550101" }, to: [{ phone_number: "+14155550100" }], text: "hello", media: [] } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString("base64");
    const app = new Hono<{ Bindings: AgentsEnv }>(); registerTelnyxWebhook(app);
    const request = (body: string, signed = signature) => app.request("http://example/assistant-phone/telnyx/binding-1", { method: "POST", headers: { "telnyx-signature-ed25519": signed, "telnyx-timestamp": timestamp }, body }, f.env);
    expect((await request(raw + " ")).status).toBe(401);
    const wrongDestination = raw.replace("+14155550100", "+14155550102");
    const wrongSignature = sign(null, Buffer.from(`${timestamp}|${wrongDestination}`), keys.privateKey).toString("base64");
    expect((await request(wrongDestination, wrongSignature)).status).toBe(422);
    expect(dispatch).not.toHaveBeenCalled();
    const results = await Promise.all(Array.from({ length: 10 }, () => request(raw)));
    expect(results.filter(result => result.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await request(raw)).status).toBe(200);
  });
});
