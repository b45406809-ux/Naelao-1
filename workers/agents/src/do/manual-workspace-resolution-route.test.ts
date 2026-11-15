import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceManualResolutionInput, WorkspaceManualValidationReceipt, WorkspaceManualValidationRequest } from "../workspace/workspace-manual-resolution.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

const routeMocks = vi.hoisted(() => ({
  scopeAccess: vi.fn(),
  publish: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("../communications/core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../communications/core.js")>()),
  scopeAccess: routeMocks.scopeAccess,
}));

vi.mock("../workspace/workspace-manual-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspace/workspace-manual-resolution.js")>()),
  publishWorkspaceManualResolution: routeMocks.publish,
  readWorkspaceConflictPreview: routeMocks.preview,
}));

const tenantId = "tenant-route";
const spaceId = "space-route";
const projectId = "project-route";
const actorId = "reviewer-route";
const workerId = "worker-route";
const sessionId = "session-route";
const targetBranch = "main";
const path = "src/example.ts";
const targetHash = "a".repeat(64);
const sourceHash = "b".repeat(64);
const targetManifestHash = "c".repeat(64);
const reviewManifestHash = "d".repeat(64);
const secret = "manual-resolution-route-secret";
const scope = { tenantId, spaceId, projectId, jurisdiction: "global" as const };

const digest = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

async function validationRequest(input: WorkspaceManualResolutionInput): Promise<WorkspaceManualValidationRequest> {
  const paths = (input.changes ?? [{ path: input.path }]).map(change => change.path)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const pathIdentity = paths.length === 1 ? paths[0]! : paths;
  const operationDigest = await digest(JSON.stringify([input.scope, input.workerId, input.attempt, input.targetBranch, pathIdentity, input.idempotencyKey]));
  const operationId = operationDigest.slice(0, 48);
  const commandHash = await digest(input.validationCommand!);
  const executionDigest = await digest(JSON.stringify([input.scope, input.workerId, input.attempt, input.targetBranch, pathIdentity, input.idempotencyKey, commandHash]));
  return {
    path: input.path,
    paths,
    reviewBranch: `manual/${operationId}`,
    validationBranch: `race/manual-validation/${operationId}`,
    targetBranch: input.targetBranch,
    revision: 3,
    manifestHash: reviewManifestHash,
    targetRevision: 2,
    targetManifestHash,
    command: input.validationCommand!,
    commandHash,
    executionId: `manual-validation-${executionDigest.slice(0, 40)}`,
    runId: `manual-validation-run-${executionDigest.slice(0, 32)}`,
  };
}

function workspaceBinding() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/branch") return Response.json({ ok: true });
        if (url.pathname === "/v1/head") {
          const branch = url.searchParams.get("branch") ?? "";
          if (branch === targetBranch) return Response.json({ head: { branch, revision: 2, manifestHash: targetManifestHash } });
          if (branch.startsWith("manual/")) return Response.json({ head: { branch, revision: 3, manifestHash: reviewManifestHash },
            branchBase: { parentBranch: targetBranch, revision: 2, manifestHash: targetManifestHash } });
          if (branch.startsWith("race/manual-validation/")) return Response.json({ head: { branch, revision: 3, manifestHash: reviewManifestHash },
            branchBase: { parentBranch: `manual/${branch.slice("race/manual-validation/".length)}`, revision: 3, manifestHash: reviewManifestHash } });
          return Response.json({ error_code: "branch_not_found" }, { status: 404 });
        }
        return Response.json({ error_code: "unexpected_workspace_route", path: url.pathname }, { status: 500 });
      },
    }),
  };
}

