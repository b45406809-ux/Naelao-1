import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { ensureIdentity } from "./core.js";
import { registerCommunicationRoutes } from "./routes.js";
import {
  cancelHiggsfieldRequest,
  connectHiggsfieldAccount,
  createHiggsfieldEstimate,
  deleteHiggsfieldRequest,
  refreshHiggsfieldRequest,
  revokeHiggsfieldAccount,
  sweepHiggsfieldRequests,
  submitHiggsfieldGeneration,
} from "./higgsfield.js";

const MODEL = "kling-video/v4.0/text-to-video";
const REQUEST_ID = "4dbbc66a-437f-493a-8b0a-083fb3e9a2bd";

function enabledFixture() {
  const f = fixture();
  (f.env as unknown as { HIGGSFIELD_BYO_ENABLED: string }).HIGGSFIELD_BYO_ENABLED = "true";
  f.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',regions_json='["global"]',
    valid_until='2026-12-31T00:00:00.000Z',verified_by='test-operator',verified_at='2026-11-11T00:00:00.000Z'
    WHERE provider='higgsfield' AND service_id='kling-video-v4-text-to-video' AND version=1`).run();
  return f;
}

function providerFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

async function connect(f: ReturnType<typeof fixture>) {
  const identity = await ensureIdentity(f.env, scope);
  const account = await connectHiggsfieldAccount(f.env, scope, identity, { apiKey: "key-id:secret-value-0123456789" });
  return { identity, account };
}

async function createQueuedRequest(f: ReturnType<typeof fixture>) {
  const { identity, account } = await connect(f);
  let estimateCalls = 0;
  const calls = providerFetch((url, init) => {
    if (url.pathname === `/estimate/${MODEL}`) {
      estimateCalls++;
      return Response.json({ usd: "0.125" });
    }
    if (url.pathname === `/${MODEL}`) return Response.json({ request_id: REQUEST_ID, status: "queued",
      status_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/status`,
      cancel_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/cancel` });
    if (url.pathname.endsWith("/cancel") && init.method === "POST") return new Response(null, { status: 202 });
    if (url.pathname.endsWith("/status")) return Response.json({ status: "completed", request_id: REQUEST_ID,
      expires_at: "2026-11-18T00:00:00.000Z", video: { url: "https://cdn.higgsfield.ai/output/video.mp4" } });
    if (url.pathname === `/requests/${REQUEST_ID}` && init.method === "DELETE") return Response.json({ request_id: REQUEST_ID, status: "deleted" });
    throw new Error(`unexpected mocked provider request ${init.method} ${url.pathname}`);
  });
  const estimate = await createHiggsfieldEstimate(f.env, scope, identity, account.id, { prompt: "A red tram at dusk" });
  return { identity, account, estimate, calls, getEstimateCalls: () => estimateCalls };
}

afterEach(() => vi.unstubAllGlobals());

describe("customer-owned Higgsfield Kling 4.0 adapter", () => {
  it("fails closed while disabled", async () => {
    const f = fixture();
    const identity = await ensureIdentity(f.env, scope);
    await expect(connectHiggsfieldAccount(f.env, scope, identity, { apiKey: "key-id:secret-value-0123456789" }))
      .rejects.toThrow("higgsfield_integration_disabled");
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM assistant_higgsfield_accounts").get()).toEqual({ count: 0 });
  });

  it("stores connected credentials encrypted and owner scoped", async () => {
    const f = enabledFixture();
    const identity = await ensureIdentity(f.env, scope);
    const saved = await connectHiggsfieldAccount(f.env, scope, identity, { apiKey: "key-id:secret-value-0123456789" });
    expect(saved).toMatchObject({ connectionMode: "user_connected", credentialSaved: true });
    const row = f.db.db.prepare("SELECT credential_ciphertext,credential_iv,credential_fingerprint FROM assistant_higgsfield_accounts WHERE id=?").get(saved.id) as Record<string, string>;
    expect(row.credential_ciphertext).not.toContain("secret-value");
    expect(row.credential_iv).not.toBe("");
    expect(row.credential_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(createHiggsfieldEstimate(f.env, { ...scope, userId: "other" }, identity, saved.id, { prompt: "hi" })).rejects.toThrow("higgsfield_account_unavailable");
    (f.env as unknown as { HIGGSFIELD_BYO_ENABLED: string }).HIGGSFIELD_BYO_ENABLED = "false";
    expect(await revokeHiggsfieldAccount(f.env, scope, identity, saved.id)).toMatchObject({ revoked: true });
    expect(f.db.db.prepare("SELECT status,credential_ciphertext,credential_iv FROM assistant_higgsfield_accounts WHERE id=?").get(saved.id))
      .toMatchObject({ status: "revoked", credential_ciphertext: "", credential_iv: "" });
  });

  it("estimates with the exact model payload, requires renewed price confirmation, submits once, and scopes status and deletion", async () => {
    const f = enabledFixture();
    const { identity, account } = await connect(f);
    let estimateCount = 0;
    const calls = providerFetch((url, init) => {
      expect(url.origin).toBe("https://api.higgsfield.ai");
      expect(new Headers(init.headers).get("authorization")).toBe("Key key-id:secret-value-0123456789");
      if (url.pathname === `/estimate/${MODEL}`) {
        estimateCount++;
        return Response.json({ usd: estimateCount === 1 ? "0.125" : "0.150" });
      }
      if (url.pathname === `/${MODEL}`) {
        expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.parse(String(init.body))).toEqual({ prompt: "A red tram at dusk", duration: 10, resolution: "1080p", aspect_ratio: "16:9" });
        return Response.json({ request_id: REQUEST_ID, status: "queued", status_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/status`,
          cancel_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/cancel` });
      }
      if (url.pathname.endsWith("/status")) return Response.json({ status: "completed", request_id: REQUEST_ID,
        expires_at: "2026-11-18T00:00:00.000Z", video: { url: "https://cdn.higgsfield.ai/output/video.mp4" } });
      if (url.pathname === `/requests/${REQUEST_ID}` && init.method === "DELETE") return Response.json({ request_id: REQUEST_ID, status: "deleted" });
      throw new Error(`unexpected mocked provider request ${init.method} ${url.pathname}`);
    });

    const first = await createHiggsfieldEstimate(f.env, scope, identity, account.id, { prompt: "A red tram at dusk" });
    expect(first.estimate.amountUsd).toBe("0.125");
    expect(calls[0]!.url.pathname).toBe(`/estimate/${MODEL}`);
    const initialSubmit = await submitHiggsfieldGeneration(f.env, scope, identity, {
      accountId: account.id, estimateId: first.estimate.id, confirmedUsd: "0.125", idempotencyKey: "unique-intent-key-000001",
      request: { prompt: "A red tram at dusk" },
    });
    expect(initialSubmit).toMatchObject({ submitted: false, requiresConfirmation: true, estimate: { amountUsd: "0.150" } });

    const confirmed = await submitHiggsfieldGeneration(f.env, scope, identity, {
      accountId: account.id, estimateId: initialSubmit.estimate.id, confirmedUsd: "0.150", idempotencyKey: "unique-intent-key-000001",
      request: { prompt: "A red tram at dusk" },
    });
    expect(confirmed.submitted).toBe(true);
    expect(confirmed.request).toMatchObject({ status: "queued", estimatedUsd: "0.150", providerRequestId: REQUEST_ID });
    const duplicate = await submitHiggsfieldGeneration(f.env, scope, identity, {
      accountId: account.id, estimateId: initialSubmit.estimate.id, confirmedUsd: "0.150", idempotencyKey: "unique-intent-key-000001",
      request: { prompt: "A red tram at dusk" },
    });
    expect(duplicate.submitted).toBe(true);
    expect(calls.filter((call) => call.url.pathname === `/${MODEL}`)).toHaveLength(1);
    expect(calls.filter((call) => call.url.pathname.includes("/estimate/")).length).toBe(4);

    await expect(refreshHiggsfieldRequest(f.env, { ...scope, userId: "other" }, identity, account.id, confirmed.request.id))
      .rejects.toThrow("higgsfield_account_unavailable");
    const completed = await refreshHiggsfieldRequest(f.env, scope, identity, account.id, confirmed.request.id);
    expect(completed).toMatchObject({ status: "completed", expiresAt: "2026-11-18T00:00:00.000Z", videoUrl: "https://cdn.higgsfield.ai/output/video.mp4" });
    const deleted = await deleteHiggsfieldRequest(f.env, scope, identity, account.id, confirmed.request.id);
    expect(deleted).toMatchObject({ deleted: true, request: { status: "deleted" } });
    expect(deleted.request).not.toHaveProperty("videoUrl");
  });

  it("uses the documented empty 202 cancel response only for queued provider work", async () => {
    const f = enabledFixture();
    const queued = await createQueuedRequest(f);
    const submitted = await submitHiggsfieldGeneration(f.env, scope, queued.identity, { accountId: queued.account.id,
      estimateId: queued.estimate.estimate.id, confirmedUsd: queued.estimate.estimate.amountUsd,
      idempotencyKey: "cancel-intent-key-000001", request: { prompt: "A red tram at dusk" } });
    const cancelled = await cancelHiggsfieldRequest(f.env, scope, queued.identity, queued.account.id, submitted.request.id);
    expect(cancelled).toMatchObject({ cancelled: true, request: { status: "canceled" } });
    expect(queued.calls.some((call) => call.url.pathname.endsWith("/cancel") && call.init.method === "POST")).toBe(true);
  });

  it("polls accepted jobs through the five minute reconciler after the admission flag is switched off", async () => {
    const f = enabledFixture();
    const queued = await createQueuedRequest(f);
    const submitted = await submitHiggsfieldGeneration(f.env, scope, queued.identity, { accountId: queued.account.id,
      estimateId: queued.estimate.estimate.id, confirmedUsd: queued.estimate.estimate.amountUsd,
      idempotencyKey: "sweep-intent-key-000001", request: { prompt: "A red tram at dusk" } });
    (f.env as unknown as { HIGGSFIELD_BYO_ENABLED: string }).HIGGSFIELD_BYO_ENABLED = "false";
    const swept = await sweepHiggsfieldRequests(f.env, new Date(Date.now() + 5 * 60_000), 10);
    expect(swept).toEqual({ checked: 1, reconciled: 1, deferred: 0, failed: 0 });
    const request = await refreshHiggsfieldRequest(f.env, scope, queued.identity, queued.account.id, submitted.request.id);
    expect(request.status).toBe("completed");
  });

  it("records an ambiguous generation response as uncertain and does not repeat the paid effect", async () => {
    const f = enabledFixture();
    const { identity, account } = await connect(f);
    let submissions = 0;
    const calls = providerFetch((url, init) => {
      if (url.pathname === `/estimate/${MODEL}`) return Response.json({ usd: "0.125" });
      submissions++;
      expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^[a-f0-9]{64}$/);
      throw new TypeError("network disconnected after dispatch");
    });
    const estimate = await createHiggsfieldEstimate(f.env, scope, identity, account.id, { prompt: "A red tram at dusk" });
    const input = { accountId: account.id, estimateId: estimate.estimate.id, confirmedUsd: "0.125",
      idempotencyKey: "ambiguous-intent-key-0001", request: { prompt: "A red tram at dusk" } };
    const uncertain = await submitHiggsfieldGeneration(f.env, scope, identity, input);
    expect(uncertain).toMatchObject({ submitted: false, request: { status: "unknown", errorCode: "provider_outcome_unknown" } });
    const renewed = await createHiggsfieldEstimate(f.env, scope, identity, account.id, { prompt: "A red tram at dusk" });
    const retry = await submitHiggsfieldGeneration(f.env, scope, identity, { ...input, estimateId: renewed.estimate.id });
    expect(retry).toMatchObject({ submitted: false, request: { status: "unknown" } });
    expect(submissions).toBe(2);
    expect(calls.filter((call) => call.url.pathname === `/${MODEL}`)).toHaveLength(2);
    expect(f.db.db.prepare("SELECT status FROM managed_service_operations").get()).toEqual({ status: "uncertain" });
  });

  it("wires owner-authenticated routes through connect, estimate, and explicit generation", async () => {
    const f = enabledFixture();
    const app = new Hono<{ Bindings: AgentsEnv }>();
    registerCommunicationRoutes(app);
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
      "x-naelao-user-id": scope.userId, "x-naelao-role": scope.role,
      "x-naelao-internal-token": await mintInternalToken("secret", scope.tenantId) };
    providerFetch((url) => url.pathname.startsWith("/estimate/") ? Response.json({ usd: "0.125" })
      : Response.json({ request_id: REQUEST_ID, status: "queued", status_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/status`,
        cancel_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/cancel` }));
    const connectResponse = await app.request("/spaces/space/assistant-communications", { method: "POST", headers,
      body: JSON.stringify({ action: "higgsfield-connect", api_key: "key-id:secret-value-0123456789" }) }, f.env);
    expect(connectResponse.status).toBe(201);
    const { account } = await connectResponse.json() as { account: { id: string } };
    const estimateResponse = await app.request("/spaces/space/assistant-communications", { method: "POST", headers,
      body: JSON.stringify({ action: "higgsfield-estimate", account_id: account.id, request: { prompt: "A tram" } }) }, f.env);
    expect(estimateResponse.status).toBe(200);
    const estimate = await estimateResponse.json() as { estimate: { id: string; amountUsd: string } };
    const submitResponse = await app.request("/spaces/space/assistant-communications", { method: "POST", headers,
      body: JSON.stringify({ action: "higgsfield-submit", account_id: account.id, estimate_id: estimate.estimate.id,
        confirmed_usd: estimate.estimate.amountUsd, idempotency_key: "route-intent-key-000001", request: { prompt: "A tram" } }) }, f.env);
    expect(submitResponse.status).toBe(200);
    const submitted = await submitResponse.json() as { submitted: boolean; request: { id: string; status: string } };
    expect(submitted).toMatchObject({ submitted: true, request: { status: "queued" } });
    const history = await app.request("/spaces/space/assistant-communications", { method: "POST", headers,
      body: JSON.stringify({ action: "higgsfield-requests", account_id: account.id }) }, f.env);
    expect(await history.json()).toMatchObject({ requests: [{ id: submitted.request.id, status: "queued", estimatedUsd: "0.125" }] });

    const otherHeaders = { ...headers, "x-naelao-user-id": "other", "x-naelao-internal-token": await mintInternalToken("secret", scope.tenantId) };
    const denied = await app.request("/spaces/space/assistant-communications", { method: "POST", headers: otherHeaders,
      body: JSON.stringify({ action: "higgsfield-estimate", account_id: account.id, request: { prompt: "A tram" } }) }, f.env);
    expect(denied.status).toBe(404);
  });
});
