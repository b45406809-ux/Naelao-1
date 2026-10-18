import { describe, expect, it, vi } from "vitest";
import { reportExtensionArtifactWrite } from "./extension-storage-usage.js";

describe("extension artifact storage usage", () => {
  const input = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", bundleId: "mentor", version: "1.2.0", path: "./handler.ts", bytes: 137 };

  it("records newly written bytes as unpriced project storage with stable artifact idempotency", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await reportExtensionArtifactWrite({ PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch } as never }, input);
    const request = fetch.mock.calls[0]?.[0] as Request;
    const event = await request.json() as Record<string, unknown>;
    expect(event).toMatchObject({ schema_version: 2, event_type: "storage_bytes_written", quantity: 137,
      unit: "bytes", space_id: "space-a", project_id: "project-a", run_id: "mentor@1.2.0:./handler.ts", payer_kind: "unknown", decision: "allowed" });
    expect(event.idempotency_key).toBe("extension-artifact:space-a:mentor:1.2.0:./handler.ts");
    expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
  });

  it("does not emit invalid/zero quantities or fail the install when billing is unavailable", async () => {
    const fetch = vi.fn();
    await reportExtensionArtifactWrite({ PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch } as never }, { ...input, bytes: 0 });
    await reportExtensionArtifactWrite({ PLATFORM_SECRET: "secret" }, input);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("absorbs billing delivery failures after an artifact has been written", async () => {
    const fetch = vi.fn(async () => { throw new Error("unavailable"); });
    await expect(reportExtensionArtifactWrite({ PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch } as never }, input)).resolves.toBeUndefined();
  });
});
