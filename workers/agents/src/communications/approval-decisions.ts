import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
export async function coordinationHash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    ),
    (b) => b.toString(16).padStart(2, "0")
  ).join("");
}
type Approval = {
  id: string;
  run_id: string;
  session_id: string;
  tool_name: string;
  tool_input: string;
  expires_at: number;
  status: string;
  resume_do_id?: string | null;
};
function hitl(env: AgentsEnv, space: string) {
  return env.HITL_APPROVAL_DO.get(
    env.HITL_APPROVAL_DO.idFromName(`hitl:${space}`)
  );
}
function fingerprint(a: Approval) {
  return coordinationHash(
    JSON.stringify([
      a.id,
      a.run_id,
      a.session_id,
      a.tool_name,
      a.tool_input,
      a.expires_at,
    ])
  );
}
export async function issueApprovalDecisions(
  env: AgentsEnv,
  tenant: string,
  space: string,
  approvalId: string,
  contact: { user_id: string; channel: string; contact_id: string }
) {
  const response = await hitl(env, space).fetch(
    `http://hitl/requests/${encodeURIComponent(approvalId)}`
  );
  if (!response.ok) return { actions: [], summary: "" };
  const approval = await readBoundedResponseJson<Approval>(response, 131072);
  if (approval.status !== "pending" || approval.expires_at <= Date.now())
    return { actions: [], summary: "" };
  // A button cannot authorize details hidden by the provider's message truncation.
  if (approval.tool_input.length > 600)
    return {
      actions: [],
      summary: "The full parameters require review in Naelao.",
    };
  const summary = `Action: ${approval.tool_name.slice(0, 80)}\nParameters: ${approval.tool_input}`;
  const actions = [];
  for (const decision of ["approve", "reject"] as const) {
    const token =
      "ad_" +
      Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
    await env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_approval_decisions(token_hash,tenant_id,space_id,approval_id,request_hash,user_id,channel,contact,decision,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        await coordinationHash(token),
        tenant,
        space,
        approvalId,
        await fingerprint(approval),
        contact.user_id,
        contact.channel,
        contact.contact_id,
        decision,
        Math.min(approval.expires_at, Date.now() + 600000)
      )
      .run();
    actions.push({
      id: token,
      label: decision === "approve" ? "Approve" : "Deny",
    });
  }
  return { actions, summary };
}
/** Called only after provider signature verification. Token possession alone is insufficient. */
export async function applyApprovalDecision(
  env: AgentsEnv,
  input: {
    tenantId: string;
    spaceId: string;
    channel: string;
    contact: string;
    token: string;
  },
  waitUntil: (promise: Promise<unknown>) => void
) {
  if (!/^ad_[a-f0-9]{48}$/.test(input.token)) return { handled: false };
  const row = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_approval_decisions WHERE token_hash=? AND tenant_id=? AND space_id=? AND channel=?"
  )
    .bind(
      await coordinationHash(input.token),
      input.tenantId,
      input.spaceId,
      input.channel
    )
    .first<{
      token_hash: string;
      approval_id: string;
      request_hash: string;
      user_id: string;
      contact: string;
      decision: string;
      status: string;
      expires_at: number;
    }>();
  if (
    !row ||
    row.contact.replace(/^\+/, "") !== input.contact.replace(/^\+/, "") ||
    row.expires_at <= Date.now()
  )
    return { handled: true, applied: false };
  const headers = {
    "content-type": "application/json",
    "x-naelao-tenant-id": input.tenantId,
    "x-naelao-internal-token": await mintInternalToken(
      env.PLATFORM_SECRET,
      input.tenantId
    ),
  };
  const active = await env.PLATFORM_DB.prepare(
    "SELECT s.id FROM spaces s JOIN orgs o ON o.id=s.tenant_id WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'"
  )
    .bind(input.spaceId, input.tenantId)
    .first();
  if (!active) return { handled: true, applied: false };
  const verified = await env.SPACES_WORKER.fetch(
    new Request(
      `http://spaces/internal/spaces/${encodeURIComponent(input.spaceId)}/executive/verify`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          space_id: input.spaceId,
          channel: input.channel,
          contact_id: input.contact,
        }),
      }
    )
  );
  const member = verified.ok
    ? await readBoundedResponseJson<{
        verified?: boolean;
        member?: { user_id: string; role: string };
      }>(verified, 4096)
    : null;
  if (
    !member?.verified ||
    member.member?.user_id !== row.user_id ||
    !["owner", "admin"].includes(member.member.role)
  )
    return { handled: true, applied: false };
  const stub = hitl(env, input.spaceId),
    response = await stub.fetch(`http://hitl/requests/${row.approval_id}`);
  if (!response.ok) return { handled: true, applied: false };
  const approval = await readBoundedResponseJson<Approval>(response, 131072);
  if ((await fingerprint(approval)) !== row.request_hash)
    return { handled: true, applied: false };
  if (row.status === "applied")
    return { handled: true, applied: true, decision: row.decision };
  const claimed = await env.PLATFORM_DB.prepare(
    "UPDATE assistant_approval_decisions SET status='applying' WHERE token_hash=? AND status='issued' AND expires_at>?"
  )
    .bind(row.token_hash, Date.now())
    .run();
  if (claimed.meta.changes !== 1) return { handled: true, applied: false };
  try {
    const result = await stub.fetch(
      `http://hitl/requests/${row.approval_id}/${row.decision}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Decision by verified approver" }),
      }
    );
    if (!result.ok) throw new Error("approval_decision_rejected");
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_approval_decisions SET status='applied' WHERE token_hash=? AND status='applying'"
    )
      .bind(row.token_hash)
      .run();
    if (row.decision === "approve" && approval.resume_do_id)
      waitUntil(
        env.NAELAO_AGENT_DO.get(
          env.NAELAO_AGENT_DO.idFromString(approval.resume_do_id)
        )
          .fetch(
            new Request("http://agent/script/resume", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ approvalId: row.approval_id }),
            })
          )
          .then(() => undefined)
      );
    return { handled: true, applied: true, decision: row.decision };
  } catch {
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_approval_decisions SET status='held' WHERE token_hash=? AND status='applying'"
    )
      .bind(row.token_hash)
      .run();
    return { handled: true, applied: false };
  }
}
