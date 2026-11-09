import { describe, expect, it, vi } from "vitest";
import { Agent37Provider, type Agent37WorkspaceHandoff } from "./agent37.js";

const computer = {
  id: "cmp_1",
  scope: { tenantId: "t", ownerId: "u" },
  templateId: "node",
  templateVersion: "1",
  ownership: "naelao_managed" as const,
  filesystemId: "fs_1",
  filesystemMode: "snapshot_diff" as const,
  providerPreference: "agent37" as const,
  state: "configured" as const,
  resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
  idleTimeoutSeconds: 900,
  allocationGeneration: 1,
};
describe("Agent37 adapter", () => {
  it("uses checked snapshot, stage, and publish mocks for a file change", async () => {
    const bytes = new TextEncoder().encode("old");
    const next = new TextEncoder().encode("new");
    const hash = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const provider = new Agent37Provider(
      { apiKey: "k", instanceKey: "k" },
      { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 },
      vi.fn(async () => Response.json({ path: "/home/node/workspace", entries: [], truncated: false })) as typeof fetch,
    );
    // Mock the provider file plane explicitly; this does not exercise or claim live Agent37 behavior.
    vi.spyOn(provider, "writeWorkspaceFile").mockResolvedValue();
    vi.spyOn(provider, "invoke").mockResolvedValue({ id: "exec-checked", status: "succeeded", exitCode: 0, stdout: "ok", stderr: "", truncated: false, publicationId: null, workspaceState: "unchanged" });
    vi.spyOn(provider, "listWorkspace").mockResolvedValue([{ path: "doc.txt", size: 3, modified: 1 }]);
    vi.spyOn(provider, "readWorkspaceFile").mockResolvedValue(next);
    const coordinator: Agent37WorkspaceHandoff = {
      readCommitted: vi.fn(async () => ({ tenantId: "t", spaceId: "s", projectId: "p", branch: "main", sessionId: "ws_12345678-1234-1234-1234-123456789012", revision: 4, fence: 2, allocationGeneration: 1, files: [{ path: "doc.txt", sha256: await hash(bytes), executable: false, contentType: "text/plain; charset=utf-8", bytes }] })),
      stage: vi.fn(async () => ({ stageId: "stage-1" })),
      publish: vi.fn(async () => ({ status: "published" as const, publicationId: "pub-1" })),
    };
    const scopedComputer = { ...computer, scope: { tenantId: "t", ownerId: "u", spaceId: "s", projectId: "p" } };
    const result = await provider.invokeWithWorkspace({ executionId: "exec-checked", computer: scopedComputer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 1 }, command: "true", args: [], timeoutMs: 1000 }, coordinator);
    expect(coordinator.readCommitted).toHaveBeenCalledWith({ tenantId: "t", spaceId: "s", projectId: "p", branch: "main", allocationGeneration: 1 });
    expect(coordinator.stage).toHaveBeenCalledWith(expect.objectContaining({ revision: 4, fence: 2, allocationGeneration: 1, changes: [{ path: "doc.txt", expectedHash: await hash(bytes), bytes: next, contentType: "text/plain; charset=utf-8" }] }));
    expect(coordinator.publish).toHaveBeenCalledWith(expect.objectContaining({ stageId: "stage-1", idempotencyKey: "agent37:exec-checked" }));
    expect(result).toMatchObject({ workspaceState: "published", publicationId: "pub-1" });
  });

  it("never stages after an indeterminate dispatch and marks recovery required", async () => {
    const provider = new Agent37Provider({ apiKey: "k", instanceKey: "k" }, { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 }, vi.fn(async () => Response.json({ path: "/home/node/workspace", entries: [], truncated: false })) as typeof fetch);
    vi.spyOn(provider, "invoke").mockResolvedValue({ id: "exec-unknown", status: "indeterminate", exitCode: null, stdout: "", stderr: "unknown", truncated: false, publicationId: null, workspaceState: "recovery_required" });
    const coordinator: Agent37WorkspaceHandoff = {
      readCommitted: vi.fn(async () => ({ tenantId: "t", spaceId: "s", projectId: "p", branch: "main", sessionId: "ws_12345678-1234-1234-1234-123456789012", revision: 1, fence: 0, allocationGeneration: 1, files: [] })),
      stage: vi.fn(async () => ({ stageId: "stage" })), publish: vi.fn(async () => ({ status: "published" as const, publicationId: "pub" })),
    };
    const scopedComputer = { ...computer, scope: { tenantId: "t", ownerId: "u", spaceId: "s", projectId: "p" } };
    const result = await provider.invokeWithWorkspace({ executionId: "exec-unknown", computer: scopedComputer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 1 }, command: "true", args: [], timeoutMs: 1000 }, coordinator);
    expect(result.workspaceState).toBe("recovery_required");
    expect(result.workspaceSessionId).toBe("ws_12345678-1234-1234-1234-123456789012");
    expect(coordinator.stage).not.toHaveBeenCalled();
    expect(coordinator.publish).not.toHaveBeenCalled();
  });

  it("does not publish a provider-cancelled execution", async () => {
    const provider = new Agent37Provider({ apiKey: "k", instanceKey: "k" }, { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 }, vi.fn(async () => Response.json({ path: "/home/node/workspace", entries: [], truncated: false })) as typeof fetch);
    vi.spyOn(provider, "invoke").mockResolvedValue({ id: "exec-cancelled", status: "cancelled", exitCode: null, stdout: "", stderr: "cancelled", truncated: false, publicationId: null, workspaceState: "recovery_required" });
    const coordinator: Agent37WorkspaceHandoff = {
      readCommitted: vi.fn(async () => ({ tenantId: "t", spaceId: "s", projectId: "p", branch: "main", sessionId: "ws_12345678-1234-1234-1234-123456789012", revision: 1, fence: 0, allocationGeneration: 1, files: [] })),
      stage: vi.fn(async () => ({ stageId: "stage" })), publish: vi.fn(async () => ({ status: "published" as const, publicationId: "pub" })),
    };
    const scopedComputer = { ...computer, scope: { tenantId: "t", ownerId: "u", spaceId: "s", projectId: "p" } };
    const result = await provider.invokeWithWorkspace({ executionId: "exec-cancelled", computer: scopedComputer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 1 }, command: "true", args: [], timeoutMs: 1000 }, coordinator);
    expect(result.workspaceState).toBe("recovery_required");
    expect(coordinator.stage).not.toHaveBeenCalled();
  });

  it("withholds publication when Agent37 reports truncated command output", async () => {
    const provider = new Agent37Provider({ apiKey: "k", instanceKey: "k" }, { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 }, vi.fn(async () => Response.json({ path: "/home/node/workspace", entries: [], truncated: false })) as typeof fetch);
    vi.spyOn(provider, "invoke").mockResolvedValue({ id: "exec-truncated-handoff", status: "succeeded", exitCode: 0, stdout: "partial", stderr: "", truncated: true, publicationId: null, workspaceState: "unchanged" });
    const coordinator: Agent37WorkspaceHandoff = {
      readCommitted: vi.fn(async () => ({ tenantId: "t", spaceId: "s", projectId: "p", branch: "main", sessionId: "ws_12345678-1234-1234-1234-123456789012", revision: 1, fence: 0, allocationGeneration: 1, files: [] })),
      stage: vi.fn(async () => ({ stageId: "stage" })), publish: vi.fn(async () => ({ status: "published" as const, publicationId: "pub" })),
    };
    const scopedComputer = { ...computer, scope: { tenantId: "t", ownerId: "u", spaceId: "s", projectId: "p" } };
    const result = await provider.invokeWithWorkspace({ executionId: "exec-truncated-handoff", computer: scopedComputer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 1 }, command: "true", args: [], timeoutMs: 1000 }, coordinator);
    expect(result.workspaceState).toBe("recovery_required");
    expect(coordinator.stage).not.toHaveBeenCalled();
  });

  it("rejects a stale allocation generation before reading or dispatching", async () => {
    const provider = new Agent37Provider({ apiKey: "k", instanceKey: "k" }, { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 }, vi.fn() as typeof fetch);
    const coordinator: Agent37WorkspaceHandoff = { readCommitted: vi.fn(), stage: vi.fn(), publish: vi.fn() };
    await expect(provider.invokeWithWorkspace({ executionId: "exec-stale", computer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 2 }, command: "true", args: [], timeoutMs: 1000 }, coordinator)).rejects.toThrow("allocation_generation_mismatch");
    expect(coordinator.readCommitted).not.toHaveBeenCalled();
  });

  it("does not replay or misreport an ambiguous coordinator publish response", async () => {
    const provider = new Agent37Provider({ apiKey: "k", instanceKey: "k" }, { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 }, vi.fn(async () => Response.json({ path: "/home/node/workspace", entries: [], truncated: false })) as typeof fetch);
    const next = new TextEncoder().encode("new");
    vi.spyOn(provider, "invoke").mockResolvedValue({ id: "exec-ambiguous", status: "succeeded", exitCode: 0, stdout: "", stderr: "", truncated: false, publicationId: null, workspaceState: "unchanged" });
    vi.spyOn(provider, "listWorkspace").mockResolvedValue([{ path: "new.txt", size: 3, modified: 1 }]);
    vi.spyOn(provider, "readWorkspaceFile").mockResolvedValue(next);
    const coordinator: Agent37WorkspaceHandoff = {
      readCommitted: vi.fn(async () => ({ tenantId: "t", spaceId: "s", projectId: "p", branch: "main", sessionId: "ws_12345678-1234-1234-1234-123456789012", revision: 1, fence: 0, allocationGeneration: 1, files: [] })),
      stage: vi.fn(async () => ({ stageId: "stage-stable" })),
      publish: vi.fn(async () => { throw new Error("response lost after dispatch"); }),
    };
    const scopedComputer = { ...computer, scope: { tenantId: "t", ownerId: "u", spaceId: "s", projectId: "p" } };
    const result = await provider.invokeWithWorkspace({ executionId: "exec-ambiguous", computer: scopedComputer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 1 }, command: "true", args: [], timeoutMs: 1000 }, coordinator);
    expect(result.workspaceState).toBe("recovery_required");
    expect(coordinator.publish).toHaveBeenCalledTimes(1);
    expect(provider.invoke).toHaveBeenCalledTimes(1);
  });

  it("uses the control key and preserves provider idempotency key", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "ab12cd34ef",
            url: "https://ab12cd34ef.agent37.app",
          }),
          { status: 201 }
        )
    );
    const provider = new Agent37Provider(
      { apiKey: "secret-control", instanceKey: "secret-instance" },
      {
        id: "approved",
        version: "4",
        instanceType: "default",
        region: "us",
        diskGiB: 20,
      },
      fetcher as typeof fetch
    );
    const allocation = await provider.allocate(computer, "op-create-1");
    expect(allocation.externalId).toBe("ab12cd34ef");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get("authorization")).toBe(
      "Bearer secret-control"
    );
    expect((init.headers as Headers).get("idempotency-key")).toBeNull();
    expect(JSON.parse(String(init.body)).metadata.naelao_operation_id).toBe(
      "op-create-1"
    );
    expect(String(init.body)).toContain('"memory":4');
    expect(allocation.endpoint).toBe("https://ab12cd34ef.agent37.app");
  });
  it("uses the documented separate command host and provider idempotency name", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            exit_code: 0,
            stdout: "ok",
            stderr: "",
            truncated: false,
          }),
          { status: 200 }
        )
    );
    const provider = new Agent37Provider(
      { apiKey: "k", instanceKey: "k" },
      {
        id: "approved",
        version: "4",
        instanceType: "default",
        region: "us",
        diskGiB: 20,
      },
      fetcher as typeof fetch
    );
    const allocation = {
      provider: "agent37" as const,
      externalId: "ab12cd34ef",
      generation: 1,
    };
    await provider.invoke({
      executionId: "exec-1",
      computer,
      allocation,
      command: "printf",
      args: ["hello world", "a'b"],
      cwd: "/workspace/demo",
      timeoutMs: 1000,
    });
    const call = fetcher.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("fetch_not_called");
    const [url, init] = call;
    if (!init) throw new Error("fetch_init_missing");
    expect(String(url)).toBe(
      "https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec"
    );
    expect(new Headers(init.headers).get("x-agent37-key")).toBe("k");
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "naelao-exec-1",
      command: "cd '/workspace/demo' && 'printf' 'hello world' 'a'\\''b'",
    });
  });
  it("marks a timed out command as indeterminate because aborting HTTP cannot prove the process stopped", async () => {
    const fetcher = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          )
        )
    );
    const provider = new Agent37Provider(
      { apiKey: "k", instanceKey: "k" },
      {
        id: "approved",
        version: "4",
        instanceType: "default",
        region: "us",
        diskGiB: 20,
      },
      fetcher as typeof fetch
    );
    const result = await provider.invoke({
      executionId: "exec-timeout",
      computer,
      allocation: {
        provider: "agent37",
        externalId: "ab12cd34ef",
        generation: 1,
      },
      command: "sleep",
      args: ["90"],
      timeoutMs: 2,
    });
    expect(result.status).toBe("indeterminate");
    expect(result.workspaceState).toBe("recovery_required");
  });

  it("treats an ambiguous provider HTTP response as indeterminate even if its body resembles success", async () => {
    const provider = new Agent37Provider({ apiKey: "k", instanceKey: "k" }, { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 },
      vi.fn(async () => Response.json({ exit_code: 0, stdout: "maybe", stderr: "" }, { status: 503 })) as typeof fetch);
    const result = await provider.invoke({ executionId: "exec-http-ambiguous", computer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 1 }, command: "true", args: [], timeoutMs: 1000 });
    expect(result).toMatchObject({ status: "indeterminate", exitCode: null, workspaceState: "recovery_required" });
  });

  it("preserves the provider's truncation signal even when returned text is below the local cap", async () => {
    const provider = new Agent37Provider(
      { apiKey: "k", instanceKey: "k" },
      { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 },
      vi.fn(async () => new Response(JSON.stringify({ exit_code: 0, stdout: "prefix only", stderr: "", truncated: true }), { status: 200 })) as typeof fetch,
    );
    const result = await provider.invoke({
      executionId: "exec-truncated", computer, allocation: { provider: "agent37", externalId: "ab12cd34ef", generation: 1 },
      command: "cat", args: ["large.log"], timeoutMs: 1000,
    });
    expect(result).toMatchObject({ status: "succeeded", stdout: "prefix only", truncated: true });
  });

  it("limits Agent37 file access to the Naelao subtree and uses the provider's mtime compare on writes", async () => {
    const oldBytes = new TextEncoder().encode("old value");
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/files" && init?.method !== "PUT") {
        const path = url.searchParams.get("path");
        return Response.json({ path, truncated: false, entries: path === "/home/node/workspace" ? [
          { name: "notes", path: "/home/node/workspace/notes", type: "directory", size: null, modified: 1781049642125.125 },
        ] : path === "/home/node/workspace/notes" ? [
          { name: "data.bin", path: "/home/node/workspace/notes/data.bin", type: "file", size: oldBytes.length, modified: 1781049642125.125 },
        ] : [] });
      }
      if (url.pathname === "/v1/files/content" && init?.method === "GET") return new Response(oldBytes);
      if (url.pathname === "/v1/files/content" && init?.method === "PUT") {
        expect(url.searchParams.get("overwrite")).toBe("true");
        expect(new Headers(init.headers).get("x-expected-mtime")).toBe("1781049642125.125");
        expect(new Headers(init.headers).get("x-agent37-key")).toBe("instance-secret");
        return Response.json({ path: "/home/node/workspace/notes/data.bin", type: "file", size: 3, modified: 1781049643.5 });
      }
      throw new Error(`unexpected Agent37 file request: ${init?.method} ${url}`);
    });
    const provider = new Agent37Provider(
      { apiKey: "control-secret", instanceKey: "instance-secret" },
      { id: "approved", version: "4", instanceType: "default", region: "us", diskGiB: 20 },
      fetcher as typeof fetch,
    );
    const allocation = { provider: "agent37" as const, externalId: "ab12cd34ef", generation: 1 };
    const listed = await provider.listWorkspace(allocation);
    expect(listed).toEqual([{ path: "notes/data.bin", size: oldBytes.length, modified: 1781049642125.125 }]);
    await provider.writeWorkspaceFile(allocation, "notes/data.bin", new TextEncoder().encode("new"), await crypto.subtle.digest("SHA-256", oldBytes).then((value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")));
    expect(fetcher).toHaveBeenCalledTimes(9);
    await expect(provider.readWorkspaceFile(allocation, "../outside" )).rejects.toThrow("agent37_workspace_path_rejected");
  });
});
