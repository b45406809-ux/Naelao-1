import { describe, expect, it, vi } from "vitest";
import { reportKnowledgeStorageWrite } from "./storage-usage.js";

describe("Knowledge storage usage reporting", () => {
  it("records scoped bytes without estimating an unsupported R2 price", async () => {
    let request: Request | undefined;
    const fetch = vi.fn(async (value: Request) => { request = value; return new Response(null, { status: 201 }); });
    await reportKnowledgeStorageWrite({ PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch } as never },
      "tenant-a", "space-a", "project-a", "doc-a", 1536, true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(request?.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
    expect(await request?.json()).toMatchObject({ schema_version: 2, event_type: "storage_bytes_written",
      quantity: 1536, unit: "bytes", space_id: "space-a", project_id: "project-a",
      payer_kind: "unknown", decision: "allowed", idempotency_key: "knowledge-storage:doc-a" });
  });

  it("does not report absent, invalid, or zero-byte storage writes", async () => {
    const fetch = vi.fn();
    const env = { PLATFORM_SECRET: "secret", BILLING_WORKER: { fetch } as never };
    await reportKnowledgeStorageWrite(env, "tenant-a", "space-a", null, "doc-a", 0, true);
    await reportKnowledgeStorageWrite(env, "tenant-a", "space-a", null, "doc-b", Number.NaN, false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
