import { describe, expect, it, vi } from "vitest";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
import { issueDelegationContract, type DelegationContract } from "../script-engine/delegation-contract.js";

vi.mock("../communications/core.js", async importOriginal => ({ ...await importOriginal<typeof import("../communications/core.js")>(), scopeAccess: vi.fn(async () => true) }));

describe("task blackboard durable object route", () => {
  it("checks signed task identity and recipient grants before durable message access", async () => {
    const hash = "a".repeat(64), sender = `${hash}:a`, recipient = `${hash}:b`, secret = "test-secret";
    const data = new Map<string, unknown>();
    const transaction = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value); } };
    const storage = { get: transaction.get, put: transaction.put, transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction) };
    data.set(`task-blackboard:scope:${hash}`, { tenantId: "t", spaceId: "s", projectId: "p", actorId: "u", rootRunId: "root", parentDoId: "parent", members: [sender, recipient], grants: [[sender, [recipient]], [recipient, []]] });
    const instance = new NaelaoAgentDO({ storage, id: { toString: () => "parent" } } as never, { PLATFORM_SECRET: secret } as never);
    (instance as unknown as { ensureInit(): void }).ensureInit = () => {};
    const contract: DelegationContract = { tenantId: "t", spaceId: "s", projectId: "p", actorId: "u", agentId: "a", rootRunId: "root", parentRunId: "run", parentDoId: "parent", workerId: sender, depth: 2, planner: false, maxTokens: 100, maxSteps: 1, model: "m", role: "worker", callerRole: "editor", maxTier: 1, localOnly: false };
    const token = await issueDelegationContract(contract, secret);
    const call = (body: object) => instance.fetch(new Request("http://agent/internal/task-blackboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const input = { id: "msg", recipients: [recipient], kind: "finding", text: "hello" };
    expect((await call({ contract, token, action: "publish", input })).status).toBe(200);
    expect((await call({ contract, token, action: "publish", input })).status).toBe(200);
    expect((await (await call({ contract, token, action: "read" })).json() as { messages: unknown[] }).messages).toHaveLength(1);
    const recipientContract = { ...contract, workerId: recipient };
    const recipientToken = await issueDelegationContract(recipientContract, secret);
    expect((await (await call({ contract: recipientContract, token: recipientToken, action: "read" })).json() as { messages: unknown[] }).messages).toHaveLength(1);
    expect((await call({ contract: { ...contract, workerId: recipient }, token, action: "read" })).status).toBe(403);
    expect((await call({ contract, token, action: "publish", input: { ...input, id: "other", recipients: [sender] } })).status).toBe(403);
    expect((await call({ contract: { ...contract, rootRunId: "other" }, token, action: "read" })).status).toBe(403);
  });
});
