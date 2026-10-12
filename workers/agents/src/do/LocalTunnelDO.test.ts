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
  const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key), setAlarm: async () => undefined,
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    transaction: async (fn: (tx: unknown) => unknown) => fn(storage) };
  const machine = { schema: 1, ...identity, name: "machine", ownerId: "owner", status: "active", sequence: 1, keyVersion: 1,
    hardware: { platform: "linux", arch: "x64", cpuCount: 2, memoryBytes: 4096, capabilities: [], models: ["local-model"] },
    grants: [{ id: "grant", actorId: "owner", projectId: "project", expiresAt: Date.now() + 300000, roots: [], commands: ["task1", "task2"], inference: true }] };
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
  it("rejects non-TLS remote tunnel upgrades", async () => {
    const f = await fixture();
    const response = await f.tunnel.fetch(new Request("http://agents.example.test/connect", { headers: { Upgrade: "websocket" } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "tunnel_secure_upgrade_required" });
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
});
