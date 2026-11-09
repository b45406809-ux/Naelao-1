import { describe, expect, it } from "vitest";
import { app, fetchAgentsRequest } from "./index.js";
import { mintInternalToken } from "@naelao/http";

describe("Agents inbound request body limits", () => {
  it("rejects an oversized tunnel enrollment before parsing or reaching Spaces", async () => {
    const response = await app.request(
      "/tunnel/enroll",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(32_769),
      },
      { PLATFORM_SECRET: "test-secret" } as never
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error_code: "payload_too_large",
    });
  });

  it("bounds every JSON route at the Worker entry point", async () => {
    const request = new Request("https://agents.example.test/unmatched", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(4 * 1024 * 1024 + 1),
    });
    const response = await fetchAgentsRequest(
      request,
      { PLATFORM_SECRET: "test-secret" } as never,
      {} as never
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error_code: "payload_too_large",
    });
  });

  it("allows sandbox workspace transfer bodies above the generic JSON limit", async () => {
    const secret = "test-secret";
    const tenantId = "tenant-a";
    const request = new Request("https://agents.example.test/internal/sandbox-workspaces/blobs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-user-id": "user-a",
        "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
      body: JSON.stringify({ filesystemId: "missing", contentBase64: "A".repeat(5 * 1024 * 1024) }),
    });
    const response = await fetchAgentsRequest(request, {
      PLATFORM_SECRET: secret,
      UNIFIED_WORKSPACE_ENABLED: "true",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      SCRIPTS_R2: {} as never,
    } as never, {} as never);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error_code: "filesystem_not_found" });
  });

  it("accepts the encoded 20 MiB Agent37 workspace handoff under the explicit 30 MiB Worker bound", async () => {
    const secret = "test-secret";
    const tenantId = "tenant-a";
    const encodedBytes = Math.ceil((20 * 1024 * 1024) / 3) * 4;
    const request = new Request("https://agents.example.test/internal/sandbox-agent37-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-user-id": "user-a",
        "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
      body: JSON.stringify({ computerId: "cmp_1", runtimeId: "cmp_1", operation: "open", allocationGeneration: 1, contentBase64: "A".repeat(encodedBytes) }),
    });
    const response = await fetchAgentsRequest(request, {
      PLATFORM_SECRET: secret,
      UNIFIED_WORKSPACE_ENABLED: "true",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as never, {} as never);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error_code: "computer_not_project_scoped" });
  }, 30_000);

  it("keeps Agent37 checked workspace operations behind the global workspace flag", async () => {
    const secret = "test-secret";
    const tenantId = "tenant-a";
    const response = await app.request("/internal/sandbox-agent37-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-user-id": "user-a",
        "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
      body: JSON.stringify({ computerId: "cmp_1", operation: "open", allocationGeneration: 1 }),
    }, { PLATFORM_SECRET: secret, UNIFIED_WORKSPACE_ENABLED: "false" } as never);
    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toMatchObject({ error_code: "workspace_global_kill_switch_active" });
  });
});
