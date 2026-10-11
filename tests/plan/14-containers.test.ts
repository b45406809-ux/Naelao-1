import { describe, expect, it, vi } from "vitest";
import { defineContainer, validateExtensionManifest, type ContainerContract } from "../../packages/agent-sdk/src/extensions.js";
import { approvedContainer, assertBrowserContainerLease, parseApprovedContainerImages, resolveContainerBinary, sidecarKey, validateContainerScope, type ContainerInvocationScope, type InstalledContainer } from "../../workers/agents/src/script-engine/container-policy.js";
import { buildCodeRunner } from "../../workers/agents/src/script-engine/code-runner.js";
import { ToolSandboxDO } from "../../workers/agents/src/do/ToolSandboxDO.js";
import { mintInternalToken } from "@naelao/http";

const image = "registry.example/media@sha256:" + "a".repeat(64);
function contract(): ContainerContract { return { schemaVersion: "1.0", kind: "container", id: "media", version: "1.0.0", permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "workspace" }], capabilityRequirements: ["native-execution"], lifecycle: {}, image, resources: { memoryMb: 1024, cpuCores: 0.25, timeoutSeconds: 55 }, exportedBinaries: ["ffmpeg", "ffprobe"], networkPolicy: "none" }; }
function installed(): InstalledContainer { return { tenantId: "tenant", spaceId: "space", projectId: "project", installationId: "install-one", extensionId: "ext_media", contract: contract() }; }
function scope(): ContainerInvocationScope { return { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "user", agentId: "worker", runId: "run", executionId: "execution", timeoutMs: 55000, deadline: Date.now() + 55000 }; }
const owner = { tenantId: "tenant", spaceId: "space", projectId: "project", userId: "user" };
const invocation = () => ({ name: "code-exec.execute_bash", code: "export async function run() { return 1 }", args: {}, tier: 6 as const, tenantId: "tenant", spaceId: "space", projectId: "project", userId: "user", agentId: "worker", runId: "run", maxTier: 6 as const });

