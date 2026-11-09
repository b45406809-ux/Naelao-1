import { mintInternalToken } from "@naelao/http";
import { getDOName } from "@naelao/crypto";
import { RepositoryDO } from "../../artifact/src/RepositoryDO.js";
import { repositoryName, type RepositoryScope } from "../../artifact/src/repository.js";
import { ConcurrencyDO } from "../src/do/ConcurrencyDO.js";
import { ToolSandboxDO } from "../src/do/ToolSandboxDO.js";
import { WorkspaceCoordinatorDO } from "../src/workspace/WorkspaceCoordinatorDO.js";

interface Env {
  PLATFORM_SECRET?: string;
  WORKSPACE_SMOKE_DISPOSABLE?: string;
  WORKSPACE_SMOKE_TOKEN?: string;
  WORKSPACE_SMOKE_RUN_ID?: string;
  UNIFIED_WORKSPACE_ENABLED?: string;
  WORKSPACE_DUAL_READ_ENABLED?: string;
  SCRIPTS_R2: R2Bucket;
  REPOSITORY_OBJECTS: R2Bucket;
  WORKSPACE_R2: R2Bucket;
  WORKSPACE_COORDINATOR: DurableObjectNamespace<WorkspaceCoordinatorDO>;
  REPOSITORY_DO: DurableObjectNamespace<RepositoryDO>;
  REPOSITORY_JOURNAL_DO: DurableObjectNamespace<WorkspaceSmokeJournalRepositoryDO>;
  TOOL_SANDBOX: DurableObjectNamespace<WorkspaceSmokeToolSandboxDO>;
  CONCURRENCY_DO: DurableObjectNamespace<ConcurrencyDO>;
}

export { WorkspaceCoordinatorDO, RepositoryDO, ConcurrencyDO };

type JournalSmokeEnv = {
  REPOSITORY_OBJECTS: R2Bucket;
  WORKSPACE_R2: R2Bucket;
  WORKSPACE_COORDINATOR: DurableObjectNamespace<WorkspaceCoordinatorDO>;
  CONCURRENCY_DO: DurableObjectNamespace<ConcurrencyDO>;
  PLATFORM_SECRET: string;
  UNIFIED_WORKSPACE_ENABLED?: string;
  WORKSPACE_DUAL_READ_ENABLED?: string;
  DATA_JURISDICTION?: "eu";
};