function createAgent(options: { execution: "uncertain" | "passed"; loseFirstResultWrite?: boolean; pairedRename?: boolean; unpairedDeleteEdit?: boolean; invalidReportedPair?: boolean } = { execution: "uncertain" }) {
  const result = {
    workspaceMerge: {
      status: "unapplied",
      conflicts: [{ path, ...(options.invalidReportedPair ? { otherPath: "../src/moved.ts" } : {}), ...(options.pairedRename ? { otherPath: "src/moved.ts", reason: "rename_edit_candidate", targetHash: null }
        : options.unpairedDeleteEdit ? { reason: "delete_edit_or_path_collision", targetHash: null } : { reason: "overlapping_change", targetHash }), sourceHash }],
      manualResolutions: [],
      validationReceipts: [],
      omitted: 0,
    },
  };
  let serializedResult = JSON.stringify(result);
  let failNextPublishedWrite = options.loseFirstResultWrite === true;
  let canonicalPublicationCount = 0;
  const values = new Map<string, unknown>([[`worker-branch-parent:${workerId}`, targetBranch]]);
  const workerRow = () => ({ status: "done", result: serializedResult, workspace_branch: "workers/attempt-1", attempt: 1,
    configuration_json: JSON.stringify({ tenantId, spaceId, projectId, agentId: "agent-route" }), parent_run_id: "parent-run" });
  const storage = {
    async get<T>(key: string): Promise<T | undefined> { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown): Promise<void> { values.set(key, structuredClone(value)); },
    async transaction<T>(callback: (tx: { get<K>(key: string): Promise<K | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>): Promise<T> {
      return callback({ get: async <K>(key: string) => values.get(key) as K | undefined,
        put: async (key, value) => { values.set(key, structuredClone(value)); } });
    },
    sql: {
      exec(query: string, ...args: unknown[]) {
        if (query.startsWith("UPDATE sub_agents SET result=?,updated_at=? WHERE id=?")) {
          if (failNextPublishedWrite && canonicalPublicationCount > 0) {
            failNextPublishedWrite = false;
            throw new Error("simulated lost result write after canonical publication");
          }
          serializedResult = String(args[0]);
          return { toArray: () => [{ changes: 1 }] };
        }
        return {
          toArray() {
            if (query.includes("SELECT status,result,workspace_branch,attempt,configuration_json,parent_run_id FROM sub_agents")) return [workerRow()];
            if (query.includes("SELECT status,result,workspace_branch,configuration_json FROM sub_agents")) {
              const row = workerRow();
              return [{ status: row.status, result: row.result, workspace_branch: row.workspace_branch, configuration_json: row.configuration_json }];
            }
            if (query.includes("SELECT result,status,workspace_branch,configuration_json FROM sub_agents")) {
              const row = workerRow();
              return [{ result: row.result, status: row.status, workspace_branch: row.workspace_branch, configuration_json: row.configuration_json }];
            }
            throw new Error(`unexpected route test SQL: ${query}`);
          },
        };
      },
    },
  };
  const execution = vi.fn(async () => {
    if (options.execution === "uncertain") throw new Error("may_require_reconciliation");
    return { ok: true, output: { exit_code: 0 }, duration_ms: 17 };
  });
  const bucket = { async get() { return null; } };
  const env = { PLATFORM_SECRET: secret, UNIFIED_WORKSPACE_ENABLED: "true", WORKSPACE_COORDINATOR: workspaceBinding(), SCRIPTS_R2: bucket };
  const instance = new NaelaoAgentDO({ storage, id: { toString: () => "agent-route-test" } } as never, env as never);
  (instance as unknown as { ensureInit(): void }).ensureInit = () => {};
  (instance as unknown as { enforceRunGates: () => Promise<unknown> }).enforceRunGates = async () => ({ ok: true, hasSpendCap: false, effectiveRole: "owner", maxTier: 6 });
  (instance as unknown as { buildScriptEngineEnv: () => Promise<unknown> }).buildScriptEngineEnv = async () => ({ spaceId,
    scriptsBucket: bucket, nativeExecutionAllowed: true, maxTier: 6, codeRunner: { run: execution } });
  return { instance, values, execution, getResult: () => JSON.parse(serializedResult) as typeof result, getCanonicalPublicationCount: () => canonicalPublicationCount,
    noteCanonicalPublication: () => { canonicalPublicationCount++; } };
}

function request(overrides: Record<string, unknown> = {}) {
  return new Request("http://agent/internal/sub-agents/resolve-conflict", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId },
    body: JSON.stringify({ scope, actorId, callerRole: "owner", sessionId, workerId, path, expectedTargetHash: targetHash,
      expectedSourceHash: sourceHash, content: "reviewed content\n", idempotencyKey: "manual-route-1", validationCommand: "pnpm test", ...overrides }),
  });
}

