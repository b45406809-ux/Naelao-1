import { describe, it, expect, vi } from "vitest";
import type { AgentsEnv } from "../index.js";
import type { CommunicationIdentity, CommunicationScope } from "./core.js";
import { configureTelnyxAccount, telnyxAccountStatus, removeTelnyxAccount } from "./telnyx-account.js";
import { handlePhoneAction } from "./phones.js";

const identity = { id: "identity-1", tenant_id: "tenant-1", space_id: "space-1" } as CommunicationIdentity;
const scope = { tenantId: "tenant-1", spaceId: "space-1", userId: "owner-1", role: "owner" } as CommunicationScope;
const input = { api_key: "test-api-key-123456", public_key: btoa("x".repeat(32)), number_id: "12345" };
describe("Telnyx account preparation", () => {
  it("verifies the exact account-owned number before storing scoped credentials", async () => {
    const vault = vi.fn(async (request: Request) => {
      const body = await request.json() as { name: string; value: string };
      expect(body.name).toBe("ASSISTANT_PHONE_TELNYX_identity-1");
      expect(JSON.parse(body.value)).toMatchObject({ verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" });
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-1");
      return Response.json({ stored: true });
    });
    const env = { PLATFORM_SECRET: "secret", CREDENTIALS_WORKER: { fetch: vault } } as unknown as AgentsEnv;
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { id: "12345", phone_number: "+14155550100" } }));
    const result = await configureTelnyxAccount(env, scope, identity, input, provider);
    expect(provider.mock.calls[0]?.[0]).toBe("https://api.telnyx.com/v2/phone_numbers/12345");
    expect(result).toMatchObject({ configured: true, transport_active: false });
    expect(JSON.stringify(result)).not.toContain(input.api_key);
    expect(vault).toHaveBeenCalledTimes(1);
  });
  it("never stores credentials for a mismatching provider receipt", async () => {
    const vault = vi.fn();
    const env = { CREDENTIALS_WORKER: { fetch: vault } } as unknown as AgentsEnv;
    await expect(configureTelnyxAccount(env, scope, identity, input, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { id: "other", phone_number: "+14155550100" } })))).rejects.toThrow("telnyx_number_receipt_invalid");
    expect(vault).not.toHaveBeenCalled();
  });
  it("does not return credentials in setup status", async () => {
    const env = { PLATFORM_SECRET: "secret", CREDENTIALS_WORKER: { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: input.api_key, publicKey: input.public_key, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } } as unknown as AgentsEnv;
    const status = await telnyxAccountStatus(env, identity);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(input.api_key);
    expect(JSON.stringify(status)).not.toContain(input.public_key);
  });
  it("rejects worker and nonmanager configuration before any provider or Vault access", async () => {
    for (const [manager, agent] of [[false, false], [true, true]]) {
      await expect(handlePhoneAction({} as AgentsEnv, scope, identity, "phone-telnyx-configure", input, manager!, agent!)).rejects.toThrow("human_control_required");
    }
  });
  it("removes only this identity's Space credential", async () => {
    const vault = vi.fn(async (request: Request) => request.method === "DELETE" ? Response.json({ deleted: true }) : Response.json({ credentials: [
      { id: "correct", name: "ASSISTANT_PHONE_TELNYX_identity-1", scope: "space", project_id: null },
      { id: "other", name: "ASSISTANT_PHONE_TELNYX_identity-2", scope: "space", project_id: null },
      { id: "private", name: "ASSISTANT_PHONE_TELNYX_identity-1", scope: "user", project_id: null },
    ] }));
    const env = { PLATFORM_SECRET: "secret", CREDENTIALS_WORKER: { fetch: vault } } as unknown as AgentsEnv;
    await expect(removeTelnyxAccount(env, scope, identity)).resolves.toMatchObject({ configured: false });
    expect(vault).toHaveBeenCalledTimes(2);
    expect(vault.mock.calls[1]?.[0].url).toBe("http://credentials/spaces/space-1/credentials/correct");
  });
});
