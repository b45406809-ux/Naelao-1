import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { verifyHmac } from "@naelao/crypto";
import { verifyInternalToken } from "@naelao/http";
import { createModalHostClient } from "./modal-host-client.js";

const secret = "modal-host-test-secret-000000000000000000000000";
const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a" };

describe("Modal host client", () => {
  it("authenticates the host call with exact scope and a stable operation identity", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ id: "sbx_abc123", state: "running" });
    }) as unknown as typeof fetch;
    const client = createModalHostClient({ hostUrl: "https://modal-host.example", platformSecret: secret,
      scope, operationId: "modal:operation-1", idempotencyKey: "owner-request-1", fetchImpl });
    await expect(client.create({ image: `registry.example/sandbox@sha256:${"a".repeat(64)}`, cpu: 2, memoryMb: 8192, region: "us-east-1",
      timeoutSeconds: 300, gpu: "L4" })).resolves.toEqual({ id: "sbx_abc123", state: "running" });
    expect(new URL(requests[0]!.url).pathname).toBe("/v1/sandboxes");
    expect(requests[0]!.headers.get("x-naelao-tenant-id")).toBe(scope.tenantId);
    expect(await verifyInternalToken(requests[0]!.headers.get("x-naelao-internal-token") ?? undefined, scope.tenantId, secret)).toBe(true);
    expect(requests[0]!.headers.get("x-naelao-space-id")).toBe(scope.spaceId);
    expect(requests[0]!.headers.get("x-naelao-project-id")).toBe(scope.projectId);
    const requestSignature = requests[0]!.headers.get("x-naelao-modal-request-signature") ?? "";
    const timestamp = requestSignature.match(/(?:^|,)t=(\d+)(?:,|$)/)?.[1];
    const signature = requestSignature.match(/(?:^|,)v1=([a-f0-9]{64})(?:,|$)/)?.[1];
    const bodyText = await requests[0]!.clone().text();
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    expect(timestamp && signature && await verifyHmac(
      JSON.stringify(["modal-request-v1", timestamp, "POST", "/v1/sandboxes", scope.tenantId, scope.spaceId,
        scope.projectId, "modal:operation-1", "owner-request-1", bodyHash]), signature, secret,
    )).toBe(true);
    expect(requests[0]!.headers.get("x-naelao-operation-id")).toBe("modal:operation-1");
    expect(requests[0]!.headers.get("idempotency-key")).toBe("owner-request-1");
    expect(await requests[0]!.json()).toEqual({ scope, spec: {
      image: `registry.example/sandbox@sha256:${"a".repeat(64)}`, cpu: 2, memoryMb: 8192, timeoutSeconds: 300, gpu: "L4",
      region: "us-east-1",
    } });
  });

  it("reads only bounded, validated usage receipts and encodes provider IDs", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (request: Request) => {
      urls.push(request.url);
      if (request.method === "GET") return Response.json({ state: "stopped", actualCredits: 12 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = createModalHostClient({ hostUrl: "https://modal-host.example", platformSecret: secret,
      scope, operationId: "modal:operation-2", idempotencyKey: "owner-request-2", fetchImpl });
    await expect(client.inspect("sbx:abc")).resolves.toEqual({ state: "stopped", actualCredits: 12 });
    await client.terminate("sbx:abc");
    expect(urls.map(url => new URL(url).pathname)).toEqual([
      "/v1/sandboxes/sbx%3Aabc", "/v1/sandboxes/sbx%3Aabc",
    ]);
    await expect(client.inspect("bad id")).rejects.toThrow("modal_provider_id_invalid");
  });

  it("fails closed on an untrusted host URL, invalid receipt, and provider error", async () => {
    expect(() => createModalHostClient({ hostUrl: "http://modal-host.example", platformSecret: secret,
      scope, operationId: "modal:3", idempotencyKey: "request-3" })).toThrow("modal_host_configuration_invalid");
    const malformed = createModalHostClient({ hostUrl: "https://modal-host.example", platformSecret: secret,
      scope, operationId: "modal:4", idempotencyKey: "request-4",
      fetchImpl: vi.fn(async () => Response.json({ state: "running", actualCredits: -1 })) as unknown as typeof fetch });
    await expect(malformed.inspect("sbx_1")).rejects.toThrow("modal_host_receipt_invalid");
    const unavailable = createModalHostClient({ hostUrl: "https://modal-host.example", platformSecret: secret,
      scope, operationId: "modal:5", idempotencyKey: "request-5",
      fetchImpl: vi.fn(async () => Response.json({ error: "secret should not pass through" }, { status: 503 })) as unknown as typeof fetch });
    await expect(unavailable.terminate("sbx_1")).rejects.toThrow("modal_host_unavailable");
  });
});
