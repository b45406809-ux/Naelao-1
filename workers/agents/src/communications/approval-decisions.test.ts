import { describe, it, expect, vi } from "vitest";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";
import {
  issueApprovalDecisions,
  applyApprovalDecision,
} from "./approval-decisions.js";
async function setup() {
  const f = fixture();
  const approval = {
    id: "approval",
    run_id: "task",
    session_id: "session",
    tool_name: "book",
    tool_input: '{"amount":500}',
    expires_at: Date.now() + 600000,
    status: "pending",
    resume_do_id: "parent",
  };
  const hitl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(input, init);
    if (r.method === "PUT") {
      if (approval.status !== "pending")
        return new Response(null, { status: 409 });
      approval.status = r.url.endsWith("/approve") ? "approved" : "rejected";
      return Response.json({ status: approval.status });
    }
    return Response.json(approval);
  });
  const resume = vi.fn(async () => Response.json({ resumed: true }));
  Object.assign(f.env, {
    HITL_APPROVAL_DO: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: hitl }),
    },
    NAELAO_AGENT_DO: {
      idFromString: (id: string) => id,
      get: () => ({ fetch: resume }),
    },
  });
  f.fetch.mockImplementation(async () =>
    Response.json({
      verified: true,
      member: { user_id: "user", role: "owner" },
    })
  );
  const issued = await issueApprovalDecisions(
    f.env,
    "tenant",
    "space",
    "approval",
    { user_id: "user", channel: "whatsapp", contact_id: "123" }
  );
  const waits: Promise<unknown>[] = [];
  const apply = (token: string, extra = {}) =>
    applyApprovalDecision(
      f.env,
      {
        tenantId: "tenant",
        spaceId: "space",
        channel: "whatsapp",
        contact: "123",
        token,
        ...extra,
      },
      (p) => waits.push(p)
    );
  return { ...f, approval, hitl, resume, issued, apply, waits };
}
describe("verified recipient-bound mid-call approvals", () => {
  it("pins the displayed parameters and applies 100 concurrent button retries only once", async () => {
    const f = await setup();
    expect(f.issued.summary).toContain('"amount":500');
    await Promise.all(
      Array.from({ length: 100 }, () => f.apply(f.issued.actions[0]!.id))
    );
    await Promise.all(f.waits);
    expect(
      f.hitl.mock.calls.filter(([input, init]) =>
        input instanceof Request
          ? input.method === "PUT"
          : init?.method === "PUT"
      )
    ).toHaveLength(1);
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(f.approval.status).toBe("approved");
    expect(await f.apply(f.issued.actions[1]!.id)).toMatchObject({
      applied: false,
    });
  });
  it("rejects forwarded tokens, other tenants and revoked approvers", async () => {
    const f = await setup(),
      token = f.issued.actions[0]!.id;
    expect(await f.apply(token, { contact: "attacker" })).toMatchObject({
      applied: false,
    });
    expect(await f.apply(token, { tenantId: "other" })).toMatchObject({
      applied: false,
    });
    f.fetch.mockImplementation(async () =>
      Response.json({
        verified: true,
        member: { user_id: "other", role: "owner" },
      })
    );
    expect(await f.apply(token)).toMatchObject({ applied: false });
    expect(f.resume).not.toHaveBeenCalled();
  });
  it("rejects a changed action and expired token instead of approving a replacement", async () => {
    const f = await setup(),
      token = f.issued.actions[0]!.id;
    f.approval.tool_input = '{"amount":5000}';
    expect(await f.apply(token)).toMatchObject({ applied: false });
    await f.db
      .prepare("UPDATE assistant_approval_decisions SET expires_at=0")
      .run();
    expect(await f.apply(token)).toMatchObject({ applied: false });
    expect(f.approval.status).toBe("pending");
  });
  it("requires full app review when parameters do not fit in an approval message", async () => {
    const f = await setup();
    f.approval.tool_input = "x".repeat(601);
    expect(
      (
        await issueApprovalDecisions(f.env, "tenant", "space", "approval", {
          user_id: "user",
          channel: "whatsapp",
          contact_id: "123",
        })
      ).actions
    ).toEqual([]);
  });
});
