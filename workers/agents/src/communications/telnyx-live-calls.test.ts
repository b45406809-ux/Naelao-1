import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { ensureIdentity } from "./core.js";
import { defaultPhonePolicy, type AssistantPhoneBinding } from "./phones.js";
import { dispatchTelnyxVoiceEvent } from "./telnyx-live-calls.js";

afterEach(() => vi.unstubAllGlobals());

describe("Telnyx live call command contract", () => {
  it("uses the current provider-qualified voice and millisecond gather fields", async () => {
    const f = fixture();
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100",
    }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'assistant','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("binding-1", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='binding-1'").first<AssistantPhoneBinding>();
    expect(binding).not.toBeNull();
    const now = Math.floor(Date.now() / 1000);
    await f.db.prepare("INSERT INTO assistant_live_calls(id,binding_id,tenant_id,space_id,user_id,caller_role,session_id,code_hash,status,expires_at,created_at) VALUES('live-1','binding-1',?,?,?,'owner','session-1','hash','armed',?,?)")
      .bind(scope.tenantId, scope.spaceId, scope.userId, now + 300, now).run();
    await f.db.prepare("INSERT INTO assistant_telnyx_live_calls(call_control_id,binding_id,live_call_id,state,created_at,updated_at) VALUES('v3:call-control-1','binding-1','live-1','answering',?,?)")
      .bind(now, now).run();

    const carrier = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const result = await dispatchTelnyxVoiceEvent(
      f.env as AgentsEnv,
      binding!,
      identity,
      { eventId: "answered-1", eventType: "call.answered", payload: { call_control_id: "v3:call-control-1" } },
    );

    expect(result).toMatchObject({ accepted: true, awaiting_code: true });
    expect(carrier).toHaveBeenCalledTimes(1);
    const [url, init] = carrier.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telnyx.com/v2/calls/v3%3Acall-control-1/actions/gather_using_speak");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      voice: "AWS.Polly.Joanna",
      language: "en-US",
      minimum_digits: 8,
      maximum_digits: 8,
      timeout_millis: 15_000,
      inter_digit_timeout_millis: 5_000,
      command_id: expect.stringContaining("code"),
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("timeout_secs");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("inter_digit_timeout_secs");
  });
});
