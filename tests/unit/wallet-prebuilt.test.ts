import { describe, it, expect } from "vitest";
import { wallet } from "../../workers/agents/src/script-engine/prebuilt/wallet.js";
import { verifyInternalToken } from "@naelao/http";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Launchpad Wallet (user-directed feature): the wallet prebuilt is the agent-facing surface over
// SpaceDO's wallet_ledger (balance/history) and the billing worker's checkout flow (fund) — plus
// a bypass-detection read (check_bypass) that reports, but never enforces, when a business has
// connected its own third-party payment credential instead of using the Naelao wallet.

const PLATFORM_SECRET = "test-platform-secret";
const noopRun = async () => ({});

function makeFetchCapture(response: unknown, status = 200) {
  const capture: { headers?: Record<string, string>; body?: unknown; url?: string } = {};
  const fetcher = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      capture.headers = headers;
      capture.url = req.url;
      capture.body = await req.clone().json().catch(() => null);
      return Response.json(response as object, { status });
    },
  };
  return { fetcher, capture };
}

describe("wallet prebuilt", () => {
  it("wallet.balance reads through the spaces worker with a verified internal token, scoped to env.projectId", async () => {
    const { fetcher, capture } = makeFetchCapture({ project_id: "proj-1", balance_cents: 1500, currency: "USD" });
    const env: ScriptEngineEnv = {
      scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", projectId: "proj-1",
      platformSecret: PLATFORM_SECRET, spacesWorker: fetcher as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;

    const result = await wallet.operations["wallet.balance"]!({}, { env, run: noopRun });
    expect(result).toEqual({ project_id: "proj-1", balance_cents: 1500, currency: "USD" });
    expect(capture.url).toBe("http://spaces-worker/spaces/space-1/projects/proj-1/wallet/balance");
    expect(await verifyInternalToken(capture.headers?.["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
  });

  it("wallet.balance throws when neither env.projectId nor an explicit project_id is given", async () => {
    const env = { scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    await expect(wallet.operations["wallet.balance"]!({}, { env, run: noopRun })).rejects.toThrow(/project-scoped/);
  });

  it("wallet.fund calls the billing worker's wallet-topups checkout with a verified internal token, never an arbitrary amount", async () => {
    const { fetcher, capture } = makeFetchCapture({ checkout_url: "https://checkout.example/topup", topup: { id: "topup-25", name: "$25", price_cents: 2500 } });
    const env: ScriptEngineEnv = {
      scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", projectId: "proj-1",
      platformSecret: PLATFORM_SECRET, billingWorker: fetcher as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;

    const result = await wallet.operations["wallet.fund"]!({ topup_id: "topup-25" }, { env, run: noopRun });
    expect(result).toEqual({ checkout_url: "https://checkout.example/topup", topup: { id: "topup-25", name: "$25", price_cents: 2500 } });
    expect(capture.body).toEqual({ business_space_id: "space-1", project_id: "proj-1", topup_id: "topup-25" });
    expect(await verifyInternalToken(capture.headers?.["x-naelao-internal-token"], "tenant-1", PLATFORM_SECRET)).toBe(true);
  });

  it("wallet.check_bypass detects a business's own registered payment credential", async () => {
    const { fetcher } = makeFetchCapture({
      credentials: [
        { id: "c1", name: "stripe_api_key", scope: "space" },
        { id: "c2", name: "unrelated_webhook_secret", scope: "user" },
      ],
    });
    const env: ScriptEngineEnv = {
      scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1",
      platformSecret: PLATFORM_SECRET, credentialsWorker: fetcher as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;

    const result = await wallet.operations["wallet.check_bypass"]!({}, { env, run: noopRun });
    expect(result).toEqual({ using_own_payment_method: true, matched_providers: ["stripe_api_key"], checked: true });
  });

  it("wallet.check_bypass reports no bypass when only unrelated credentials exist", async () => {
    const { fetcher } = makeFetchCapture({ credentials: [{ id: "c1", name: "unrelated_webhook_secret", scope: "user" }] });
    const env: ScriptEngineEnv = {
      scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1",
      platformSecret: PLATFORM_SECRET, credentialsWorker: fetcher as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;

    const result = await wallet.operations["wallet.check_bypass"]!({}, { env, run: noopRun });
    expect(result).toEqual({ using_own_payment_method: false, matched_providers: [], checked: true });
  });

  it("wallet.check_bypass degrades honestly (checked:false) when the credentials worker isn't bound", async () => {
    const env = { scriptsBucket: {} as never, spaceId: "space-1", tenantId: "tenant-1", platformSecret: PLATFORM_SECRET } as unknown as ScriptEngineEnv;
    const result = await wallet.operations["wallet.check_bypass"]!({}, { env, run: noopRun });
    expect(result).toEqual({ using_own_payment_method: false, matched_providers: [], checked: false });
  });
});
