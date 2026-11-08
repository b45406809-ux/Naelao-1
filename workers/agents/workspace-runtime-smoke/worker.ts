import { mintInternalToken } from "@naelao/http";
import { WorkspaceCoordinatorDO } from "../src/workspace/WorkspaceCoordinatorDO.js";

interface Env {
  PLATFORM_SECRET: string;
  SCRIPTS_R2: R2Bucket;
  WORKSPACE_COORDINATOR: DurableObjectNamespace<WorkspaceCoordinatorDO>;
}

export { WorkspaceCoordinatorDO };

const scope = { tenantId: "runtime-tenant", spaceId: "runtime-space", projectId: "runtime-project", jurisdiction: "global" as const };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__smoke/r2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      const page = await env.SCRIPTS_R2.list({ prefix, ...(cursor ? { cursor } : {}), limit });
      return Response.json({ keys: page.objects.map((item) => item.key), truncated: page.truncated, cursor: page.cursor ?? null });
    }
    if (url.pathname === "/__smoke/seed-content" && request.method === "POST") {
      const prefix = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/`;
      const count = Number((await request.json<{ count?: number }>().catch(() => ({}))).count ?? 0);
      if (!Number.isSafeInteger(count) || count < 1 || count > 500) return Response.json({ error: "invalid_count" }, { status: 400 });
      for (let index = 0; index < count; index++) {
        const hash = index.toString(16).padStart(64, "0");
        await env.SCRIPTS_R2.put(`${prefix}${hash}`, `orphan-${index}`);
      }
      return Response.json({ seeded: count });
    }
    const stub = env.WORKSPACE_COORDINATOR.get(env.WORKSPACE_COORDINATOR.idFromName("phase1-runtime-smoke"));
    const headers = new Headers(request.headers);
    headers.set("x-naelao-tenant-id", scope.tenantId);
    headers.set("x-naelao-internal-token", await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId));
    if (request.method === "POST") headers.set("content-type", "application/json");
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return stub.fetch(new Request(`https://workspace-coordinator${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    }));
  },
};
