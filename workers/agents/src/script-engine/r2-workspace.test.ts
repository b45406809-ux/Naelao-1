import { describe, expect, it, vi } from "vitest";
import {
  executeVirtualShell,
  virtualFsDelete,
  virtualFsGrep,
  virtualFsList,
  virtualFsRead,
  virtualFsWrite,
} from "./r2-workspace.js";
import { workspacePrefix } from "./types.js";
import { codeExec } from "./prebuilt/code-exec.js";
import { r2Workspace } from "./prebuilt/r2-workspace.js";
import { workspace } from "./prebuilt/workspace.js";
import { withWorkspaceManifestRead } from "./workspace-r2-compat.js";

function createMockEnv() {
  const store = new Map();
  const metadata = new Map();
  const etags = new Map();
  const getCalls: string[] = [];
  const mockBucket = {
    get: async (key) => {
      getCalls.push(key);
      const data = store.get(key);
      return data ? { size: data.byteLength, arrayBuffer: async () => data.buffer } : null;
    },
    head: async (key) => store.has(key) ? { customMetadata: metadata.get(key), etag: etags.get(key) } : null,
    put: async (key, value, options) => {
      if (options?.onlyIf?.etagMatches && etags.get(key) !== options.onlyIf.etagMatches) return undefined;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) return undefined;
      store.set(key, value);
      metadata.set(key, options?.customMetadata ?? {});
      const etag = `etag-${store.size}-${Date.now()}`;
      etags.set(key, etag);
      return { etag };
    },
    delete: async (key) => {
      store.delete(key);
    },
    list: async ({ prefix }) => {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, size: store.get(key).byteLength, customMetadata: metadata.get(key) }));
      return { objects, truncated: false };
    },
  };

  return {
    store,
    getCalls,
    scriptsBucket: mockBucket,
    workspaceBucket: mockBucket,
    spaceId: "space-1",
    projectId: "proj-1",
    agentId: "agent-1",
    tenantId: "tenant-1",
    workspaceFileScope: undefined as string[] | undefined,
  };
}

