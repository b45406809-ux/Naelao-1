import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { generateCredentialToken, type CredentialsEnv } from "./index.js";

function env(spaceActive = true, airGapped = true): CredentialsEnv {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    CREDENTIAL_ENCRYPTION_KEY: `v1:${"11".repeat(32)}`,
    ANALYTICS: {} as AnalyticsEngineDataset,
    PLATFORM_DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => sql.includes("JOIN orgs")
            ? spaceActive ? { id: "s" } : null
            : { config_json: JSON.stringify(airGapped ? { compliance: { airGappedOnly: true } } : {}) }),
        })),
      })),
    } as unknown as D1Database,
  };
}

describe("credential egress air-gap boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks before credential resolution, decryption, SSRF, or outbound fetch", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-credential-token": await generateCredentialToken("secret", "s", "agent", undefined, "tenant"),
      },
      body: JSON.stringify({ credentialName: "gemini", url: "https://example.com" }),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects malformed egress shapes, invalid headers, GET bodies, and oversized provider bodies before fetch", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const runtime = env(true, false);
    const token = await generateCredentialToken("secret", "s", "agent", undefined, "tenant");
    const send = (body: string) => worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-credential-token": token },
      body,
    }), runtime, {} as ExecutionContext);

    expect((await send("null")).status).toBe(400);
    expect((await send(JSON.stringify({ credentialName: "gemini", url: "https://example.com", headers: "not-an-object" }))).status).toBe(400);
    expect((await send(JSON.stringify({ credentialName: "gemini", url: "https://example.com", method: "GET", body: "not-allowed" }))).status).toBe(400);
    expect((await send(JSON.stringify({ credentialName: "gemini", url: "https://example.com", method: "POST", idempotencyKey: 123, body: "write" }))).status).toBe(400);
    expect((await send(JSON.stringify({ credentialName: "gemini", url: "https://example.com", body: "x".repeat(512 * 1024 + 1) }))).status).toBe(413);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("blocks raw model calls and generic access to model-provider keys before credential resolution", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const runtime = env(true, false);
    const response = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-credential-token": await generateCredentialToken("secret", "s", "agent", undefined, "tenant"),
      },
      body: JSON.stringify({
        credentialName: "llm_byok_openrouter",
        url: "https://openrouter.ai/api/v1/chat/completions",
        method: "POST",
        idempotencyKey: "raw-model-call",
        body: { model: "vendor/expensive-model", messages: [{ role: "user", content: "run" }] },
      }),
    }), runtime, {} as ExecutionContext);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "egress_model_api_requires_host" });
    expect(outbound).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.PLATFORM_DB.prepare)).not.toHaveBeenCalledWith(expect.stringMatching(/FROM\s+credentials\b/i));

    const credentialOnlyResponse = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-credential-token": await generateCredentialToken("secret", "s", "agent", undefined, "tenant"),
      },
      body: JSON.stringify({ credentialName: "llm_byok_openrouter", url: "https://api.example.test/v1/account", method: "GET" }),
    }), runtime, {} as ExecutionContext);
    expect(credentialOnlyResponse.status).toBe(403);
    expect(await credentialOnlyResponse.json()).toMatchObject({ error_code: "egress_model_api_requires_host" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects legacy tokens without a tenant claim before reading egress policy or credentials", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-credential-token": await generateCredentialToken("secret", "s", "agent"),
      },
      body: JSON.stringify({ credentialName: "gemini", url: "https://example.com" }),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: "Credential token tenant scope mismatch" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("does not let an internal caller substitute another user's personal credential scope", async () => {
    const runtime = env(true, false);
    const token = await generateCredentialToken("secret", "s", "agent", undefined, "tenant", {
      actorId: "actor-a", runId: "run-a", traceId: "a".repeat(32), spanId: "b".repeat(16),
    });
    const headers = {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant",
      "x-naelao-credential-token": token,
    };

    const plaintext = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/credentials/gemini/plaintext", {
      method: "POST", headers, body: JSON.stringify({ on_behalf_of_user_id: "actor-b" }),
    }), runtime, {} as ExecutionContext);
    const outbound = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
      method: "POST", headers, body: JSON.stringify({ credentialName: "gemini", url: "https://example.com", onBehalfOfUserId: "actor-b" }),
    }), runtime, {} as ExecutionContext);

    expect(plaintext.status).toBe(403);
    expect(outbound.status).toBe(403);
    expect(await plaintext.json()).toMatchObject({ message: "Credential user scope does not match the signed actor" });
    expect(await outbound.json()).toMatchObject({ message: "Credential user scope does not match the signed actor" });
    const queries = vi.mocked(runtime.PLATFORM_DB.prepare).mock.calls.map(([sql]) => sql);
    expect(queries.some((sql) => /FROM\s+credentials\b/i.test(sql))).toBe(false);
  });

  it("rejects non-canonical and duplicated HMAC token fields", async () => {
    const token = await generateCredentialToken("secret", "s", "agent", undefined, "tenant");
    for (const malformed of [token.replace(/^(t=\d+)/, "$1suffix"), `${token},aid=other`]) {
      const response = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant",
          "x-naelao-credential-token": malformed,
        },
        body: JSON.stringify({ credentialName: "gemini", url: "https://example.com" }),
      }), env(), {} as ExecutionContext);
      expect(response.status).toBe(403);
    }
  });

  it("blocks outbound egress and credential plaintext after Space suspension", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const credentialToken = await generateCredentialToken("secret", "s", "agent", undefined, "tenant");
    const egress = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/outbound", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-credential-token": credentialToken },
      body: JSON.stringify({ credentialName: "gemini", url: "https://example.com" }),
    }), env(false), {} as ExecutionContext);
    const plaintext = await worker.fetch!(new Request("https://credentials/v1/internal/spaces/s/credentials/gemini/plaintext", {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant", "x-naelao-credential-token": credentialToken },
    }), env(false), {} as ExecutionContext);
    expect(egress.status).toBe(404);
    expect(plaintext.status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });
});