describe("Step 14 bounded general and extension containers", () => {
  it("requires immutable pins and finite bounded resource declarations", () => {
    expect(defineContainer(contract()).image).toBe(image);
    expect(() => defineContainer({ ...contract(), image: "node:latest" })).toThrow("digest");
    expect(() => defineContainer({ ...contract(), resources: { ...contract().resources, memoryMb: Infinity } })).toThrow("resource");
    expect(() => defineContainer({ ...contract(), resources: { ...contract().resources, timeoutSeconds: 61 } })).toThrow("resource");
    expect(() => defineContainer({ ...contract(), exportedBinaries: ["../escape"] })).toThrow("exports");
    const manifest = { id: "ext_media", type: "extension", declaredPermissions: ["container:execute"], capabilityRequirements: ["native-execution"], gadgets: [], daemons: [], commands: [], containers: [contract()] };
    expect(validateExtensionManifest(manifest).containers).toHaveLength(1);
  });
  it("resolves only active scoped installations and requires qualification on collisions", () => {
    const other = { ...installed(), extensionId: "ext_other", installationId: "install-two" };
    expect(() => resolveContainerBinary("ffmpeg", [installed(), other], owner)).toThrow("ambiguous");
    expect(resolveContainerBinary("ext_media/media/ffmpeg", [installed(), other], owner)?.installationId).toBe("install-one");
    expect(resolveContainerBinary("ffmpeg", [{ ...installed(), projectId: "other-project" }], owner)).toBeUndefined();
    expect(sidecarKey({ ...scope(), installationId: "one", image })).not.toBe(sidecarKey({ ...scope(), installationId: "two", image }));
  });
  it("rejects undeployed images, mutable registry entries and unsupported mount/network profiles", () => {
    const registry = parseApprovedContainerImages(JSON.stringify([{ image, binding: "MEDIA_SANDBOX", memoryMb: 4096, cpuCores: 0.5, schedulingPolicy: "default", networkPolicy: "none" }]));
    expect(approvedContainer(installed(), registry).binding).toBe("MEDIA_SANDBOX");
    expect(() => approvedContainer({ ...installed(), contract: { ...contract(), image: image.replace(/a/g, "b") } }, registry)).toThrow("approved");
    expect(() => approvedContainer({ ...installed(), contract: { ...contract(), mounts: [{ path: "/workspace", writable: false }] } }, registry)).toThrow("mount");
    expect(() => parseApprovedContainerImages(JSON.stringify([{ ...registry[0], schedulingPolicy: "durable_object" }]))).toThrow("registry");
  });
  it("requires a live consenting browser and never moves local-only work to cloud", async () => {
    const lease = { ...owner, actorId: "user", runId: "run", expiresAt: Date.now() + 30000, live: true, consent: true, crossOriginIsolated: true };
    expect(() => assertBrowserContainerLease(lease, scope(), true)).not.toThrow();
    expect(() => assertBrowserContainerLease({ ...lease, live: false }, scope(), true)).toThrow("disconnected");
    expect(() => assertBrowserContainerLease(lease, scope(), false)).toThrow("native");
    const fetcher = { fetch: vi.fn() } as unknown as Fetcher;
    const result = await buildCodeRunner({ airGappedOnly: true, authorizeContainer: async () => true, webContainer: fetcher }).run({ ...invocation(), containerOptions: { backend: "webcontainer" } });
    expect(result.ok).toBe(false); expect(fetcher.fetch).not.toHaveBeenCalled();
  });
  it("checks ceiling and host authorization before selecting native capacity", async () => {
    const authorize = vi.fn(async () => false);
    expect((await buildCodeRunner({ authorizeContainer: authorize }).run(invocation())).ok).toBe(false);
    expect((await buildCodeRunner({ authorizeContainer: async () => true }).run({ ...invocation(), maxTier: 5 })).ok).toBe(false);
    expect(() => validateContainerScope({ ...scope(), actorId: "system" })).toThrow("actor");
    expect(() => validateContainerScope({ ...scope(), timeoutMs: NaN })).toThrow("deadline");
  });
  it("routes a sidecar through the real runner with task ownership and observed output", async () => {
    const requests: Request[] = [];
    const namespace = { idFromName: vi.fn((key: string) => key), get: () => ({ fetch: async (request: Request) => { requests.push(request); return Response.json({ ok: true, result: { stdout: "clip.mp4", exit_code: 0 }, workspace_sync: { persisted: ["clip.mp4"] } }); } }) } as unknown as DurableObjectNamespace;
    const result = await buildCodeRunner({ authorizeContainer: async () => true, platformSecret: "secret", resolveSidecar: async () => ({ installation: installed(), namespace }) }).run({ ...invocation(), containerImage: image, installationId: "install-one" });
    expect(result.output).toMatchObject({ stdout: "clip.mp4", workspace_sync: { persisted: ["clip.mp4"] } });
    expect(namespace.idFromName).toHaveBeenCalledWith(expect.stringContaining("install-one"));
    expect(JSON.parse(requests[0]!.headers.get("x-naelao-container-scope")!)).toMatchObject({ image, installationId: "install-one", actorId: "user", runId: "run" });
    expect(requests).toHaveLength(1);
  });
  it("sends cancellation to the owning instance without retrying on a different backend", async () => {
    const controller = new AbortController();
    const requests: Request[] = [];
    const namespace = { idFromName: (key: string) => key, get: () => ({ fetch: async (request: Request) => {
      requests.push(request);
      if (new URL(request.url).pathname === "/cancel") return Response.json({ ok: true });
      return new Promise<Response>((_, reject) => { request.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }); controller.abort(); });
    } }) } as unknown as DurableObjectNamespace;
    const result = await buildCodeRunner({ toolSandbox: namespace, authorizeContainer: async () => true, platformSecret: "secret" }).run({ ...invocation(), signal: controller.signal });
    expect(result.ok).toBe(false); expect(result.error).toBe("container_cancelled");
    expect(requests.filter(request => new URL(request.url).pathname === "/exec")).toHaveLength(1);
    expect(requests.some(request => new URL(request.url).pathname === "/cancel")).toBe(true);
  });
});

