import { describe, expect, it } from "vitest";
import { admitAutonomousWake } from "./autonomous-wake-admission.js";

describe("autonomous wake admission", () => {
  it("allows dispatch only when the active-run endpoint confirms idle", async () => {
    await expect(admitAutonomousWake(Response.json({ active: false }))).resolves.toEqual({ allowed: true });
  });

  it("reports an active run as a retryable conflict", async () => {
    await expect(admitAutonomousWake(Response.json({ active: true, run_id: "run-1" }))).resolves.toEqual({
      allowed: false, status: 409, errorCode: "assistant_busy", activeRunId: "run-1",
    });
  });

  it.each([
    [null, "missing response"],
    [new Response(null, { status: 503 }), "unavailable endpoint"],
    [new Response("not-json", { status: 200 }), "malformed response"],
    [Response.json({}), "missing active status"],
  ] as const)("fails closed when status is not trustworthy (%s)", async (response) => {
    await expect(admitAutonomousWake(response)).resolves.toEqual({
      allowed: false, status: 503, errorCode: "active_run_status_unavailable",
    });
  });
});
