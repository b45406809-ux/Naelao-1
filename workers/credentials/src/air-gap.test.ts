import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { generateCredentialToken, type CredentialsEnv } from "./index.js";

function env(): CredentialsEnv {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    CREDENTIAL_ENCRYPTION_KEY: `v1:${"11".repeat(32)}`,
    ANALYTICS: {} as AnalyticsEngineDataset,
    PLATFORM_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({ config_json: '{"compliance":{"airGappedOnly":true}}' })),
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
        "x-naelao-credential-token": await generateCredentialToken("secret", "s", "agent"),
      },
      body: JSON.stringify({ credentialName: "gemini", url: "https://example.com" }),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    expect(outbound).not.toHaveBeenCalled();
  });
});
