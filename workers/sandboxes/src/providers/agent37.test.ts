import { describe, expect, it, vi } from "vitest";
import { Agent37Provider } from "./agent37.js";

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
          { name: "notes", path: "/home/node/workspace/notes", type: "directory", size: null, modified: 1781049642.125 },
        ] : path === "/home/node/workspace/notes" ? [
          { name: "data.bin", path: "/home/node/workspace/notes/data.bin", type: "file", size: oldBytes.length, modified: 1781049642.125 },
        ] : [] });
      }
      if (url.pathname === "/v1/files/content" && init?.method === "GET") return new Response(oldBytes);
      if (url.pathname === "/v1/files/content" && init?.method === "PUT") {
        expect(url.searchParams.get("overwrite")).toBe("true");
        expect(new Headers(init.headers).get("x-expected-mtime")).toBe("1781049642.125");
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
    expect(listed).toEqual([{ path: "notes/data.bin", size: oldBytes.length, modified: 1781049642.125 }]);
    await provider.writeWorkspaceFile(allocation, "notes/data.bin", new TextEncoder().encode("new"), await crypto.subtle.digest("SHA-256", oldBytes).then((value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")));
    expect(fetcher).toHaveBeenCalledTimes(9);
    await expect(provider.readWorkspaceFile(allocation, "../outside" )).rejects.toThrow("agent37_workspace_path_rejected");
  });
});
