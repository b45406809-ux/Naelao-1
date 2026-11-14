import { afterEach, expect, it, vi } from "vitest";
import { callSpaceSharedExtensionOperation } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("routes owner extension status recovery by request ID without changing the stored job-ID path", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ found: false }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "session-token", endUserId: "owner-a" };

  await callSpaceSharedExtensionOperation("space/a", session, "blueprint.status", {
    requestId: "d8d5f430-8d8a-4ea7-a33d-16ec59ce01a5",
  });
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost:8787/v1/spaces/space%2Fa/export-template?request_id=d8d5f430-8d8a-4ea7-a33d-16ec59ce01a5",
    expect.objectContaining({ cache: "no-store", headers: expect.any(Headers) }),
  );

  await callSpaceSharedExtensionOperation("space/a", session, "blueprint.status", { jobId: "job-a" });
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost:8787/v1/spaces/space%2Fa/export-template/job-a",
    expect.objectContaining({ headers: expect.any(Headers) }),
  );
  await expect(Promise.resolve().then(() => callSpaceSharedExtensionOperation("space/a", session, "blueprint.status", { requestId: "invalid" })))
    .rejects.toThrow("A valid conformance job or export request id is required");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
