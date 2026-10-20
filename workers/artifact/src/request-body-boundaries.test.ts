import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import artifactWorker from "./index.js";

describe("artifact request body bounds", () => {
  it("rejects oversized multipart input before calling R2", async () => {
    const put = vi.fn(async () => undefined);
    const secret = "artifact-request-boundary-secret";
    const request = new Request("https://artifact.test/spaces/space-a/artifacts", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=naelao-test",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
      duplex: "half",
    } as RequestInit);
    const response = await artifactWorker.fetch(
      request,
      {
        PLATFORM_SECRET: secret,
        ARTIFACT_BUCKET: { put } as never,
      } as never,
    );
    expect(response.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });
});
