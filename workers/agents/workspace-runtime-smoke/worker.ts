import { mintInternalToken } from "@naelao/http";
import { WorkspaceCoordinatorDO } from "../src/workspace/WorkspaceCoordinatorDO.js";

interface Env {
  PLATFORM_SECRET?: string;
  WORKSPACE_SMOKE_DISPOSABLE?: string;
  WORKSPACE_SMOKE_TOKEN?: string;
  WORKSPACE_SMOKE_RUN_ID?: string;
  SCRIPTS_R2: R2Bucket;
  WORKSPACE_COORDINATOR: DurableObjectNamespace<WorkspaceCoordinatorDO>;
}

export { WorkspaceCoordinatorDO };

function smokeIdentity(env: Env): { runId: string; token: string } | null {
  const runId = env.WORKSPACE_SMOKE_RUN_ID ?? "";
  const token = env.WORKSPACE_SMOKE_TOKEN ?? "";
  if (env.WORKSPACE_SMOKE_DISPOSABLE !== "true" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(runId) || token.length < 32 || !env.PLATFORM_SECRET) return null;
  return { runId, token };
}

function smokeScope(runId: string, instance: string) {
  const id = `workspace-smoke-${runId}-${instance}`;
  return { tenantId: id, spaceId: id, projectId: id, jurisdiction: "global" as const };
}

function tokenMatches(provided: string, expected: string): boolean {
  let diff = provided.length ^ expected.length;
  const length = Math.max(provided.length, expected.length);
  for (let index = 0; index < length; index++) diff |= (provided.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  return diff === 0;
}

function validLegacyPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.startsWith("/") &&
    !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const identity = smokeIdentity(env);
    if (!identity) return Response.json({ error: "disposable_smoke_binding_required" }, { status: 503 });
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tokenMatches(token, identity.token)) return Response.json({ error: "unauthorized" }, { status: 401 });

    const instance = request.headers.get("x-workspace-smoke-instance") ?? "runtime";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(instance)) return Response.json({ error: "invalid_smoke_instance" }, { status: 400 });
    const scope = smokeScope(identity.runId, instance);
    const url = new URL(request.url);
    if (url.pathname === "/__smoke/r2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const allowedContentPrefix = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/`;
      const allowedLegacyPrefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
      if (!prefix.startsWith(allowedContentPrefix) && !prefix.startsWith(allowedLegacyPrefix)) return Response.json({ error: "scope_outside_smoke_run" }, { status: 403 });
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return Response.json({ error: "invalid_limit" }, { status: 400 });
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
    if (url.pathname === "/__smoke/seed-legacy" && request.method === "POST") {
      const payload: { entries?: Array<{ branch?: string; path?: string; contentBase64?: string; contentType?: string; executable?: boolean; deleted?: boolean }> } = await request.json().catch(() => ({ entries: undefined }));
      const entries = payload.entries;
      if (!Array.isArray(entries) || entries.length > 100) return Response.json({ error: "invalid_entries" }, { status: 400 });
      const legacyPrefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
      for (const entry of entries) {
        const branch = entry.branch;
        if (branch !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch === "main" || branch.includes(".."))) return Response.json({ error: "invalid_branch" }, { status: 400 });
        if (!validLegacyPath(entry.path)) return Response.json({ error: "invalid_path" }, { status: 400 });
        const key = `${legacyPrefix}${branch === undefined ? "" : `branches/${branch}/`}${entry.path}`;
        if (entry.deleted === true) {
          await env.SCRIPTS_R2.put(key, "", { customMetadata: { deleted: "true" } });
          continue;
        }
        if (typeof entry.contentBase64 !== "string" || entry.contentBase64.length > 2_000_000) return Response.json({ error: "invalid_content" }, { status: 400 });
        const bytes = Uint8Array.from(atob(entry.contentBase64), (character) => character.charCodeAt(0));
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
        await env.SCRIPTS_R2.put(key, bytes, {
          customMetadata: { sha256: hash, executable: entry.executable === true ? "true" : "false" },
          httpMetadata: { contentType: entry.contentType ?? "application/octet-stream" },
        });
      }
      return Response.json({ seeded: entries.length });
    }
    if (url.pathname === "/__smoke/cleanup-legacy" && request.method === "POST") {
      const prefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
      let cursor: string | undefined;
      let deleted = 0;
      do {
        const page = await env.SCRIPTS_R2.list({ prefix, ...(cursor ? { cursor } : {}), limit: 100 });
        if (page.objects.length) {
          await env.SCRIPTS_R2.delete(page.objects.map((item) => item.key));
          deleted += page.objects.length;
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && !cursor) return Response.json({ error: "cleanup_cursor_missing" }, { status: 503 });
      } while (cursor);
      return Response.json({ deleted });
    }
    const stub = env.WORKSPACE_COORDINATOR.get(env.WORKSPACE_COORDINATOR.idFromName(`workspace-runtime-smoke-${identity.runId}-${instance}`));
    const headers = new Headers(request.headers);
    headers.set("x-naelao-tenant-id", scope.tenantId);
    headers.set("x-naelao-internal-token", await mintInternalToken(env.PLATFORM_SECRET!, scope.tenantId));
    if (request.method === "POST") headers.set("content-type", "application/json");
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return stub.fetch(new Request(`https://workspace-coordinator${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    }));
  },
};
