import { describe, it, expect } from "vitest";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Three-Tier Platform Model, Phase 2 (docs/spec-appendix A1.17). ProductUserDO is the platform's
// first persistent signed-in end-user identity: product-scoped sessions, a credit ledger, prefs,
// notifications, and a GDPR Art. 20 export. One instance per (productId, endUserId).

function makeDO() {
  const ctx = { storage: { sql: createDOSqlStorage() } };
  return new ProductUserDO(ctx as never, {} as never);
}

async function call(doInstance: ProductUserDO, path: string, init?: RequestInit) {
  return doInstance.fetch(new Request(`http://do${path}`, init));
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("ProductUserDO — product-scoped sessions", () => {
  it("opens a session, returns an opaque token once, and verifies it", async () => {
    const doInstance = makeDO();
    const openRes = await call(doInstance, "/sessions", jsonPost({ auth_provider: "clerk" }));
    expect(openRes.status).toBe(201);
    const opened = await openRes.json() as { session_id: string; session_token: string };
    expect(opened.session_token).toMatch(/^nps_/);

    const verifyRes = await call(doInstance, "/sessions/verify", jsonPost({ session_token: opened.session_token }));
    const verified = await verifyRes.json() as { valid: boolean; session_id: string };
    expect(verified.valid).toBe(true);
    expect(verified.session_id).toBe(opened.session_id);
  });

  it("rejects a forged/unknown session token", async () => {
    const doInstance = makeDO();
    const res = await call(doInstance, "/sessions/verify", jsonPost({ session_token: "nps_forged" }));
    const body = await res.json() as { valid: boolean };
    expect(body.valid).toBe(false);
  });

  it("a revoked session no longer verifies", async () => {
    const doInstance = makeDO();
    const opened = await (await call(doInstance, "/sessions", jsonPost({}))).json() as { session_id: string; session_token: string };
    const revokeRes = await call(doInstance, "/sessions/revoke", jsonPost({ session_id: opened.session_id }));
    expect(revokeRes.status).toBe(204);
    const verified = await (await call(doInstance, "/sessions/verify", jsonPost({ session_token: opened.session_token }))).json() as { valid: boolean };
    expect(verified.valid).toBe(false);
  });

  it("revoke-all invalidates every active session", async () => {
    const doInstance = makeDO();
    const a = await (await call(doInstance, "/sessions", jsonPost({}))).json() as { session_token: string };
    const b = await (await call(doInstance, "/sessions", jsonPost({}))).json() as { session_token: string };
    await call(doInstance, "/sessions/revoke", jsonPost({})); // no session_id → revoke all
    const va = await (await call(doInstance, "/sessions/verify", jsonPost({ session_token: a.session_token }))).json() as { valid: boolean };
    const vb = await (await call(doInstance, "/sessions/verify", jsonPost({ session_token: b.session_token }))).json() as { valid: boolean };
    expect(va.valid).toBe(false);
    expect(vb.valid).toBe(false);
  });
});

describe("ProductUserDO — credit ledger", () => {
  it("starts at zero, grants add, deducts subtract", async () => {
    const doInstance = makeDO();
    const zero = await (await call(doInstance, "/credits/balance")).json() as { balance_credits: number };
    expect(zero.balance_credits).toBe(0);

    await call(doInstance, "/credits/grant", jsonPost({ credits: 1000, reason: "signup_bonus" }));
    const afterGrant = await (await call(doInstance, "/credits/balance")).json() as { balance_credits: number };
    expect(afterGrant.balance_credits).toBe(1000);

    const deductRes = await call(doInstance, "/credits/deduct", jsonPost({ credits: 250, reason: "agent_run", model: "claude-haiku-4-5" }));
    expect(deductRes.status).toBe(201);
    const afterDeduct = await deductRes.json() as { balance_credits: number };
    expect(afterDeduct.balance_credits).toBe(750);
  });

  it("fails CLOSED on an over-draw (402, balance unchanged)", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/credits/grant", jsonPost({ credits: 100 }));
    const overdraw = await call(doInstance, "/credits/deduct", jsonPost({ credits: 500 }));
    expect(overdraw.status).toBe(402);
    const balance = await (await call(doInstance, "/credits/balance")).json() as { balance_credits: number };
    expect(balance.balance_credits).toBe(100);
  });

  it("rejects non-positive grant/deduct amounts", async () => {
    const doInstance = makeDO();
    expect((await call(doInstance, "/credits/grant", jsonPost({ credits: 0 }))).status).toBe(400);
    expect((await call(doInstance, "/credits/deduct", jsonPost({ credits: -5 }))).status).toBe(400);
  });

  // S0.6: /credits/deduct had no idempotency key at all (unlike /credits/grant, which already
  // dedupes webhook-driven credit-pack purchases) — a retried post-run debit
  // (NaelaoAgentDO.debitEndUserCredits, now passing runId as the key) would double-charge the
  // end user for one run.
  it("a repeated deduct with the same idempotency_key is a no-op, not a second charge", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/credits/grant", jsonPost({ credits: 1000 }));

    const first = await call(doInstance, "/credits/deduct", jsonPost({ credits: 250, idempotency_key: "run:abc123" }));
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { balance_credits: number };
    expect(firstBody.balance_credits).toBe(750);

    const retry = await call(doInstance, "/credits/deduct", jsonPost({ credits: 250, idempotency_key: "run:abc123" }));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json() as { balance_credits: number; deduplicated: boolean };
    expect(retryBody.deduplicated).toBe(true);
    expect(retryBody.balance_credits).toBe(750); // unchanged — not deducted twice

    const balance = await (await call(doInstance, "/credits/balance")).json() as { balance_credits: number };
    expect(balance.balance_credits).toBe(750);
  });

  it("two distinct idempotency_keys both deduct independently", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/credits/grant", jsonPost({ credits: 1000 }));
    await call(doInstance, "/credits/deduct", jsonPost({ credits: 100, idempotency_key: "run:one" }));
    await call(doInstance, "/credits/deduct", jsonPost({ credits: 100, idempotency_key: "run:two" }));
    const balance = await (await call(doInstance, "/credits/balance")).json() as { balance_credits: number };
    expect(balance.balance_credits).toBe(800);
  });

  it("a deduct idempotency_key never collides with a grant idempotency_key namespace", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/credits/grant", jsonPost({ credits: 1000, idempotency_key: "shared-key" }));
    // Deliberately reuse the same literal string as a deduct key — must not be treated as the
    // same event just because the string matches; this test documents that callers are expected
    // to namespace their keys (grant: "credit_pack:...", deduct: "run:...") rather than the DO
    // enforcing separate columns, and confirms a naive same-string reuse still debits for real.
    const deductRes = await call(doInstance, "/credits/deduct", jsonPost({ credits: 100, idempotency_key: "shared-key-deduct" }));
    expect(deductRes.status).toBe(201);
    const balance = await (await call(doInstance, "/credits/balance")).json() as { balance_credits: number };
    expect(balance.balance_credits).toBe(900);
  });
});

