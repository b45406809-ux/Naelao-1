import { mintInternalToken } from "@naelao/http";
import type { Env } from "./index.js";
export async function eraseAssistantCommunications(
  env: Env,
  tenantId: string,
  spaceId: string,
  userId?: string,
  includeChildren = false
) {
  if (!env.AGENTS_WORKER) {
    const exists = await env.PLATFORM_DB.prepare(
      "SELECT id FROM assistant_communication_identities WHERE tenant_id=? AND space_id=? LIMIT 1"
    )
      .bind(tenantId, spaceId)
      .first();
    if (exists)
      throw new Error("Assistant communication erasure requires Agents Worker");
    return;
  }
  const response = await env.AGENTS_WORKER.fetch(
    new Request("http://agents/internal/assistant-communications/erase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(
          env.PLATFORM_SECRET,
          tenantId
        ),
      },
      body: JSON.stringify({ spaceId, userId, includeChildren }),
    })
  );
  if (!response.ok) throw new Error("Assistant communication erasure failed");
}
