import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { LocalTunnelDO } from "./LocalTunnelDO.js";

async function fixture() {
  const data = new Map<string, unknown>(), outbox: string[] = [];
  const identity = { tenantId: "tenant", spaceId: "space", machineId: "machine" };
  data.set("machine_identity", identity); data.set("socket_generation", 1);
  const socket = { send: (message: string) => { outbox.push(message); }, close: vi.fn(),
    deserializeAttachment: () => ({ ...identity, generation: 1, keyVersion: 1, expiresAt: Date.now() + 300000, heartbeatAt: Date.now() }) };
  const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key), setAlarm: async () => undefined,
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    transaction: async (fn: (tx: unknown) => unknown) => fn(storage) };
  const machine = { schema: 1, ...identity, name: "machine", ownerId: "owner", status: "active", sequence: 1, keyVersion: 1,
    hardware: { platform: "linux", arch: "x64", cpuCount: 2, memoryBytes: 4096, capabilities: [], models: ["local-model"] },
    grants: [{ id: "grant", actorId: "owner", projectId: "project", expiresAt: Date.now() + 300000, roots: [], commands: ["task1", "task2"], inference: true }] };
  const tunnel = new LocalTunnelDO({ storage, getWebSockets: () => [socket] } as never, {
    PLATFORM_SECRET: "test-secret", SPACES_WORKER: { fetch: async () => Response.json({ machine }) } as never,
  });
  const headers = { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant") };
  const invoke = (requestId: string, command: string) => new Request("https://tunnel/exec", { method: "POST", headers,
    body: JSON.stringify({ op: "exec", params: { command }, invocation: { actorId: "owner", projectId: "project", runId: "run", requestId, deadline: Date.now() + 60000 } }) });
  return { tunnel, socket, outbox, invoke };
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
});
