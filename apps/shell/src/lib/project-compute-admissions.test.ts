import { afterEach, expect, it, vi } from "vitest";
import { cancelProjectComputeAdmission, listProjectComputeAdmissions, listProjectRuntimeBudgetReservations } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("uses authenticated no-store Project queue reads and sends cancellation by opaque execution ID", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
    init?.method === "POST" ? JSON.stringify({ cancelled: true, execution_id: "exec-a" })
      : JSON.stringify({ admissions: [{ execution_id: "exec-a", actor_id: "owner-a", status: "waiting_for_capacity",
        requested_at: 1, expires_at: 2, queue_position: 1 }], expired: [{ execution_id: "exec-old", actor_id: "member-a",
        status: "admission_expired", requested_at: 0, expired_at: 1 }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetchMock);
  const session = { sessionToken: "product-session", endUserId: "owner-a" };
  await expect(listProjectComputeAdmissions("space/a", "project b", session)).resolves.toMatchObject({
    admissions: [{ execution_id: "exec-a", status: "waiting_for_capacity", queue_position: 1 }],
    expired: [{ execution_id: "exec-old", status: "admission_expired" }],
  });
  expect(fetchMock).toHaveBeenLastCalledWith("http://localhost:8787/v1/spaces/space%2Fa/projects/project%20b/runtime/compute-admissions",
    expect.objectContaining({ cache: "no-store", headers: expect.any(Headers) }));

  await expect(cancelProjectComputeAdmission("space/a", "project b", "exec-a", session)).resolves.toEqual({ cancelled: true, execution_id: "exec-a" });
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  expect(url).toBe("http://localhost:8787/v1/spaces/space%2Fa/projects/project%20b/runtime/compute-admissions");
  expect(init).toEqual(expect.objectContaining({ method: "POST", cache: "no-store", headers: expect.any(Headers), body: JSON.stringify({ execution_id: "exec-a" }) }));
});

it("reads bounded runtime budget receipts without claiming invoice-backed provider cost", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    reservations: [{ reservationId: "container:receipt-a", status: "settled", reservedCredits: 300, chargedCredits: 120,
      createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:02:00.000Z", expiresAt: "2026-11-17T11:00:00.000Z" }],
    source: "workflow_budget_reservations_and_usage_events", costUnit: "internal_credits", providerInvoiceVerified: false,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(listProjectRuntimeBudgetReservations("space/a", "project b", { sessionToken: "product-session", endUserId: "owner-a" }))
    .resolves.toMatchObject({ reservations: [{ reservationId: "container:receipt-a", chargedCredits: 120 }], providerInvoiceVerified: false });
  expect(fetchMock).toHaveBeenCalledWith("http://localhost:8787/v1/spaces/space%2Fa/projects/project%20b/runtime-budget-reservations",
    expect.objectContaining({ cache: "no-store", headers: expect.any(Headers) }));
});
