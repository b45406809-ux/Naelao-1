import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createModalHostHandler, type ModalHostConfig, type ModalHostProvider, type ModalHostScope, type ModalHostSpec } from "./host.js";

const secret = "host-boundary-test-secret-0000000000000000";
const now = 1_794_600_000_000;
const scope: ModalHostScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a" };
const spec: ModalHostSpec = { image: `registry.example/sandbox@sha256:${"a".repeat(64)}`, cpu: 2,
  memoryMb: 8192, region: "us-east-1", timeoutSeconds: 300, gpu: "L4" };
const config: ModalHostConfig = { enabled: true, betaAccepted: true, privateGrpcAccepted: true, platformSecret: secret,
  image: spec.image, allowedRegions: ["us-east-1"], allowedGpus: ["L4"], maxCpu: 8, maxMemoryMb: 32_768, maxTimeoutSeconds: 3600 };

function headers(overrides: Record<string, string> = {}): Headers {
  const timestamp = String(now);
  const signature = createHmac("sha256", secret).update(`internal:${scope.tenantId}:${timestamp}`).digest("hex");
  return new Headers({ "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
    "x-naelao-internal-token": `t=${timestamp},v1=${signature}`, "x-naelao-operation-id": "modal:operation-1",
    "x-naelao-space-id": scope.spaceId, "x-naelao-project-id": scope.projectId,
    "idempotency-key": "create-1", ...overrides });
}
function request(method: string, path: string, body?: unknown, requestHeaders = headers()): Request {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(now);
  const requestUrl = new URL(`http://modal-host${path}`);
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  const payload = JSON.stringify(["modal-request-v1", timestamp, method, requestUrl.pathname + requestUrl.search,
    requestHeaders.get("x-naelao-tenant-id"), requestHeaders.get("x-naelao-space-id"), requestHeaders.get("x-naelao-project-id"),
    requestHeaders.get("x-naelao-operation-id"), requestHeaders.get("idempotency-key"), bodyHash]);
  const requestSignature = createHmac("sha256", secret).update(payload).digest("hex");
  const signedHeaders = new Headers(requestHeaders);
  if (!signedHeaders.has("x-naelao-modal-request-signature"))
    signedHeaders.set("x-naelao-modal-request-signature", `t=${timestamp},v1=${requestSignature}`);
  return new Request(`http://modal-host${path}`, { method, headers: signedHeaders,
    ...(body === undefined ? {} : { body: bodyText }) });
}
function provider(): ModalHostProvider {
  return {
    findByName: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "sbx_provider_1", state: "running" as const })),
    inspect: vi.fn(async () => ({ state: "stopped" as const })),
    terminate: vi.fn(async () => undefined),
  };
}

