import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { machineProofBytes, verifyMachineProof, tunnelHash, type NamedMachine, type MachineProof } from "../../packages/agent-sdk/src/tunnel-protocol.js";
import { TunnelRequestJournal, type TunnelRequestRecord } from "../../workers/agents/src/tunnels/request-journal.js";
import { LocalTunnelDO } from "../../workers/agents/src/do/LocalTunnelDO.js";
import { mintInternalToken } from "@naelao/http";
import { interceptPlatformCli } from "../../workers/agents/src/script-engine/virtual-cli.js";

class MemoryStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix }: { prefix: string }) { return new Map([...this.data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; }
  async setAlarm(_time: number) {}
  async transaction<T>(fn: (tx: MemoryStorage) => Promise<T>) { return fn(this); }
}
function machine(name: string): NamedMachine {
  return { schema: 1, tenantId: "tenant", spaceId: "space", machineId: name, name, ownerId: "person",
    publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }), sequence: 1, keyVersion: 1, status: "active",
    hardware: { platform: "linux", arch: "x64", cpuCount: 2, memoryBytes: 4096, capabilities: ["storage:folder"], models: ["local-test"] },
    grants: [{ id: "grant", actorId: "person", projectId: "project", expiresAt: Date.now() + 60000, roots: [{ path: "/approved", access: "read" }], commands: ["printf hello"], inference: true }],
    createdAt: Date.now(), updatedAt: Date.now() };
}
function record(overrides: Partial<TunnelRequestRecord> = {}): TunnelRequestRecord {
  return { id: "request-one", tenantId: "tenant", spaceId: "space", machineId: "machine-one", actorId: "person", projectId: "project", runId: "run",
    operation: "exec", payloadHash: "a".repeat(64), generation: 1, deadline: Date.now() + 60000, status: "sent", nextOutputSequence: 0, outputBytes: 0,
    stdout: "", stderr: "", createdAt: Date.now(), updatedAt: Date.now(), ...overrides };
}
async function connected(name: string) {
  const value = machine(name), storage = new MemoryStorage(), secret = "test-only-platform-secret";
  let object: LocalTunnelDO;
  const sent: Array<Record<string, unknown>> = [];
  type Attachment = { tenantId: string; spaceId: string; machineId: string; generation: number; keyVersion: number; expiresAt: number; heartbeatAt: number };
  const socket = {
    attachment: { tenantId: value.tenantId, spaceId: value.spaceId, machineId: value.machineId, generation: 1, keyVersion: 1, expiresAt: Date.now() + 300000, heartbeatAt: Date.now() },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(next: Attachment) { this.attachment = next; },
    close() {},
    send(text: string) {
      const frame = JSON.parse(text); sent.push(frame);
      if (frame.type === "request") queueMicrotask(() => { void object.webSocketMessage(socket as never, JSON.stringify({ type: "response", generation: frame.generation, request_id: frame.request_id, ok: true, result: { machine: value.name } })); });
    },
  };
  const sockets = [socket];
  const ctx = { storage, getWebSockets: () => sockets };
  const env = { PLATFORM_SECRET: secret, SPACES_WORKER: { fetch: async () => Response.json({ machine: value }) } };
  await storage.put("machine_identity", { tenantId: value.tenantId, spaceId: value.spaceId, machineId: value.machineId });
  await storage.put("socket_generation", 1);
  object = new LocalTunnelDO(ctx as never, env as never);
  const headers = { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(secret, "tenant") };
  const invoke = (id: string, command = "printf hello") => new Request("https://tunnel/exec", { method: "POST", headers,
    body: JSON.stringify({ op: "exec", params: { command }, invocation: { actorId: "person", projectId: "project", runId: "run", requestId: id, deadline: Date.now() + 60000 } }) });
  return { value, storage, ctx, env, socket, sockets, sent, invoke, get object() { return object; }, restart() { object = new LocalTunnelDO(ctx as never, env as never); } };
}
describe("named multi-machine tunnel mesh", () => {
  it("verifies Ed25519 identity and rejects forged, replayed, stale and cross-space proofs", async () => {
    const pair = generateKeyPairSync("ed25519"), value = machine("machine-one");
    value.publicKey = pair.publicKey.export({ format: "jwk" });
    const proof: MachineProof = { schema: 1, tenantId: value.tenantId, spaceId: value.spaceId, machineId: value.machineId, keyVersion: 1, sequence: 2,
      issuedAt: Date.now(), nonce: "b".repeat(64), operation: "connect", dataHash: await tunnelHash("{}") };
    const signature = sign(null, machineProofBytes(proof), pair.privateKey).toString("base64url");
    expect(await verifyMachineProof(value, proof, signature)).toBe(true);
    expect(await verifyMachineProof(value, { ...proof, spaceId: "other-space" }, signature)).toBe(false);
    expect(await verifyMachineProof({ ...value, sequence: 2 }, proof, signature)).toBe(false);
    expect(await verifyMachineProof(value, proof, signature, Date.now() + 31000)).toBe(false);
    expect(await verifyMachineProof({ ...value, status: "revoked" }, proof, signature)).toBe(false);
    expect(await verifyMachineProof(value, proof, "x".repeat(86))).toBe(false);
  });
  it("addresses two machines independently; replay after host restart returns the saved outcome", async () => {
    const one = await connected("machine-one"), two = await connected("machine-two");
    expect((await (await one.object.fetch(one.invoke("one-request"))).json()).result.machine).toBe("machine-one");
    expect((await (await two.object.fetch(two.invoke("two-request"))).json()).result.machine).toBe("machine-two");
    one.restart();
    expect((await (await one.object.fetch(one.invoke("one-request"))).json()).result.machine).toBe("machine-one");
    expect(one.sent.filter(frame => frame.type === "request")).toHaveLength(1);
    one.value.status = "revoked";
    expect((await one.object.fetch(one.invoke("revoked-request"))).status).toBe(403);
    expect((await two.object.fetch(two.invoke("two-after-revocation"))).status).toBe(200);
  });
  it("marks disconnection indeterminate and reconciles a receipt without resending its command", async () => {
    const fixture = await connected("machine-one"), journal = new TunnelRequestJournal(fixture.storage);
    const saved = record({ payloadHash: await tunnelHash(JSON.stringify(["exec", { command: "printf hello" }])) });
    await journal.prepare(saved); await fixture.storage.put("active_requests", [saved.id]);
    await fixture.object.webSocketClose(fixture.socket as never);
    expect((await journal.get(saved.id))?.status).toBe("indeterminate");
    fixture.value.sequence = 2; fixture.socket.attachment.generation = 2; await fixture.storage.put("socket_generation", 2);
    fixture.restart();
    expect((await fixture.object.fetch(fixture.invoke(saved.id))).status).toBe(409);
    expect(fixture.sent.filter(frame => frame.type === "request")).toHaveLength(0);
    await fixture.object.webSocketMessage(fixture.socket as never, JSON.stringify({ type: "reconcile", generation: 2, original_generation: 1,
      request_id: saved.id, payload_hash: saved.payloadHash, status: "succeeded", result: "saved terminal outcome" }));
    expect((await journal.get(saved.id))?.result).toBe("saved terminal outcome");
    await expect(journal.update(saved.id, 2, { status: "failed" })).rejects.toThrow("stale");
  });
  it("bounds output, protects owner/payload identity and requires ordered chunks", async () => {
    const storage = new MemoryStorage(), journal = new TunnelRequestJournal(storage), saved = record();
    await journal.prepare(saved);
    await journal.output(saved.id, 1, 0, "stdout", "hello");
    await journal.output(saved.id, 1, 0, "stdout", "hello");
    expect((await journal.get(saved.id))?.stdout).toBe("hello");
    await expect(journal.prepare({ ...saved, actorId: "other-person" })).rejects.toThrow("conflict");
    await expect(journal.output(saved.id, 1, 3, "stdout", "gap")).rejects.toThrow("sequence");
    await expect(journal.output(saved.id, 1, 1, "stdout", "x".repeat(17000))).rejects.toThrow("limit");
    await expect(journal.update(saved.id, 2, { status: "succeeded" })).rejects.toThrow("stale");
  });
  it("parses explicit machine commands and never supplies a hidden target", () => {
    expect(interceptPlatformCli("naelao tunnel list")).toEqual({ operation: "tunnel.list", params: { machine: undefined } });
    expect(interceptPlatformCli("naelao tunnel exec machine-one --command 'printf hello'")?.params).toEqual({ machine: "machine-one", command: "printf hello" });
    expect(() => interceptPlatformCli("naelao tunnel exec --command 'printf hello'")).toThrow("explicit");
    expect(interceptPlatformCli("naelao tunnel cancel machine-one --request-id pending")?.operation).toBe("tunnel.cancel");
  });
});
