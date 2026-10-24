import { mintInternalToken } from "@naelao/http";
import type { Env } from "./index.js";
/** Purge encrypted profiles before removing the metadata needed to find their Durable Objects. */
export async function eraseWebsiteConnections(
  env: Env,
  tenantId: string,
  scope: { spaceId?: string; userId?: string; productSpaceId?: string }
): Promise<void> {
  const clauses = ["tenant_id=?"],
    values: string[] = [tenantId];
  if (scope.spaceId) {
    clauses.push("space_id=?");
    values.push(scope.spaceId);
  }
  if (scope.userId) {
    clauses.push("owner_user_id=?");
    values.push(scope.userId);
  }
  if (scope.productSpaceId) {
    clauses.push(
      "space_id IN (SELECT id FROM spaces WHERE id=? OR parent_space_id=?)"
    );
    values.push(scope.productSpaceId, scope.productSpaceId);
  }
  for (;;) {
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT id,space_id,owner_user_id,project_id,origins_json FROM website_connections WHERE ${clauses.join(" AND ")} LIMIT 100`
    )
      .bind(...values)
      .all<{
        id: string;
        space_id: string;
        owner_user_id: string;
        project_id: string | null;
        origins_json: string;
      }>();
    if (!results.length) return;
    if (!env.BROWSER_WORKER)
      throw new Error("Website profile erasure requires the browser service");
    for (const row of results) {
      await env.PLATFORM_DB.prepare(
        "UPDATE website_connections SET status='revoked' WHERE id=?"
      )
        .bind(row.id)
        .run();
      const response = await env.BROWSER_WORKER.fetch(
        new Request("http://browser/v1/website-profile/revoke", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": tenantId,
            "x-naelao-internal-token": await mintInternalToken(
              env.PLATFORM_SECRET,
              tenantId
            ),
          },
          body: JSON.stringify({
            tenantId,
            spaceId: row.space_id,
            actorId: row.owner_user_id,
            agentId: "website-login",
            runId: row.id,
            sessionId: row.id,
            connectionId: row.id,
            ...(row.project_id ? { projectId: row.project_id } : {}),
            expiresAt: Date.now() + 60000,
            maxTier: 5,
            authorizedOrigins: JSON.parse(row.origins_json),
            authorizedActions: [],
          }),
        })
      );
      if (!response.ok) throw new Error("Website profile erasure failed");
      await env.PLATFORM_DB.prepare(
        "DELETE FROM website_connections WHERE id=?"
      )
        .bind(row.id)
        .run();
    }
  }
}
