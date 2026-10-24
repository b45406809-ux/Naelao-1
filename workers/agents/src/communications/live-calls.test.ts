import { describe, it, expect } from "vitest";
import {
  fixture,
  scope,
} from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import {
  armLiveCall,
  claimLiveCall,
  liveCodeHash,
  liveCallAllowed,
} from "./live-calls.js";
import { defaultPhonePolicy, type AssistantPhoneBinding } from "./phones.js";
async function setup() {
  const f = fixture(),
    identity = await ensureIdentity(f.env, scope);
  await f.db
    .prepare(
      "INSERT INTO assistant_phone_bindings(id,identity_id,payer,provider_account_sid,provider_number_sid,phone_number,country_code,capabilities_json,previous_callbacks_json,status,policy_json) VALUES(?,?,'byo',?,?,?,'US','{}','{}','active',?)"
    )
    .bind(
      "binding",
      identity.id,
      "AC" + "a".repeat(32),
      "PN" + "a".repeat(32),
      "+14155550100",
      JSON.stringify(defaultPhonePolicy)
    )
    .run();
  const binding = (await f.db
    .prepare("SELECT * FROM assistant_phone_bindings")
    .first<AssistantPhoneBinding>())!;
  f.fetch.mockImplementation(async () =>
    Response.json({ id: "session", project_id: scope.projectId })
  );
  return { ...f, binding };
}
const sid = "CA" + "a".repeat(32);
describe("app-authorized live telephone sessions", () => {
  it("stores only a hashed, short-lived code bound to the acting user and conversation", async () => {
    const f = await setup();
    const armed = await armLiveCall(f.env, scope, f.binding, "session");
    expect(armed.code).toMatch(/^\d{8}$/);
    const row = await f.db
      .prepare("SELECT * FROM assistant_live_calls")
      .first();
    expect(row).toMatchObject({
      code_hash: await liveCodeHash(f.binding.id, armed.code),
      user_id: scope.userId,
      session_id: "session",
      status: "armed",
    });
    expect(JSON.stringify(row)).not.toContain('"' + armed.code + '"');
  });
  it("claims exactly one call and never extends its deadline on callback retries", async () => {
    const f = await setup();
    const armed = await armLiveCall(f.env, scope, f.binding, "session");
    const first = await claimLiveCall(f.env, f.binding, sid, armed.code, 300);
    expect(first?.status).toBe("connected");
    expect(
      await claimLiveCall(
        f.env,
        f.binding,
        "CA" + "b".repeat(32),
        armed.code,
        300
      )
    ).toBeNull();
    expect(
      (await claimLiveCall(f.env, f.binding, sid, armed.code, 900))?.deadline
    ).toBe(first?.deadline);
  });
  it("limits guessing and rejects expired/revoked codes", async () => {
    const f = await setup();
    const armed = await armLiveCall(f.env, scope, f.binding, "session");
    const wrong = armed.code === "00000000" ? "11111111" : "00000000";
    for (let n = 0; n < 5; n++)
      expect(await claimLiveCall(f.env, f.binding, sid, wrong, 300)).toBeNull();
    expect(
      await claimLiveCall(f.env, f.binding, sid, armed.code, 300)
    ).toBeNull();
    await f.db.prepare("UPDATE assistant_live_calls SET expires_at=0").run();
    expect(
      await claimLiveCall(
        f.env,
        f.binding,
        "CA" + "b".repeat(32),
        armed.code,
        300
      )
    ).toBeNull();
  });
  it("rearming revokes an older code and cross-project conversation binding is denied", async () => {
    const f = await setup();
    const previous = await armLiveCall(f.env, scope, f.binding, "session");
    await armLiveCall(f.env, scope, f.binding, "session");
    expect(
      await claimLiveCall(f.env, f.binding, sid, previous.code, 300)
    ).toBeNull();
    f.fetch.mockImplementation(async () =>
      Response.json({ id: "session", project_id: "other" })
    );
    await expect(
      armLiveCall(f.env, scope, f.binding, "session")
    ).rejects.toThrow("voice_session_project_mismatch");
  });
  it("isolates Space and Project codes under concurrent claim pressure", async () => {
    const f = await setup();
    const armed = await armLiveCall(f.env, scope, f.binding, "session");
    const calls = await Promise.all(
      Array.from({ length: 100 }, (_, n) =>
        claimLiveCall(
          f.env,
          f.binding,
          "CA" + n.toString(16).padStart(32, "0"),
          armed.code,
          300
        )
      )
    );
    expect(calls.filter(Boolean)).toHaveLength(1);
  });
});

describe("private member telephone boundaries", () => {
  it("does not revoke another member's authorization when rearming", async () => {
    const f = await setup();
    const first = await armLiveCall(f.env, scope, f.binding, "session");
    const otherScope = { ...scope, userId: "another-member" };
    const other = await armLiveCall(f.env, otherScope, f.binding, "session");
    const replacement = await armLiveCall(f.env, scope, f.binding, "session");
    expect(
      await claimLiveCall(f.env, f.binding, sid, first.code, 300)
    ).toBeNull();
    expect(
      (
        await claimLiveCall(
          f.env,
          f.binding,
          "CA" + "b".repeat(32),
          other.code,
          300
        )
      )?.user_id
    ).toBe(otherScope.userId);
    expect(
      (
        await claimLiveCall(
          f.env,
          f.binding,
          "CA" + "c".repeat(32),
          replacement.code,
          300
        )
      )?.user_id
    ).toBe(scope.userId);
  });
  it("cannot authorize or continue an internal call on an extension line", async () => {
    const f = await setup();
    const armed = await armLiveCall(f.env, scope, f.binding, "session");
    const live = await claimLiveCall(f.env, f.binding, sid, armed.code, 300);
    await f.db
      .prepare("UPDATE assistant_phone_bindings SET purpose='extension'")
      .run();
    expect(await liveCallAllowed(f.env, live!)).toBe(false);
    const external = { ...f.binding, purpose: "extension" as const };
    await expect(
      armLiveCall(f.env, scope, external, "session")
    ).rejects.toThrow("internal_assistant_line_required");
    expect(
      await claimLiveCall(f.env, external, sid, armed.code, 300)
    ).toBeNull();
  });
});
