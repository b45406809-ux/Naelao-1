import { mintInternalToken } from "@naelao/http";
import { digestExtensionManifest, validateExtensionManifest } from "@naelao/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import spacesWorker from "./index.js";

const secret = "project-extension-update-review-route-secret";
const extensionId = "ext_project_updates";
const publisherKeyId = "a".repeat(64);
const currentManifest = validateExtensionManifest({ id: extensionId, type: "extension", declaredPermissions: [],
  capabilityRequirements: ["extension.project_canvas"], gadgets: [], daemons: [], commands: [],
  bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: extensionId, version: "1.0.0", primitives: [
    { schemaVersion: "1.0", kind: "canvas", id: "dashboard", version: "1.0.0", permissions: [], capabilityRequirements: [],
      lifecycle: {}, component: "./dashboard.html", layout: "CanvasMount", dynamicPage: false },
  ] },
}, { gatekeeperCapabilities: ["extension.project_canvas"] });
const candidateManifest = validateExtensionManifest({ ...currentManifest,
  declaredPermissions: ["assistant.phone.simulate"], capabilityRequirements: ["extension.project_canvas", "assistant.phone.simulate"],
  resourceRequirements: [{ id: "uploads", kind: "objects", apiVersion: "1.0", scope: "project",
    operations: [{ id: "get", input: { schemaVersion: "1.0", fields: { key: { type: "string", required: true, maxLength: 128 } } },
      output: { schemaVersion: "1.0", fields: { found: { type: "boolean", required: true }, size: { type: "number", required: true, minimum: 0, maximum: 65536 },
        dataBase64: { type: "string", maxLength: 512 }, contentType: { type: "string", maxLength: 128 }, sha256: { type: "string", maxLength: 64 } } },
      idempotency: "none", meteringUnit: "byte" }], limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 1024 } }],
  bundle: { ...currentManifest.bundle!, version: "2.0.0", primitives: [...currentManifest.bundle!.primitives.map(primitive => ({ ...primitive, version: "2.0.0" })),
    { schemaVersion: "1.0", kind: "workflow", id: "read_file", version: "2.0.0", permissions: [], capabilityRequirements: [], lifecycle: {},
      executionMode: "headless", entry: "./read.ts", steps: ["read"], toolNames: ["extension.resource.objects"] }],
    workerRoles: [{ id: "reader", principal: "project_member", invocation: "workflow_step", execution: "worker", entry: "./read.ts", primitiveIds: ["read_file"] }] },
}, { gatekeeperCapabilities: ["extension.project_canvas", "assistant.phone.simulate"] });

function harness(options: { generation?: number; activeKey?: boolean; status?: "active" | "disabled"; candidate?: typeof candidateManifest } = {}) {
  const requests: Request[] = [];
  const installed = { instance_id: "instance-a", extension_id: extensionId, project_id: "project-a", scope: "PROJECT_BOUND",
    status: options.status ?? "active", generation: options.generation ?? 4, release_version: "1.0.0", manifest_sha256: "pending",
    pinned_artifact_sha256: "b".repeat(64), publisher_id: "publisher-a", publisher_key_id: publisherKeyId,
    publisher_attestation_valid: true, manifest: currentManifest };
  const stub = { fetch: vi.fn(async (request: Request) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/projects/project-a/automation-access") return Response.json({ project_id: "project-a", can_manage: true });
    if (url.pathname === "/extension-installations") return Response.json({ installations: [{ ...installed,
      manifest_sha256: await digestExtensionManifest(currentManifest) }] });
    if (url.pathname === "/extension-releases") return Response.json({ releases: [{ version: "2.0.0", manifest: options.candidate ?? candidateManifest,
      artifactSha256: "c".repeat(64), signatureValid: true, publisher: { id: "publisher-a", keyId: publisherKeyId } }] });
    if (url.pathname === "/extension-runtime-work") return Response.json({ active_work_count: 0 });
    return Response.json({ error_code: "unexpected_route" }, { status: 404 });
  }) };
  const env = { PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (..._values: unknown[]) => ({
      first: async () => sql.includes("FROM spaces WHERE id") ? { tenant_id: "tenant-a", name: "Space" } : null,
      all: async () => ({ results: options.activeKey === false ? [] : [{ key_id: publisherKeyId }] }),
    }) }) },
    SPACE_DO: { idFromName: () => "space-do", get: () => stub },
  } as never;
  return { env, requests };
}

async function post(env: unknown, body: unknown, role = "admin") {
  return spacesWorker.fetch(new Request(`https://spaces.test/spaces/space-a/projects/project-a/extension-installations/instance-a/update-review`, {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
      "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": role }, body: JSON.stringify(body),
  }), env as never);
}

const body = (generation = 4) => ({ candidate_version: "2.0.0", expected_generation: generation,
  expected_current_version: "1.0.0", expected_manifest_sha256: "pending" });

describe("PROJECT_BOUND extension update review route", () => {
  it("returns exact signed candidate and change deltas without mutating the install", async () => {
    const h = harness();
    const requestBody = body();
    requestBody.expected_manifest_sha256 = await digestExtensionManifest(currentManifest);
    const response = await post(h.env, requestBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installation_id: "instance-a", installation_generation: 4,
      candidate: { version: "2.0.0", artifact_sha256: "c".repeat(64), signature_verified: true },
      permissions: { added: ["assistant.phone.simulate"] }, capabilities: { added: ["assistant.phone.simulate"] },
      resources: { added: ["uploads"] }, cost_terms: { status: "unknown" }, apply_supported: false, mutates_installation: false });
    expect(h.requests.some(request => new URL(request.url).pathname === "/extension-installation/activate")).toBe(false);
  });

  it("rejects stale generations, revoked publisher keys, and non-admin callers before review", async () => {
    const stale = harness();
    const staleBody = body(3);
    staleBody.expected_manifest_sha256 = await digestExtensionManifest(currentManifest);
    expect((await post(stale.env, staleBody)).status).toBe(409);

    const revoked = harness({ activeKey: false });
    const revokedBody = body();
    revokedBody.expected_manifest_sha256 = await digestExtensionManifest(currentManifest);
    expect((await post(revoked.env, revokedBody)).status).toBe(409);

    const member = harness();
    expect((await post(member.env, body(), "member")).status).toBe(403);
  });

  it("issues a short signed apply token only for a paused, drained, version-only update", async () => {
    const versionOnly = validateExtensionManifest({ ...currentManifest, bundle: { ...currentManifest.bundle!, version: "2.0.0",
      primitives: currentManifest.bundle!.primitives.map(primitive => ({ ...primitive, version: "2.0.0" })) },
    }, { gatekeeperCapabilities: ["extension.project_canvas"] });
    const h = harness({ status: "disabled", candidate: versionOnly });
    const requestBody = body();
    requestBody.expected_manifest_sha256 = await digestExtensionManifest(currentManifest);
    const response = await post(h.env, requestBody);
    const result = await response.json() as { apply_supported?: boolean; apply_block_reason?: string | null;
      update_review_token?: string; update_review_expires_at?: number };
    expect(response.status).toBe(200);
    expect(result.apply_supported).toBe(true);
    expect(result.update_review_token).toBeTruthy();
    expect(result.update_review_expires_at).toBeGreaterThan(Date.now());
    expect(result.apply_block_reason).toBeNull();
    expect(h.requests.some(request => new URL(request.url).pathname === "/extension-installation/activate")).toBe(false);
  });
});