describe("production container lifecycle", () => {
  function fixture() {
    const records = new Map<string, unknown>(); let running = false;
    const requests: Request[] = [], billing: Request[] = [];
    const runtime = { get running() { return running; }, start: vi.fn(() => { running = true; }), destroy: vi.fn(async () => { running = false; }), inspect: vi.fn(async () => ({ image })),
      getTcpPort: () => ({ fetch: async (request: Request) => { requests.push(request); return Response.json({ ok: true, result: { stdout: "built" } }); } }) };
    const ctx = { container: runtime, storage: { get: async (key: string) => records.get(key), put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); }, delete: async (key: string) => records.delete(key), setAlarm: vi.fn(async () => undefined) } };
    const env = { PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch: async (request: Request) => { billing.push(request); return Response.json({ reservation_id: (await request.clone().json()).reservation_id }); } } };
    return { sandbox: new ToolSandboxDO(ctx as never, env as never), runtime, records, requests, billing, ctx, env };
  }
  async function request(path: string, identity = scope(), body = {}) {
    return new Request("http://sandbox" + path, { method: "POST", headers: { "content-type": "application/json", "x-naelao-container-scope": JSON.stringify(identity), "x-naelao-internal-token": await mintInternalToken("secret", "tenant") }, body: JSON.stringify(body) });
  }
  it("prewarms without executing/hydrating artifacts and charges unused capacity on idle shutdown", async () => {
    const f = fixture(); const identity = scope();
    expect((await f.sandbox.fetch(await request("/prewarm", identity))).ok).toBe(true);
    expect(f.runtime.start).toHaveBeenCalledWith({ enableInternet: false });
    expect(f.requests.map(request => new URL(request.url).pathname)).toEqual(["/control/init"]);
    expect(f.billing).toHaveLength(1);
    f.records.set("last_used_at", Date.now() - 61000);
    await f.sandbox.alarm();
    expect(f.runtime.destroy).toHaveBeenCalledOnce();
    expect(f.records.has("container_meter")).toBe(false);
    expect(f.billing.map(request => new URL(request.url).pathname)).toEqual(["/internal/workflows/budget/reserve", "/internal/workflows/budget/settle"]);
    expect(f.records.get("last_container_gas")).toMatchObject({ credits: expect.any(Number) });
  });
  it("recovers a committed execution receipt after recreation without repeating a mutation", async () => {
    const f = fixture(); const identity = scope();
    await f.sandbox.fetch(await request("/prewarm", identity));
    const count = f.requests.length;
    const recovered = new ToolSandboxDO(f.ctx as never, f.env as never);
    const replay = await recovered.fetch(await request("/prewarm", identity));
    expect(replay.ok).toBe(true); expect(f.requests).toHaveLength(count);
    // Persisted prepared/indeterminate records never run automatically after a restart.
    const saved = f.records.get("execution:" + identity.executionId) as { status: string };
    f.records.set("execution:" + identity.executionId, { ...saved, status: "indeterminate" });
    expect((await f.sandbox.fetch(await request("/prewarm", identity))).status).toBe(409);
  });
  it("fails a deployed image mismatch before running guest code and releases the reservation", async () => {
    const f = fixture(); f.runtime.inspect.mockResolvedValue({ image: "registry.example/other@sha256:" + "b".repeat(64) });
    const result = await f.sandbox.fetch(await request("/prewarm", { ...scope(), image, installationId: "install-one" }));
    expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ error: expect.stringContaining("digest_mismatch") });
    expect(f.runtime.destroy).toHaveBeenCalledOnce(); expect(f.records.has("container_meter")).toBe(false);
  });
  it("refuses allocation when quota cannot be reserved", async () => {
    const f = fixture();
    const denied = new ToolSandboxDO({ container: f.runtime, storage: { get: async (key: string) => f.records.get(key), put: async (key: string, value: unknown) => { f.records.set(key, value); }, delete: async (key: string) => f.records.delete(key), setAlarm: async () => undefined } } as never,
      { PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch: async () => Response.json({ error: "quota_exhausted" }, { status: 429 }) } } as never);
    expect((await denied.fetch(await request("/prewarm"))).ok).toBe(false); expect(f.runtime.start).not.toHaveBeenCalled();
  });
});
