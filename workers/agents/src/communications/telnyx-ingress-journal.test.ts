import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import { claimTelnyxIngress, finishTelnyxIngress } from "./telnyx-ingress-journal.js";

describe("Telnyx ingress journal", () => {
  it("claims duplicates once, detects conflicting bodies and never automatically replays a pending claim", async () => {
    const f = fixture();
    f.db.db.exec(readFileSync(new URL("../../../../infra/migrations/0137_telnyx_ingress_receipts.sql", import.meta.url), "utf8"));
    const identity = await ensureIdentity(f.env, scope);
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,payer,provider_account_sid,policy_json,provider) VALUES(?,?,'byo','account','{}','telnyx')").bind("binding-1", identity.id).run();
    const claims = await Promise.all(Array.from({ length: 30 }, () => claimTelnyxIngress(f.db, "binding-1", "event-1", "original")));
    expect(claims.filter(claim => claim.acquired)).toHaveLength(1);
    expect(claims.filter(claim => !claim.acquired)).toHaveLength(29);
    await expect(claimTelnyxIngress(f.db, "binding-1", "event-1", "changed")).rejects.toThrow("telnyx_ingress_event_conflict");
    await finishTelnyxIngress(f.db, "binding-1", "event-1", "indeterminate");
    await expect(claimTelnyxIngress(f.db, "binding-1", "event-1", "original")).resolves.toEqual({ state: "indeterminate", acquired: false });
    await expect(finishTelnyxIngress(f.db, "binding-1", "event-1", "completed")).rejects.toThrow("telnyx_ingress_claim_not_active");
  });
});
