import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeEgressRedirect, authorizeEgressUrl, normalizeAllowedHosts, readSpaceEgressPolicy } from "../../packages/security/src/egress-policy.js";
import { findDestructiveMutation } from "../../packages/security/src/write-guard.js";
import { signActionReceipt, verifyActionReceiptChain, type ActionReceiptDraft } from "../../packages/tracing/src/index.js";
import credentialWorker, { generateCredentialToken, type CredentialsEnv } from "../../workers/credentials/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";

const platformSecret = "step06-test-platform-secret";
const genesis = "0".repeat(64);
afterEach(() => vi.unstubAllGlobals());

function fakeD1(configJson: string | null): D1Database {
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first<T>() { return configJson === null ? null : { config_json: configJson } as T; },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function receiptDraft(overrides: Partial<ActionReceiptDraft> = {}): ActionReceiptDraft {
  return {
    tenant_id: "tenant-1", space_id: "space-1", action_id: "action-1", idempotency_key: "idem-1",
    actor_id: "user-1", run_id: "run-1", task_id: null, worker_id: "agent-1", trace_id: "1".repeat(32),
    span_id: "2".repeat(16), action: "outbound.fetch", input_hash: "3".repeat(64), output_hash: "4".repeat(64),
    grant_id: null, cost_micros: 0, outcome: "succeeded", decision_summary: "HTTP 200",
    created_at: "2026-10-11T00:00:00.000Z", key_version: "test-v1", ...overrides,
  };
}

describe("Step 06 egress policy, mutation firewall, and action receipts", () => {
  it("normalizes exact owner grants and fails closed on missing or malformed policy", async () => {
    expect(normalizeAllowedHosts([" API.Example.COM. ", "*.example.com", "api.example.com:443", "localhost"])).toEqual(["api.example.com", "localhost"]);
    await expect(readSpaceEgressPolicy(fakeD1(null), "missing")).resolves.toEqual({ allowedHosts: [] });
    await expect(readSpaceEgressPolicy(fakeD1("{"), "bad")).resolves.toEqual({ allowedHosts: [] });
  });

  it("denies ungranted hosts, credentials in URLs, nonstandard ports, and mixed public/private DNS", async () => {
    const policy = { allowedHosts: ["api.example.com"] };
    await expect(authorizeEgressUrl("https://other.example.com/", policy, vi.fn())).rejects.toMatchObject({ code: "host_not_granted" });
    await expect(authorizeEgressUrl("https://user:pass@api.example.com/", policy, vi.fn())).rejects.toMatchObject({ code: "invalid_url" });
    await expect(authorizeEgressUrl("https://api.example.com:8443/", policy, vi.fn())).rejects.toMatchObject({ code: "port_denied" });
    const dns = vi.fn(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ data: "8.8.8.8" }, { data: "127.0.0.1" }] }), { headers: { "content-type": "application/dns-json" } }));
    await expect(authorizeEgressUrl("https://api.example.com/", policy, dns as typeof fetch)).rejects.toMatchObject({ code: "network_denied" });
    expect(dns).toHaveBeenCalledTimes(2);
  });

  it("revalidates each redirect and rejects cross-origin credential forwarding", async () => {
    const policy = { allowedHosts: ["api.example.com", "other.example.com"] };
    const publicDns = vi.fn(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ data: "8.8.8.8" }] }), { headers: { "content-type": "application/dns-json" } }));
    await expect(authorizeEgressRedirect("https://api.example.com/start", "/next", policy, publicDns as typeof fetch))
      .resolves.toMatchObject({ hostname: "api.example.com", pathname: "/next" });
    await expect(authorizeEgressRedirect("https://api.example.com/start", "https://other.example.com/next", policy, publicDns as typeof fetch))
      .rejects.toMatchObject({ code: "host_not_granted" });
    await expect(authorizeEgressRedirect("https://api.example.com/start", "http://127.0.0.1/latest/meta-data", policy, publicDns as typeof fetch))
      .rejects.toMatchObject({ code: "scheme_denied" });
  });

  it("blocks SQL comment, CTE, and multi-statement bypasses of destructive-write rules", () => {
    expect(findDestructiveMutation("DELETE /* bypass */ FROM users; DROP TABLE users")).toMatchObject({ action: "sql.multiple_statements" });
    expect(findDestructiveMutation("WITH chosen AS (SELECT id FROM users) DELETE FROM users /* no predicate */")).toMatchObject({ action: "sql.unbounded_write" });
    expect(findDestructiveMutation("UPDATE users SET active = 0 -- WHERE id = 1\n")).toMatchObject({ action: "sql.unbounded_write" });
    expect(findDestructiveMutation("SELECT 'DROP TABLE users; UPDATE x SET y=1' AS harmless")).toBeNull();
    expect(findDestructiveMutation("DROP /* comment */ TABLE users")).toMatchObject({ action: "sql.drop" });
  });

  it("detects tampering, forged hashes, and broken links in a persisted receipt chain", async () => {
    const key = "receipt-chain-secret";
    const firstDraft = receiptDraft();
    const firstHash = await signActionReceipt(firstDraft, genesis, key);
    const first = { ...firstDraft, prev_hash: genesis, receipt_hash: firstHash };
    // Simulate a worker restart by verifying data read back from durable storage.
    await expect(verifyActionReceiptChain([first], { "test-v1": key })).resolves.toEqual({ valid: true, entries: 1 });
    await expect(verifyActionReceiptChain([{ ...first, output_hash: "5".repeat(64) }], { "test-v1": key })).resolves.toMatchObject({ valid: false, invalid_action_id: "action-1" });
    await expect(verifyActionReceiptChain([{ ...first, prev_hash: "6".repeat(64) }], { "test-v1": key })).resolves.toMatchObject({ valid: false });
    await expect(verifyActionReceiptChain([first], { "test-v1": "wrong-key" })).resolves.toMatchObject({ valid: false });
  });

  it("persists pending/final receipts, rejects duplicate mutation attempts, and survives DO reconstruction", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const storage = {
      sql: {
        exec(query: string, ...args: unknown[]) {
          const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
          if (normalized.includes("select receipt_hash from action_receipts order by rowid desc")) {
            const last = rows.at(-1);
            return { toArray: () => last ? [{ receipt_hash: last.receipt_hash }] : [] };
          }
          if (normalized.includes("select * from action_receipts where idempotency_key")) {
            const found = rows.find((row) => row.idempotency_key === args[0]);
            return { toArray: () => found ? [found] : [] };
          }
          if (normalized.includes("select * from action_receipts where action_id")) {
            const found = [...rows].reverse().find((row) => row.action_id === args[0] && row.outcome !== "pending");
            return { toArray: () => found ? [found] : [] };
          }
          if (normalized.includes("select * from action_receipts order by rowid asc")) return { toArray: () => [...rows] };
          if (normalized.includes("insert into action_receipts")) {
            const fields = ["action_id", "idempotency_key", "tenant_id", "space_id", "actor_id", "run_id", "task_id", "worker_id", "trace_id", "span_id", "action", "input_hash", "output_hash", "grant_id", "cost_micros", "outcome", "decision_summary", "created_at", "prev_hash", "key_version", "receipt_hash"];
            rows.push(Object.fromEntries(fields.map((field, index) => [field, args[index]])));
            return { rowsWritten: 1, toArray: () => [] };
          }
          if (normalized.includes("select version from _migrations")) return { toArray: () => [{ version: args[0] }] };
          return { rowsWritten: 1, toArray: () => [] };
        },
      },
      transactionSync(fn: () => unknown) { return fn(); },
      deleteAlarm: async () => undefined,
      setAlarm: async () => undefined,
    };
    const env = { PLATFORM_SECRET: "receipt-chain-secret" };
    const makeSpace = () => new SpaceDO({ storage } as never, env as never);
    const toRequest = (draft: ActionReceiptDraft) => new Request("https://space/internal/action-receipts?space_id=space-1&tenant_id=tenant-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft),
    });
    const pending = receiptDraft({ outcome: "pending", idempotency_key: "idem-pending" });
    const first = await makeSpace().fetch(toRequest(pending));
    expect(first.status).toBe(201);
    expect((await first.json() as { receipt: { receipt_hash: string } }).receipt.receipt_hash).toMatch(/^[a-f0-9]{64}$/);
    const duplicateBeforeResolution = await makeSpace().fetch(toRequest(pending));
    expect((await duplicateBeforeResolution.json() as { replayed: boolean; receipt: { outcome: string } })).toMatchObject({ replayed: true, receipt: { outcome: "pending" } });
    expect(rows).toHaveLength(1);

    const final = receiptDraft({ outcome: "succeeded", idempotency_key: "idem-final", output_hash: "7".repeat(64) });
    expect((await makeSpace().fetch(toRequest(final))).status).toBe(201);
    const replayAfterResolution = await makeSpace().fetch(toRequest(pending));
    expect((await replayAfterResolution.json() as { replayed: boolean; receipt: { outcome: string } })).toMatchObject({ replayed: true, receipt: { outcome: "succeeded" } });
    expect(rows).toHaveLength(2);

    const restarted = makeSpace();
    expect(await (await restarted.fetch(new Request("https://space/internal/action-receipts/verify"))).json()).toEqual({ valid: true, entries: 2 });
    const alteredRetry = receiptDraft({ outcome: "pending", idempotency_key: "idem-pending", input_hash: "8".repeat(64) });
    expect((await restarted.fetch(toRequest(alteredRetry))).status).toBe(409);
  });

  it("rejects an invalid credential token before any upstream network request", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: platformSecret, CREDENTIAL_ENCRYPTION_KEY: `v1:${"31".repeat(32)}`,
      PLATFORM_DB: fakeD1(JSON.stringify({ security: { egress: { allowedHosts: ["api.example.com"] } } })),
      ANALYTICS: {} as AnalyticsEngineDataset,
    } as CredentialsEnv;
    const response = await credentialWorker.fetch!(new Request("https://credentials.test/v1/internal/spaces/space-1/outbound", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-credential-token": "t=1,aid=attacker,v3=00" },
      body: JSON.stringify({ url: "https://api.example.com/write", credentialName: "API_KEY", method: "POST", idempotencyKey: "idem-1" }),
    }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("issues a signed run-bound token only when trace and actor context are valid", async () => {
    const token = await generateCredentialToken(platformSecret, "space-1", "agent-1", undefined, "tenant-1", {
      actorId: "user-1", runId: "run-1", traceId: "1".repeat(32), spanId: "2".repeat(16),
    });
    expect(token).toContain(",v4=");
    await expect(generateCredentialToken(platformSecret, "space-1", "agent-1", undefined, "tenant-1", {
      actorId: "user-1", runId: "run-1", traceId: "bad", spanId: "2".repeat(16),
    })).rejects.toThrow("invalid_credential_trace_context");
  });
});