describe("R2 Virtual POSIX Workspace", () => {
  it("isolates a race branch below the project workspace prefix", () => {
    expect(workspacePrefix({ spaceId: "space-1", projectId: "proj-1", workspaceBranch: "race/task/model" }))
      .toBe("spaces/space-1/projects/proj-1/workspace/branches/race/task/model/");
    expect(workspacePrefix({ spaceId: "space-1", projectId: "proj-1" }))
      .toBe("spaces/space-1/projects/proj-1/workspace/");
    expect(workspacePrefix({ spaceId: "space-1", projectId: "proj-1", spaceWorkspaceExtensionId: "install-1" }))
      .toBe("spaces/space-1/projects/proj-1/workspace/");
    expect(workspacePrefix({ spaceId: "space-1", spaceWorkspaceExtensionId: "install-1" }))
      .toBe("spaces/space-1/space-workspace/extensions/install-1/workspace/");
    expect(workspacePrefix({ spaceId: "space-1" })).toBe("spaces/space-1/workspace/");
    expect(() => workspacePrefix({ spaceId: "space-1", projectId: "proj-1", workspaceBranch: "../escape" })).toThrow("invalid path");
    expect(() => workspacePrefix({ spaceId: "space-1", spaceWorkspaceExtensionId: "../escape" })).toThrow("invalid identifier");
  });
  it("keeps Space-wide extension files out of the Space Assistant and peer extension workspaces", async () => {
    const base = createMockEnv();
    const assistant = { ...base, projectId: undefined, spaceWorkspaceExtensionId: undefined };
    const extensionA = { ...base, projectId: undefined, spaceWorkspaceExtensionId: "install-a" };
    const extensionB = { ...base, projectId: undefined, spaceWorkspaceExtensionId: "install-b" };
    await virtualFsWrite(extensionA, "reports/private.txt", "extension A data", null);
    expect(await virtualFsRead(extensionA, "reports/private.txt")).toBe("extension A data");
    expect(await virtualFsRead(extensionB, "reports/private.txt")).toBeNull();
    expect(await virtualFsRead(assistant, "reports/private.txt")).toBeNull();
    expect([...base.store.keys()]).toContain("spaces/space-1/space-workspace/extensions/install-a/workspace/reports/private.txt");
    expect([...base.store.keys()]).toHaveLength(1);
  });
  async function hash(content: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  it("performs file read, write, delete, and list operations in V8", async () => {
    const env = createMockEnv();
    await virtualFsWrite(env, "docs/readme.md", "hello world", null);
    expect(await virtualFsRead(env, "docs/readme.md")).toBe("hello world");

    const list = await virtualFsList(env, "docs");
    expect(list).toEqual([{ path: "docs/readme.md", size: 11 }]);

    await expect(virtualFsWrite(env, "docs/readme.md", "clobber", null)).rejects.toThrow("Conflict Error");
    await virtualFsDelete(env, "docs/readme.md", await hash("hello world"));
    expect(await virtualFsRead(env, "docs/readme.md")).toBeNull();
  });

  it("reads the coordinator manifest instead of stale per-file objects in unified mode", async () => {
    const env = createMockEnv();
    const legacyKey = `${workspacePrefix(env)}docs/readme.md`;
    const content = new TextEncoder().encode("canonical revision");
    const digest = await hash("canonical revision");
    const objectKey = `workspace-v1/${env.tenantId}/${env.spaceId}/${env.projectId}/global/content/${digest}`;
    env.store.set(legacyKey, new TextEncoder().encode("stale legacy value"));
    env.store.set(objectKey, content);
    env.workspaceManifestRead = async () => ({ head: { branch: "main", revision: 3, updatedAt: "2026-11-08T00:00:00.000Z" }, entries: [
      { path: "docs/readme.md", sha256: digest, size: content.byteLength, executable: false, objectKey },
    ] });
    env.workspaceBucket = withWorkspaceManifestRead(env.scriptsBucket, workspacePrefix(env), env.workspaceManifestRead);

    const ctx = { env, run: async () => undefined } as never;
    const read = await r2Workspace.operations.read_file({ path: "docs/readme.md" }, ctx) as { content: string; hash: string; revision?: { branch: string; revision: number } };
    expect(read).toMatchObject({ content: "canonical revision", hash: digest, revision: { branch: "main", revision: 3 } });
    expect(env.getCalls).not.toContain(legacyKey);
    expect(await r2Workspace.operations.list_directory({}, ctx)).toMatchObject({ files: [{ key: legacyKey, size: content.byteLength }], revision: { branch: "main", revision: 3 } });
    await expect(r2Workspace.operations.write_file({ path: "docs/readme.md", content: "unsafe stale write", expectedHash: digest }, ctx))
      .rejects.toThrow("Conflict Error");
    await expect(r2Workspace.operations.write_file({ path: "docs/new.txt", content: "unsafe legacy create", expectedHash: null }, ctx))
      .rejects.toThrow("Conflict Error");
    expect(new TextDecoder().decode(env.store.get(legacyKey))).toBe("stale legacy value");
    expect(env.store.has(`${workspacePrefix(env)}docs/new.txt`)).toBe(false);
  });

  it("returns one verified manifest revision for workspace listings and container sync", async () => {
    const env = createMockEnv();
    const path = "src/app.ts";
    const content = "export const ready = true;";
    const digest = await hash(content);
    const objectKey = `workspace-v1/${env.tenantId}/${env.spaceId}/${env.projectId}/global/content/${digest}`;
    env.store.set(objectKey, new TextEncoder().encode(content));
    env.workspaceManifestRead = async () => ({ head: { branch: "task/isolated", revision: 4, updatedAt: "2026-11-08T00:00:00.000Z" }, entries: [
      { path, sha256: digest, size: new TextEncoder().encode(content).byteLength, executable: false, objectKey },
    ] });
    env.workspaceBucket = withWorkspaceManifestRead(env.scriptsBucket, workspacePrefix(env), env.workspaceManifestRead);
    const copied: Record<string, string> = {};
    const containerWorkspace = { read: async (paths?: string[]) => ({ files: Object.fromEntries((paths ?? []).map(name => [name, copied[name] ?? ""])) }),
      write: async (files: Record<string, string>) => Object.assign(copied, files) };
    const ctx = { env: { ...env, containerWorkspace }, run: async () => undefined } as never;
    expect(await workspace.operations["workspace.list"]!({ name: "r2" }, ctx)).toMatchObject({
      workspace: "r2", files: [path], revision: { branch: "task/isolated", revision: 4 },
    });
    expect(await workspace.operations["workspace.sync_to_container"]!({}, ctx)).toMatchObject({
      synced_files_count: 1, revision: { branch: "task/isolated", revision: 4 },
    });
    expect(copied[path]).toBe(content);
  });

  it("rejects container sync if the coordinator revision changes after its manifest snapshot", async () => {
    const env = createMockEnv();
    const path = "src/app.ts";
    const content = "export const ready = true;";
    const digest = await hash(content);
    const objectKey = "workspace-v1/" + env.tenantId + "/" + env.spaceId + "/" + env.projectId + "/global/content/" + digest;
    env.store.set(objectKey, new TextEncoder().encode(content));
    let revision = 0;
    env.workspaceManifestRead = async () => ({ head: { branch: "task/isolated", revision: ++revision, updatedAt: "2026-11-08T00:00:00.000Z" }, entries: [
      { path, sha256: digest, size: new TextEncoder().encode(content).byteLength, executable: false, objectKey },
    ] });
    env.workspaceBucket = withWorkspaceManifestRead(env.scriptsBucket, workspacePrefix(env), env.workspaceManifestRead);
    const copied: Record<string, string> = {};
    const ctx = { env: { ...env, containerWorkspace: {
      read: async () => ({ files: {} }), write: async (files: Record<string, string>) => { Object.assign(copied, files); },
    } }, run: async () => undefined } as never;
    await expect(workspace.operations["workspace.sync_to_container"]!({}, ctx))
      .rejects.toThrow("workspace_manifest_changed_during_sync");
    expect(revision).toBe(2);
    expect(copied[path]).toBeUndefined();
  });

  it("bounds script dual-read drift and logs hashes without paths or contents", async () => {
    const env = createMockEnv();
    const path = "private/customer-notes.txt";
    const legacyKey = `${workspacePrefix(env)}${path}`;
    const canonicalText = "canonical secret text";
    const legacyText = "legacy secret text!!!";
    const digest = await hash(canonicalText);
    const objectKey = `workspace-v1/${env.tenantId}/${env.spaceId}/${env.projectId}/global/content/${digest}`;
    env.store.set(legacyKey, new TextEncoder().encode(legacyText));
    env.store.set(objectKey, new TextEncoder().encode(canonicalText));
    env.workspaceManifestRead = async () => ({ head: { branch: "task/run-1", revision: 7, updatedAt: "2026-11-08T00:00:00.000Z" }, entries: [
      { path, sha256: digest, size: new TextEncoder().encode(canonicalText).byteLength, executable: false, objectKey },
    ] });
    env.workspaceBucket = withWorkspaceManifestRead(env.scriptsBucket, workspacePrefix(env), env.workspaceManifestRead, {
      enabled: true, tenantId: env.tenantId, spaceId: env.spaceId, projectId: env.projectId,
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await r2Workspace.operations.read_file({ path }, { env, run: async () => undefined } as never) as { content: string };
      expect(result.content).toBe(canonicalText);
      for (let index = 0; index < 24; index++) await env.workspaceBucket!.get(legacyKey);
      expect(log).toHaveBeenCalledWith("workspace_dual_read", expect.objectContaining({
        tenantId: env.tenantId, spaceId: env.spaceId, projectId: env.projectId,
        branch: "task/run-1", revision: 7, mismatchClass: "hash_mismatch",
      }));
      const event = JSON.stringify(log.mock.calls[0]);
      expect(event).not.toContain(path);
      expect(event).not.toContain(canonicalText);
      expect(event).not.toContain(legacyText);
      expect(log).toHaveBeenCalledTimes(20);
    } finally { log.mockRestore(); }
  });

  it("does not fall back to a stale legacy value when the canonical reader fails", async () => {
    const env = createMockEnv();
    const legacyKey = `${workspacePrefix(env)}docs/readme.md`;
    env.store.set(legacyKey, new TextEncoder().encode("stale legacy value"));
    env.workspaceManifestRead = async () => { throw new Error("workspace_read_failed:503"); };
    env.workspaceBucket = withWorkspaceManifestRead(env.scriptsBucket, workspacePrefix(env), env.workspaceManifestRead);
    await expect(r2Workspace.operations.read_file({ path: "docs/readme.md" }, { env, run: async () => undefined } as never))
      .rejects.toThrow("workspace_read_failed:503");
    expect(env.getCalls).not.toContain(legacyKey);
  });

  it("rejects legacy CAS writers for project workspace paths when manifest reads are enabled", async () => {
    const env = createMockEnv();
    env.workspaceManifestRead = async () => ({ head: { branch: "main", revision: 1, updatedAt: "2026-11-08T00:00:00.000Z" }, entries: [] });
    await expect(virtualFsWrite(env, "docs/new.txt", "must use checked publication", null))
      .rejects.toThrow("workspace_write_requires_checked_publication");
    await expect(virtualFsDelete(env, "docs/old.txt", null))
      .rejects.toThrow("workspace_write_requires_checked_publication");
    expect(env.store.size).toBe(0);
  });

  it("supports virtual in-isolate grepping without container execution", async () => {
    const env = createMockEnv();
    await virtualFsWrite(
      env,
      "src/api.ts",
      "const x = 1;\nexport function findMe() {}\nconst y = 2;",
      null
    );
    await virtualFsWrite(env, "src/util.ts", "export const version = '1.0';", null);

    const matches = await virtualFsGrep(env, "findMe", "src");
    expect(matches).toEqual([
      { path: "src/api.ts", line: 2, match: "export function findMe() {}" },
    ]);
  });

  it("enforces the host-signed exact file slice for reads, writes, deletes and listings", async () => {
    const env = createMockEnv();
    await virtualFsWrite(env, "src/owned.ts", "owned", null);
    await virtualFsWrite(env, "src/other.ts", "other", null);
    env.workspaceFileScope = ["src/owned.ts"];

    expect(await virtualFsRead(env, "src/owned.ts")).toBe("owned");
    await expect(virtualFsRead(env, "src/other.ts")).rejects.toThrow("worker_file_scope_denied");
    await expect(virtualFsWrite(env, "src/other.ts", "changed", null)).rejects.toThrow("worker_file_scope_denied");
    await expect(virtualFsDelete(env, "src/other.ts", null)).rejects.toThrow("worker_file_scope_denied");
    expect(await virtualFsList(env, "src")).toEqual([{ path: "src/owned.ts", size: 5 }]);
    expect(await virtualFsGrep(env, "other", "src")).toEqual([]);
    await expect(codeExec.operations.Bash({ commands: "cat src/other.ts" }, { env, run: async () => undefined })).rejects.toThrow("worker_file_scope_denied");
    await expect(codeExec.operations["code.execute_python"]({ code: "open('src/other.ts').read()" }, { env, run: async () => undefined })).rejects.toThrow("worker_file_scope_native_execution_unavailable");
  });

  it("executes virtual shell commands directly", async () => {
    const env = createMockEnv();
    const writeRes = await executeVirtualShell(env, "write", {
      path: "notes.txt",
      content: "POSIX in V8",
      expectedHash: null,
    });
    expect(writeRes.ok).toBe(true);
    expect(writeRes.tier).toBe(1);
    const readRes = await executeVirtualShell(env, "read", {
      path: "notes.txt",
    });
    expect(readRes.output).toBe("POSIX in V8");
  });
});