describe("manual workspace conflict route", () => {
  function configurePublish(agent: ReturnType<typeof createAgent>) {
    const completed = new Map<string, { reviewBranch: string; paths: string[]; validation: WorkspaceManualValidationReceipt;
      checkpoint: { id: string }; merge: { id: string; status: "published"; revision: number } }>();
    routeMocks.publish.mockImplementation(async (input: WorkspaceManualResolutionInput) => {
      const key = `${input.workerId}:${input.idempotencyKey}`;
      const validation = await input.validate!(await validationRequest(input));
      if (validation.status !== "passed") throw new Error(`workspace_manual_validation_${validation.status}`);
      const prior = completed.get(key);
      if (prior) return prior;
      agent.noteCanonicalPublication();
      const published = { reviewBranch: `manual/${(await validationRequest(input)).validationBranch.slice("race/manual-validation/".length)}`,
        paths: validation.paths, validation, checkpoint: { id: "checkpoint-route" },
        merge: { id: "merge-route", status: "published" as const, revision: 4 } };
      completed.set(key, published);
      return published;
    });
  }

  function setupMocks(scopeAccess: (...args: unknown[]) => Promise<boolean>) {
    routeMocks.scopeAccess.mockReset().mockImplementation(scopeAccess);
    routeMocks.preview.mockReset().mockResolvedValue({ path, stale: false,
      target: { hash: targetHash, content: "target content\n" }, worker: { hash: sourceHash, content: "worker content\n" } });
    routeMocks.publish.mockReset();
  }

  async function invoke(instance: NaelaoAgentDO, overrides: Record<string, unknown> = {}) {
    const input = request(overrides);
    input.headers.set("x-naelao-internal-token", await mintInternalToken(secret, tenantId));
    return instance.fetch(input);
  }

  async function invokePreview(instance: NaelaoAgentDO, overrides: Record<string, unknown> = {}) {
    return instance.fetch(new Request("http://agent/internal/sub-agents/conflict-preview", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(secret, tenantId) },
      body: JSON.stringify({ scope, actorId, callerRole: "owner", workerId, path, ...overrides }),
    }));
  }

  it("records access revocation during validation and does not run or publish", async () => {
    setupMocks(vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false));
    const agent = createAgent({ execution: "passed" });
    configurePublish(agent);
    const response = await invoke(agent.instance);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "workspace_manual_validation_blocked", validation: { status: "blocked", reason: "project_access_revoked" } });
    expect(agent.execution).not.toHaveBeenCalled();
    expect(agent.getCanonicalPublicationCount()).toBe(0);
    expect(agent.getResult().workspaceMerge.validationReceipts).toMatchObject([{ status: "blocked", reason: "project_access_revoked", path }]);
  });

  it("persists uncertain execution and fails closed before canonical publication", async () => {
    setupMocks(async () => true);
    const agent = createAgent({ execution: "uncertain" });
    configurePublish(agent);
    const response = await invoke(agent.instance);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "workspace_manual_validation_uncertain", validation: { status: "uncertain", reason: "native_execution_outcome_uncertain" } });
    expect(agent.execution).toHaveBeenCalledTimes(1);
    expect(agent.getCanonicalPublicationCount()).toBe(0);
    expect(agent.getResult().workspaceMerge.validationReceipts).toMatchObject([{ status: "uncertain", path }]);
  });

  it("replays a passed receipt after losing the result write following publication", async () => {
    setupMocks(async () => true);
    const agent = createAgent({ execution: "passed", loseFirstResultWrite: true });
    configurePublish(agent);
    await expect(invoke(agent.instance)).rejects.toThrow("simulated lost result write after canonical publication");
    expect(agent.getCanonicalPublicationCount()).toBe(1);
    expect(agent.getResult().workspaceMerge.manualResolutions).toHaveLength(0);

    const retry = await invoke(agent.instance);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ resolution: { path, paths: [path], status: "published", validation: { status: "passed" } } });
    expect(agent.execution).toHaveBeenCalledTimes(1);
    expect(agent.getCanonicalPublicationCount()).toBe(1);
    expect(agent.getResult().workspaceMerge.manualResolutions).toHaveLength(1);
  });

  it("accepts a bounded binary side choice without returning binary data to the caller", async () => {
    setupMocks(async () => true);
    routeMocks.preview.mockResolvedValue({ path, stale: false,
      target: { hash: targetHash, content: "target content\n" },
      worker: { hash: sourceHash, content: null, unavailableReason: "invalid_text", copyAllowed: true } });
    const agent = createAgent({ execution: "passed" });
    configurePublish(agent);
    const response = await invoke(agent.instance, { content: null, copyFrom: "worker" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ resolution: { path, status: "published", copiedVersions: [{ path, from: "worker", hash: sourceHash }] } });
    expect(routeMocks.publish).toHaveBeenCalledWith(expect.objectContaining({ content: null, copyFrom: "worker", copyBucket: expect.any(Object) }), expect.any(Function));
    expect(JSON.stringify(body)).not.toContain("base64");
  });

  it("accepts the exact two-path change set for a rename/edit candidate and records both paths", async () => {
    setupMocks(async () => true);
    routeMocks.preview.mockImplementation(async (input: { path: string }) => input.path === path
      ? { path, stale: false, target: { hash: null, content: null }, worker: { hash: sourceHash, content: "edited old path\n" } }
      : { path: "src/moved.ts", stale: false, target: { hash: targetHash, content: "base bytes\n" }, worker: { hash: null, content: null } });
    const agent = createAgent({ execution: "passed", pairedRename: true });
    configurePublish(agent);
    const changes = [
      { path, expectedTargetHash: null, expectedSourceHash: sourceHash, content: null },
      { path: "src/moved.ts", expectedTargetHash: targetHash, expectedSourceHash: null, content: "reviewed edit on renamed path\n" },
    ];
    const response = await invoke(agent.instance, { expectedTargetHash: null, expectedSourceHash: sourceHash, content: null, changes });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolution: { path, paths: [path, "src/moved.ts"], status: "published", validation: { status: "passed" } } });
    expect(routeMocks.publish).toHaveBeenCalledWith(expect.objectContaining({ path, content: null, changes }), expect.any(Function));
    expect(agent.getResult().workspaceMerge.status).toBe("manually_resolved");
    const replay = await invoke(agent.instance, { expectedTargetHash: null, expectedSourceHash: sourceHash, content: null,
      idempotencyKey: "manual-route-1", changes });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replay: true, resolution: { path, paths: [path, "src/moved.ts"] } });
    expect(routeMocks.publish).toHaveBeenCalledTimes(1);
    expect(agent.execution).toHaveBeenCalledTimes(1);
    expect(agent.getCanonicalPublicationCount()).toBe(1);
  });

  it("blocks a stale paired rename path before validation or publication", async () => {
    setupMocks(async () => true);
    routeMocks.preview.mockImplementation(async (input: { path: string }) => input.path === path
      ? { path, stale: false, target: { hash: null, content: null }, worker: { hash: sourceHash, content: "edited old path\n" } }
      : { path: "src/moved.ts", stale: true, target: { hash: "e".repeat(64), content: "changed concurrently\n" }, worker: { hash: null, content: null } });
    const agent = createAgent({ execution: "passed", pairedRename: true });
    configurePublish(agent);
    const response = await invoke(agent.instance, { expectedTargetHash: null, expectedSourceHash: sourceHash, content: null, changes: [
      { path, expectedTargetHash: null, expectedSourceHash: sourceHash, content: null },
      { path: "src/moved.ts", expectedTargetHash: targetHash, expectedSourceHash: null, content: "reviewed edit on renamed path\n" },
    ] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "workspace_manual_resolution_stale_input" });
    expect(routeMocks.publish).not.toHaveBeenCalled();
    expect(agent.execution).not.toHaveBeenCalled();
  });

  it("previews a reviewer-selected related path only for a delete/edit conflict", async () => {
    setupMocks(async () => true);
    routeMocks.preview.mockResolvedValue({ path, stale: false, target: { hash: null, content: null },
      worker: { hash: sourceHash, content: "edited old path\n" },
      paired: { path: "src/moved.ts", target: { hash: targetHash, content: "base\n" }, worker: { hash: null, content: null } } });
    const agent = createAgent({ execution: "passed", unpairedDeleteEdit: true });
    const response = await invokePreview(agent.instance, { pairedPath: "src/moved.ts" });
    expect(response.status).toBe(200);
    expect(routeMocks.preview).toHaveBeenCalledWith(expect.objectContaining({ path, pairedPath: "src/moved.ts" }), expect.any(Function), expect.any(Object));
  });

  it("publishes a reviewer-selected rename/edit pair only as one checked resolution", async () => {
    setupMocks(async () => true);
    routeMocks.preview.mockImplementation(async (input: { path: string }) => input.path === path
      ? { path, stale: false, target: { hash: null, content: null }, worker: { hash: sourceHash, content: "edited old path\n" } }
      : { path: "src/moved.ts", stale: false, target: { hash: targetHash, content: "base\n" }, worker: { hash: null, content: null } });
    const agent = createAgent({ execution: "passed", unpairedDeleteEdit: true });
    configurePublish(agent);
    const changes = [
      { path, expectedTargetHash: null, expectedSourceHash: sourceHash, content: null },
      { path: "src/moved.ts", expectedTargetHash: targetHash, expectedSourceHash: null, content: "reviewed edit at the selected path\n" },
    ];
    const response = await invoke(agent.instance, { expectedTargetHash: null, expectedSourceHash: sourceHash, content: null,
      idempotencyKey: "manual-selected-rename-1", changes });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolution: { path, paths: [path, "src/moved.ts"], status: "published" } });
    expect(routeMocks.publish).toHaveBeenCalledWith(expect.objectContaining({ path, content: null, changes }), expect.any(Function));
    expect(agent.getCanonicalPublicationCount()).toBe(1);
  });

  it("rejects reviewer-selected path pairing for a conflict without delete/edit semantics", async () => {
    setupMocks(async () => true);
    const agent = createAgent({ execution: "passed" });
    const response = await invokePreview(agent.instance, { pairedPath: "src/moved.ts" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "workspace_manual_preview_pair_not_allowed" });
    expect(routeMocks.preview).not.toHaveBeenCalled();
  });

  it("fails closed when a conflict report contains a malformed paired path", async () => {
    setupMocks(async () => true);
    const previewAgent = createAgent({ execution: "passed", unpairedDeleteEdit: true, invalidReportedPair: true });
    const preview = await invokePreview(previewAgent.instance, { pairedPath: "src/moved.ts" });
    expect(preview.status).toBe(409);
    expect(await preview.json()).toMatchObject({ error_code: "workspace_manual_preview_pair_not_allowed" });
    expect(routeMocks.preview).not.toHaveBeenCalled();

    const publishAgent = createAgent({ execution: "passed", unpairedDeleteEdit: true, invalidReportedPair: true });
    configurePublish(publishAgent);
    const response = await invoke(publishAgent.instance, { expectedTargetHash: null, expectedSourceHash: sourceHash, content: null,
      changes: [
        { path, expectedTargetHash: null, expectedSourceHash: sourceHash, content: null },
        { path: "src/moved.ts", expectedTargetHash: targetHash, expectedSourceHash: null, content: "reviewed edit\n" },
      ] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "workspace_manual_resolution_conflict_mismatch" });
    expect(routeMocks.publish).not.toHaveBeenCalled();
  });

});
