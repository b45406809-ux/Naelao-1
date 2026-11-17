import { afterEach, expect, it, vi } from "vitest";
import { cancelProjectComputeAdmission, listProjectComputeAdmissions } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("uses authenticated no-store Project queue reads and sends cancellation by opaque execution ID", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
    init?.method === "POST" ? JSON.stringify({ cancelled: true, execution_id: "exec-a" })
      : JSON.stringify({ admissions: [{ execution_id: "exec-a", actor_id: "owner-a", status: "waiting_for_capacity",
        requested_at: 1, expires_at: 2, queue_position: 1 }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "product-session", endUserId: "owner-a" };
  await expect(listProjectComputeAdmissions("space/a", "project b", session)).resolves.toMatchObject({
    admissions: [{ execution_id: "exec-a", status: "waiting_for_capacity", queue_position: 1 }],
  });
  expect(fetchMock).toHaveBeenLastCalledWith("http://localhost:8787/v1/spaces/space%2Fa/projects/project%20b/runtime/compute-admissions",
    expect.objectContaining({ cache: "no-store", headers: expect.any(Headers) }));

  await expect(cancelProjectComputeAdmission("space/a", "project b", "exec-a", session)).resolves.toEqual({ cancelled: true, execution_id: "exec-a" });
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  expect(url).toBe("http://localhost:8787/v1/spaces/space%2Fa/projects/project%20b/runtime/compute-admissions");
  expect(init).toEqual(expect.objectContaining({ method: "POST", cache: "no-store", headers: expect.any(Headers), body: JSON.stringify({ execution_id: "exec-a" }) }));
});
