import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { LocalTunnelDO } from "./LocalTunnelDO.js";

async function fixture() {
  const data = new Map<string, unknown>(), outbox: string[] = [];
  const identity = { tenantId: "tenant", spaceId: "space", machineId: "machine" };
  data.set("machine_identity", identity); data.set("socket_generation", 1);
  const makeSocket = () => ({ send: (message: string) => { outbox.push(message); }, close: vi.fn(),
    deserializeAttachment: () => ({ ...identity, generation: 1, keyVersion: 1, expiresAt: Date.now() + 300000, heartbeatAt: Date.now() }) });
  const sockets = [makeSocket()];
  let transactionTail: Promise<unknown> = Promise.resolve();
  const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key), setAlarm: async () => undefined,
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    transaction: async (fn: (tx: unknown) => unknown) => {
      const result = transactionTail.then(() => fn(storage));
      transactionTail = result.catch(() => undefined);
      return result;
    } };
  const machine = { schema: 1, ...identity, name: "machine", ownerId: "owner", status: "active", sequence: 1, keyVersion: 1,
    hardware: { platform: "linux", arch: "x64", cpuCount: 2, memoryBytes: 4096, capabilities: [], models: ["local-model"] },
    grants: [{ id: "grant", actorId: "owner", projectId: "project", expiresAt: Date.now() + 300000, roots: [{ path: "/home/owner/project", access: "readwrite" }], commands: ["task1", "task2"], inference: true }] };
  const ctx = { storage, getWebSockets: () => sockets };
  const env = { PLATFORM_SECRET: "test-secret", SPACES_WORKER: { fetch: async () => Response.json({ machine }) } as never };
  const tunnel = new LocalTunnelDO(ctx as never, env);
  const headers = { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant") };
  const invocation = (requestId: string, actorId = "owner") => ({ actorId, projectId: "project", runId: "run", requestId, deadline: Date.now() + 60000 });
  const invoke = (requestId: string, command: string, actorId = "owner") => new Request("https://tunnel/exec", { method: "POST", headers,
    body: JSON.stringify({ op: "exec", params: { command }, invocation: invocation(requestId, actorId) }) });
  return { tunnel, socket: sockets[0]!, sockets, storage, ctx, env, machine, outbox, headers, invocation, invoke,
    newTunnel: () => new LocalTunnelDO(ctx as never, env), makeSocket };
}
describe("LocalTunnelDO correlation and multiplexing", () => {
  it("closes oversized machine frames before JSON parsing", async () => {
    const f = await fixture();
    await f.tunnel.webSocketMessage(f.socket as never, "x".repeat(65_537));
    expect(f.socket.close).toHaveBeenCalledWith(1009, "frame too large");
    expect(f.outbox).toHaveLength(0);
  });

  it("rejects non-TLS remote tunnel upgrades", async () => {
    const f = await fixture();
    const response = await f.tunnel.fetch(new Request("http://agents.example.test/connect", { headers: { Upgrade: "websocket" } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "tunnel_secure_upgrade_required" });
  });
  it("bounds direct machine-authorization bodies before JSON parsing", async () => {
    const f = await fixture();
    const response = await f.tunnel.fetch(new Request("https://tunnel/authorize", {
      method: "POST", body: "x".repeat(32 * 1024 + 1),
    }));
    expect(response.status).toBe(413);
  });
  it("rejects anonymous inference before contacting the enrolled local machine", async () => {
    const f = await fixture();
    const response = await f.tunnel.fetch(new Request("https://tunnel/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "local-model", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(403); expect(f.outbox).toHaveLength(0);
  });
  it("prevents two authorized requests from crossing when responses arrive in reverse order", async () => {
    const f = await fixture();
    const one = f.tunnel.fetch(f.invoke("request-one", "task1"));
    const two = f.tunnel.fetch(f.invoke("request-two", "task2"));
    await vi.waitFor(() => expect(f.outbox).toHaveLength(2));
    const frames = f.outbox.map(text => JSON.parse(text));
    expect(frames.map(frame => frame.request_id)).toEqual(expect.arrayContaining(["request-one", "request-two"]));
    for (const frame of [...frames].reverse()) await f.tunnel.webSocketMessage(f.socket as never, JSON.stringify({
      type: "response", request_id: frame.request_id, generation: frame.generation, ok: true, result: { output: frame.params.command },
    }));
    expect(await (await one).json()).toMatchObject({ result: { output: "task1" } });
    expect(await (await two).json()).toMatchObject({ result: { output: "task2" } });
  });

  it("denies actors without an explicit machine grant before dispatch", async () => {
    const f = await fixture();
    const response = await f.tunnel.fetch(f.invoke("request-denied", "task1", "intruder"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "tunnel_machine_grant_denied" });
    expect(f.outbox).toHaveLength(0);
  });

  it("sends only the matching host-granted folders to the local OS sandbox", async () => {
    const f = await fixture();
    const pending = f.tunnel.fetch(f.invoke("request-scoped-root", "task1"));
    await vi.waitFor(() => expect(f.outbox).toHaveLength(1));
    const frame = JSON.parse(f.outbox[0]!);
    expect(frame.execution_roots).toEqual([{ path: "/home/owner/project", access: "readwrite" }]);
    expect(frame.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    await f.tunnel.webSocketMessage(f.socket as never, JSON.stringify({ type: "response", request_id: frame.request_id, generation: frame.generation, ok: true, result: { exitCode: 0 } }));
    await pending;
  });

  it("authorizes machine artifact reads and create-only writes by the explicit root grant", async () => {
    const f = await fixture();
    const dispatch = async (op: string, path: string, requestId: string, access: "read" | "write") => {
      if (access === "read") f.machine.grants[0]!.roots[0]!.access = "read";
      else f.machine.grants[0]!.roots[0]!.access = "readwrite";
      const promise = f.tunnel.fetch(new Request("https://tunnel/exec", { method: "POST", headers: f.headers,
        body: JSON.stringify({ op, params: { path, encoding: "base64", ...(op === "write_file" ? { content: "AQI=", create_only: true } : {}) }, invocation: f.invocation(requestId) }) }));
      await vi.waitFor(() => expect(f.outbox.some(text => JSON.parse(text).request_id === requestId)).toBe(true));
      const frame = f.outbox.map(text => JSON.parse(text)).find(value => value.request_id === requestId)!;
      expect(frame.op).toBe(op);
      await f.tunnel.webSocketMessage(f.socket as never, JSON.stringify({ type: "response", request_id: requestId, generation: frame.generation, ok: true,
        result: op === "read_file" ? { encoding: "base64", content: "AQI=", bytes: 2 } : { written: true, bytes: 2 } }));
      return promise;
    };
    expect(await (await dispatch("read_file", "/home/owner/project/in.bin", "file-read", "read")).json()).toMatchObject({ status: "succeeded" });
    expect(await (await dispatch("write_file", "/home/owner/project/out.bin", "file-write", "write")).json()).toMatchObject({ status: "succeeded" });
    const denied = await f.tunnel.fetch(new Request("https://tunnel/exec", { method: "POST", headers: f.headers,
      body: JSON.stringify({ op: "write_file", params: { path: "/home/owner/outside.bin", content: "AQI=", encoding: "base64", create_only: true }, invocation: f.invocation("file-denied") }) }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "tunnel_machine_grant_denied" });
  });

  it("marks a disconnect indeterminate and does not replay a request after DO restart", async () => {
    const f = await fixture();
    const pending = f.tunnel.fetch(f.invoke("request-restart", "task1"));
    await vi.waitFor(() => expect(f.outbox).toHaveLength(1));
    await f.tunnel.webSocketClose(f.socket as never);
    expect(await (await pending).json()).toMatchObject({ status: "indeterminate", error: expect.stringContaining("outcome unknown") });

    // Rehydrate a fresh DO instance over the same persisted storage and reconnect the named machine.
    const replacementSocket = f.makeSocket();
    f.sockets.splice(0, f.sockets.length, replacementSocket);
    const restarted = f.newTunnel();
    const replay = await restarted.fetch(f.invoke("request-restart", "task1"));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ status: "indeterminate" });
    expect(f.outbox).toHaveLength(1); // the uncertain command was never executed twice
  });

  it("waits for a machine cancellation acknowledgment and returns the terminal outcome", async () => {
    const f = await fixture();
    const pending = f.tunnel.fetch(f.invoke("request-cancel", "task1"));
    await vi.waitFor(() => expect(f.outbox).toHaveLength(1));
    const invocation = f.invocation("request-cancel");
    const cancel = await f.tunnel.fetch(new Request("https://tunnel/cancel", { method: "POST", headers: f.headers, body: JSON.stringify({ invocation }) }));
    expect(await cancel.json()).toMatchObject({ result: { status: "indeterminate" } });
    expect(JSON.parse(f.outbox[1]!).type).toBe("cancel");
    const request = JSON.parse(f.outbox[0]!);
    await f.tunnel.webSocketMessage(f.socket as never, JSON.stringify({ type: "response", request_id: request.request_id,
      generation: request.generation, cancelled: true, ok: false }));
    expect(await (await pending).json()).toMatchObject({ status: "cancelled", request_id: "request-cancel" });
  });

  it("enforces the eight-request limit atomically under concurrent dispatch", async () => {
    const f = await fixture();
    const pending = Array.from({ length: 9 }, (_, index) => f.tunnel.fetch(f.invoke(`parallel-${index}`, `task${index % 2 + 1}`)));
    await vi.waitFor(() => expect(f.outbox).toHaveLength(8));
    expect(await f.storage.get("active_requests")).toHaveLength(8);
    const frames = f.outbox.map((text) => JSON.parse(text));
    for (const frame of frames) await f.tunnel.webSocketMessage(f.socket as never, JSON.stringify({
      type: "response", request_id: frame.request_id, generation: frame.generation, ok: true, result: { ok: true },
    }));
    const responses = await Promise.all(pending);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(8);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(await f.storage.get("active_requests")).toEqual([]);
  });

  it("releases timed-out durable active slots after marking the result indeterminate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture();
    const pending = f.tunnel.fetch(f.invoke("request-deadline", "task1"));
    await vi.waitFor(() => expect(f.outbox).toHaveLength(1));
    vi.advanceTimersByTime(60_000);
    await f.tunnel.alarm();
    expect(await f.storage.get("active_requests")).toEqual([]);
    expect((await f.storage.get("tunnel-request:request-deadline") as { status: string }).status).toBe("indeterminate");
    await pending;
    expect(JSON.parse(f.outbox[1]!).type).toBe("cancel");
    vi.useRealTimers();
  });
});
