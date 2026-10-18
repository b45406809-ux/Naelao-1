import { describe, expect, it, vi } from "vitest";
import { consumeOAuthTicket, issueOAuthTicket, oauthTicketKey } from "./oauth.js";

describe("provider OAuth callback tickets", () => {
  it("stores extension target scope with expiry and consumes it exactly once", async () => {
    const entries = new Map<string, string>();
    const kv = {
      put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => { expect(options?.expirationTtl).toBe(600); entries.set(key, value); }),
      get: vi.fn(async (key: string) => entries.get(key) ?? null),
      delete: vi.fn(async (key: string) => { entries.delete(key); }),
    } as never;
    const data = { verifier: "", spaceId: "space-a", tenantId: "tenant-a", userId: "owner-a", returnUrl: "https://app.naelao.app/settings", platform: "extension-slack",
      extensionConnection: { projectId: "project-a", installationId: "install-a", extensionId: "ext_mentor", connectionId: "slack-main" } };
    const ticket = await issueOAuthTicket(kv, data);
    expect(ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(entries.get(oauthTicketKey(ticket))).toBeTruthy();
    await expect(consumeOAuthTicket(kv, ticket)).resolves.toEqual(data);
    await expect(consumeOAuthTicket(kv, ticket)).resolves.toBeNull();
    expect(kv.delete).toHaveBeenCalledOnce();
  });

  it("deletes malformed ticket data before rejecting it", async () => {
    const key = oauthTicketKey("ticket");
    const entries = new Map([[key, "not-json"]]);
    const kv = { get: async (input: string) => entries.get(input) ?? null, delete: async (input: string) => { entries.delete(input); } } as never;
    await expect(consumeOAuthTicket(kv, "ticket")).resolves.toBeNull();
    expect(entries.has(key)).toBe(false);
  });
});