/** This disposable-only DO wraps real R2 and loses one successful legacy PUT response. */
export class WorkspaceSmokeJournalRepositoryDO extends RepositoryDO {
  private readonly smokeStorage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: JournalSmokeEnv) {
    const bucket = env.WORKSPACE_R2;
    const injectedBucket = new Proxy(bucket, {
      get(target, property, receiver) {
        if (property === "put") {
          const originalPut = target.put.bind(target);
          return async (...args: Parameters<R2Bucket["put"]>) => {
            const key = String(args[0]);
            const result = await originalPut(...args);
            if (key.startsWith("spaces/") && key.includes("/workspace/") && await ctx.storage.get<boolean>("smoke_lose_put_response") === true) {
              await ctx.storage.put("smoke_lose_put_response", false);
              throw new Error("smoke_lost_workspace_put_response");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, WORKSPACE_R2: injectedBucket, UNIFIED_WORKSPACE_ENABLED: "false" } as never);
    this.smokeStorage = ctx.storage;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__smoke/arm-lost-put") {
      await this.smokeStorage.put("smoke_lose_put_response", true);
      return Response.json({ armed: true });
    }
    if (path === "/__smoke/journal-status") return Response.json({ pending: Boolean(await this.smokeStorage.get("workspace_publication")) });
    return super.fetch(request);
  }
}

/** Smoke-only free metering profile; the attached container and ToolSandbox lifecycle are real. */
export class WorkspaceSmokeToolSandboxDO extends ToolSandboxDO {
  private readonly smokeStorage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env as never);
    this.smokeStorage = ctx.storage;
  }

  protected override allocationCreditsPerHour(): number { return 0; }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__smoke/status") return Response.json({
      status: await this.smokeStorage.get("container_status") ?? "unknown",
      running: this.container?.running ?? false,
    });
    if (path === "/__smoke/stop") {
      await this.stopContainer();
      return Response.json({ status: await this.smokeStorage.get("container_status"), running: this.container?.running ?? false });
    }
    return super.fetch(request);
  }
}

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
      return Response.json({ keys: page.objects.map((item) => item.key), truncated: page.truncated, cursor: "cursor" in page ? page.cursor ?? null : null });
    }
    if (url.pathname === "/__smoke/seed-content" && request.method === "POST") {
      const prefix = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/`;
      const count = Number((await request.json<{ count?: number }>().catch((): { count?: number } => ({}))).count ?? 0);
      if (!Number.isSafeInteger(count) || count < 1 || count > 500) return Response.json({ error: "invalid_count" }, { status: 400 });
      for (let index = 0; index < count; index++) {
        const hash = index.toString(16).padStart(64, "0");
        await env.SCRIPTS_R2.put(`${prefix}${hash}`, `orphan-${index}`);
      }
      return Response.json({ seeded: count });
    }
    if (url.pathname === "/__smoke/seed-legacy" && request.method === "POST") {
      const payload = await request.json<{ entries?: Array<{ branch?: string; path?: string; contentBase64?: string; contentType?: string; executable?: boolean; deleted?: boolean }> }>().catch((): { entries?: Array<{ branch?: string; path?: string; contentBase64?: string; contentType?: string; executable?: boolean; deleted?: boolean }> } => ({}));
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
    if (url.pathname.startsWith("/__smoke/toolsandbox/")) {
      const operation = url.pathname.slice("/__smoke/toolsandbox/".length);
      if (!["prewarm", "shell", "lifecycle", "status", "stop"].includes(operation)) return Response.json({ error: "unsupported_toolsandbox_smoke_operation" }, { status: 404 });
      const stub = env.TOOL_SANDBOX.get(env.TOOL_SANDBOX.idFromName(`${scope.tenantId}:${scope.spaceId}:${scope.projectId}`));
      const executionId = url.searchParams.get("executionId") ?? crypto.randomUUID();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(executionId)) return Response.json({ error: "invalid_smoke_execution_id" }, { status: 400 });
      const containerScope = {
        tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: scope.projectId,
        actorId: "workspace-smoke-actor", agentId: "workspace-smoke-agent", runId: `workspace-smoke-${identity.runId}`,
        executionId, deadline: Date.now() + 60_000, timeoutMs: 60_000,
      };
      const headers = new Headers({ "x-naelao-container-scope": JSON.stringify(containerScope), "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET!, scope.tenantId) });
      const statusOnly = operation === "status" || operation === "stop";
      if (!statusOnly) headers.set("content-type", "application/json");
      const body = statusOnly || !request.body ? undefined : await request.arrayBuffer();
      const target = operation === "status" ? "/__smoke/status" : operation === "stop" ? "/__smoke/stop" : `/${operation}`;
      return stub.fetch(new Request(`https://tool-sandbox.internal${target}`, {
        method: statusOnly ? "GET" : "POST", headers, ...(body === undefined ? {} : { body }),
      }));
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
    if (url.pathname === "/__smoke/cleanup-repository" && request.method === "POST") {
      const prefix = `repositories/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/`;
      let cursor: string | undefined;
      let deleted = 0;
      do {
        const page = await env.REPOSITORY_OBJECTS.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
        if (page.objects.length) {
          await env.REPOSITORY_OBJECTS.delete(page.objects.map((item) => item.key));
          deleted += page.objects.length;
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && !cursor) return Response.json({ error: "cleanup_cursor_missing" }, { status: 503 });
      } while (cursor);
      return Response.json({ deleted });
    }
    if (url.pathname.startsWith("/__smoke/git/") || url.pathname.startsWith("/__smoke/git-journal/")) {
      const journal = url.pathname.startsWith("/__smoke/git-journal/");
      const prefix = journal ? "/__smoke/git-journal/" : "/__smoke/git/";
      const operation = url.pathname.slice(prefix.length);
      const repoScope: RepositoryScope = { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: scope.projectId };
      const namespace = journal ? env.REPOSITORY_JOURNAL_DO : env.REPOSITORY_DO;
      const stub = namespace.get(namespace.idFromName(repositoryName(repoScope)));
      const headers = new Headers({ "x-repository-scope": JSON.stringify(repoScope) });
      if (request.method !== "GET" && request.method !== "HEAD") headers.set("content-type", "application/json");
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      return stub.fetch(new Request(`https://repository.internal/${operation}${url.search}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      }));
    }
    const coordinatorName = await getDOName("workspace", `${scope.spaceId}:${scope.projectId}`, scope.tenantId, env.PLATFORM_SECRET!);
    const stub = env.WORKSPACE_COORDINATOR.get(env.WORKSPACE_COORDINATOR.idFromName(coordinatorName));
    const headers = new Headers(request.headers);
    headers.set("x-naelao-tenant-id", scope.tenantId);
    headers.set("x-naelao-internal-token", await mintInternalToken(env.PLATFORM_SECRET!, scope.tenantId));
    if (request.method === "POST") headers.set("content-type", "application/json");
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await stub.fetch(new Request(`https://workspace-coordinator${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    }));
    if (url.pathname === "/v1/migration/retire-alias" && request.headers.get("x-workspace-smoke-drop-first-alias-response") === "true" && (response.status === 200 || response.status === 202)) {
      const marker = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/smoke-control/alias-response-dropped`;
      const created = await env.SCRIPTS_R2.put(marker, "1", { onlyIf: { etagDoesNotMatch: "*" } });
      if (created) return Response.json({ error: "simulated_lost_cleanup_response" }, { status: 503 });
    }
    return response;
  },
};