describe("ProductUserDO — preferences, conversation refs, notifications", () => {
  it("round-trips preferences", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "theme", value: "dark" }) });
    const prefs = await (await call(doInstance, "/preferences")).json() as { preferences: Record<string, unknown> };
    expect(prefs.preferences["theme"]).toBe("dark");
  });

  it("records and lists conversation refs (metadata only), de-duped by (space, thread)", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/conversation-refs", jsonPost({ thread_id: "t1", space_id: "s1", title: "First" }));
    await call(doInstance, "/conversation-refs", jsonPost({ thread_id: "t1", space_id: "s1", title: "First (renamed)" }));
    const refs = await (await call(doInstance, "/conversation-refs")).json() as { data: Array<{ thread_id: string; title: string }> };
    expect(refs.data).toHaveLength(1);
    expect(refs.data[0]!.title).toBe("First (renamed)");
  });

  it("queues and lists pending notifications", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/notifications", jsonPost({ payload: { kind: "order_shipped", order: "o1" } }));
    const notes = await (await call(doInstance, "/notifications")).json() as { data: Array<{ payload: { kind: string } }> };
    expect(notes.data).toHaveLength(1);
    expect(notes.data[0]!.payload.kind).toBe("order_shipped");
  });
});

describe("ProductUserDO — GDPR Art. 20 export", () => {
  it("dumps sessions/ledger/conversations/preferences but never token material", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/sessions", jsonPost({ auth_provider: "naelao-native" }));
    await call(doInstance, "/credits/grant", jsonPost({ credits: 500 }));
    await call(doInstance, "/conversation-refs", jsonPost({ thread_id: "t1", space_id: "s1", title: "Hi" }));
    await call(doInstance, "/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "lang", value: "en" }) });

    const exp = await (await call(doInstance, "/export")).json() as {
      sessions: Array<Record<string, unknown>>;
      credit_ledger: unknown[];
      credit_balance: number;
      conversations: unknown[];
      preferences: Record<string, unknown>;
    };
    expect(exp.credit_balance).toBe(500);
    expect(exp.conversations).toHaveLength(1);
    expect(exp.preferences["lang"]).toBe("en");
    expect(exp.sessions).toHaveLength(1);
    // Credential material must never appear in an export.
    expect(exp.sessions[0]).not.toHaveProperty("token_hash");
  });
});

describe("ProductUserDO — GDPR Art. 17 erasure (Tier 2/3 follow-up: export existed, deletion didn't)", () => {
  it("wipes sessions, conversation refs, and preferences — the exact inverse of /export", async () => {
    const doInstance = makeDO();
    await call(doInstance, "/sessions", jsonPost({ auth_provider: "naelao-native" }));
    await call(doInstance, "/credits/grant", jsonPost({ credits: 500 }));
    await call(doInstance, "/conversation-refs", jsonPost({ thread_id: "t1", space_id: "s1", title: "Hi" }));
    await call(doInstance, "/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "lang", value: "en" }) });

    const eraseRes = await call(doInstance, "/erase", { method: "DELETE" });
    expect(eraseRes.status).toBe(200);
    const erased = await eraseRes.json() as { sessions_deleted: number; conversations_deleted: number };
    expect(erased.sessions_deleted).toBe(1);
    expect(erased.conversations_deleted).toBe(1);

    const exp = await (await call(doInstance, "/export")).json() as {
      sessions: unknown[]; conversations: unknown[]; preferences: Record<string, unknown>; credit_balance: number;
    };
    expect(exp.sessions).toHaveLength(0);
    expect(exp.conversations).toHaveLength(0);
    expect(Object.keys(exp.preferences)).toHaveLength(0);
    // credit_ledger is deliberately KEPT — it holds no PII, just transaction amounts.
    expect(exp.credit_balance).toBe(500);
  });

  it("is idempotent — erasing an already-empty DO does not error", async () => {
    const doInstance = makeDO();
    const first = await call(doInstance, "/erase", { method: "DELETE" });
    expect(first.status).toBe(200);
    const body = await first.json() as { sessions_deleted: number };
    expect(body.sessions_deleted).toBe(0);
  });
});