describe("Modal Node host boundary", () => {
  it("rejects altered signed operation identity, method, path, and body before provider effects", async () => {
    const modal = provider();
    const handler = createModalHostHandler(config, modal, () => now);
    const payload = { scope, spec };
    const signed = request("POST", "/v1/sandboxes", payload);

    const changedBody = new Request(signed.url, { method: signed.method, headers: signed.headers,
      body: JSON.stringify({ scope, spec: { ...spec, cpu: 4 } }) });
    expect((await handler(changedBody)).status).toBe(403);

    const changedOperationHeaders = new Headers(signed.headers);
    changedOperationHeaders.set("x-naelao-operation-id", "modal:operation-2");
    expect((await handler(new Request(signed.url, { method: signed.method, headers: changedOperationHeaders,
      body: JSON.stringify(payload) }))).status).toBe(403);

    expect((await handler(new Request(signed.url, { method: "GET", headers: signed.headers }))).status).toBe(403);
    expect((await handler(new Request("http://modal-host/v1/sandboxes/sbx_provider_1", {
      method: "GET", headers: signed.headers,
    }))).status).toBe(403);
    expect(modal.create).not.toHaveBeenCalled();
    expect(modal.inspect).not.toHaveBeenCalled();
  });

  it("uses a deterministic provider name so retried create requests do not create duplicates", async () => {
    const modal = provider();
    const handler = createModalHostHandler(config, modal, () => now);
    const payload = { scope, spec };
    const created = await handler(request("POST", "/v1/sandboxes", payload));
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: "sbx_provider_1", state: "running" });
    const name = vi.mocked(modal.create).mock.calls[0]![0];
    expect(name).toMatch(/^naelao-[a-f0-9]{48}$/);
    vi.mocked(modal.findByName).mockResolvedValueOnce({ id: "sbx_provider_1", state: "running" });
    const replay = await handler(request("POST", "/v1/sandboxes", payload));
    expect(replay.status).toBe(200);
    expect(modal.create).toHaveBeenCalledOnce();
  });

  it("rejects forged or stale internal identity and cross-tenant payload scope", async () => {
    const handler = createModalHostHandler(config, provider(), () => now);
    expect((await handler(request("POST", "/v1/sandboxes", { scope, spec }, headers({ "x-naelao-internal-token": "bad" })))).status).toBe(403);
    const otherScope = { ...scope, tenantId: "tenant-b" };
    expect((await handler(request("POST", "/v1/sandboxes", { scope: otherScope, spec }))).status).toBe(400);
    const stale = headers();
    stale.set("x-naelao-internal-token", `t=${now - 60_001},v1=${createHmac("sha256", secret).update(`internal:${scope.tenantId}:${now - 60_001}`).digest("hex")}`);
    expect((await handler(request("POST", "/v1/sandboxes", { scope, spec }, stale))).status).toBe(403);
  });

  it("enforces host-pinned image, region, resource bounds and network policy by omission", async () => {
    const modal = provider();
    const handler = createModalHostHandler(config, modal, () => now);
    expect((await handler(request("POST", "/v1/sandboxes", { scope, spec: { ...spec, image: "alpine:latest" } }))).status).toBe(400);
    expect((await handler(request("POST", "/v1/sandboxes", { scope, spec: { ...spec, region: "eu-west-1" } }))).status).toBe(400);
    expect((await handler(request("POST", "/v1/sandboxes", { scope, spec: { ...spec, cpu: 64 } }))).status).toBe(400);
    expect(modal.create).not.toHaveBeenCalled();
  });

  it("fails closed while any rollout or private SDK contract gate is off", async () => {
    const modal = provider();
    const handler = createModalHostHandler({ ...config, privateGrpcAccepted: false }, modal, () => now);
    expect((await handler(request("POST", "/v1/sandboxes", { scope, spec }))).status).toBe(503);
    expect(modal.create).not.toHaveBeenCalled();
  });

  it("recovers a lost create response through lookup and exposes only state, not invented cost", async () => {
    const modal = provider();
    vi.mocked(modal.create).mockRejectedValueOnce(new Error("response lost"));
    vi.mocked(modal.findByName).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "sbx_provider_1", state: "running" })
      .mockResolvedValueOnce({ id: "sbx_provider_1", state: "running" });
    const handler = createModalHostHandler(config, modal, () => now);
    expect((await handler(request("POST", "/v1/sandboxes", { scope, spec }))).status).toBe(200);
    expect(modal.create).toHaveBeenCalledOnce();
    const inspected = await handler(request("GET", "/v1/sandboxes/sbx_provider_1", undefined, headers()));
    expect(await inspected.json()).toEqual({ state: "stopped" });
  });

  it("supports safe state lookup and termination with encoded provider IDs", async () => {
    const modal = provider();
    vi.mocked(modal.findByName).mockResolvedValue({ id: "sbx:provider-1", state: "running" });
    const handler = createModalHostHandler(config, modal, () => now);
    const inspected = await handler(request("GET", "/v1/sandboxes/sbx%3Aprovider-1"));
    expect(inspected.status).toBe(200);
    expect(modal.inspect).toHaveBeenCalledWith("sbx:provider-1");
    expect((await handler(request("DELETE", "/v1/sandboxes/sbx%3Aprovider-1"))).status).toBe(204);
    expect(modal.terminate).toHaveBeenCalledWith("sbx:provider-1");
    expect((await handler(request("GET", "/v1/sandboxes/sbx%2Fprovider-1"))).status).toBe(400);
  });

  it("requires a signed exact tenant/Space/Project scope and proves provider-ID ownership before read or terminate", async () => {
    const modal = provider();
    const handler = createModalHostHandler(config, modal, () => now);
    const signedRead = request("GET", "/v1/sandboxes/sbx_provider_1");
    const forgedSpace = new Headers(signedRead.headers);
    forgedSpace.set("x-naelao-space-id", "space-b");
    expect((await handler(new Request(signedRead.url, { method: signedRead.method, headers: forgedSpace }))).status).toBe(403);

    expect((await handler(request("GET", "/v1/sandboxes/sbx_provider_1"))).status).toBe(404);
    expect((await handler(request("DELETE", "/v1/sandboxes/sbx_provider_1"))).status).toBe(404);
    expect(modal.inspect).not.toHaveBeenCalled();
    expect(modal.terminate).not.toHaveBeenCalled();

    vi.mocked(modal.findByName).mockResolvedValue({ id: "sbx_provider_1", state: "running" });
    expect((await handler(request("GET", "/v1/sandboxes/sbx_provider_1"))).status).toBe(200);
    expect((await handler(request("DELETE", "/v1/sandboxes/sbx_provider_1"))).status).toBe(204);
    expect(modal.inspect).toHaveBeenCalledOnce();
    expect(modal.terminate).toHaveBeenCalledOnce();
  });
});
