import { describe, expect, it } from "vitest";
import { appendAuthenticatedTaskMessage, authorizeTaskMessaging, createTaskMessage, readAuthenticatedTaskMessages, visibleTaskMessages, type TaskMessage, type TaskMessageStore } from "./task-blackboard.js";
import { issueDelegationContract, type DelegationContract } from "./delegation-contract.js";

describe("task blackboard message boundaries", () => {
  const members = new Set(["worker:a", "worker:b", "worker:c"]);
  const input = { id: "msg:1", recipients: ["worker:b"], kind: "finding", text: "result" };
  it("limits visibility to sender and selected recipients", () => {
    const message = createTaskMessage(input, "worker:a", members, 123);
    expect(visibleTaskMessages([message], "worker:b", members)).toEqual([message]);
    expect(visibleTaskMessages([message], "worker:c", members)).toEqual([]);
    expect(() => visibleTaskMessages([message], "outside", members)).toThrow("reader_denied");
  });
  it("rejects forged participants, broadcasts and oversized messages", () => {
    expect(() => createTaskMessage(input, "outside", members, 123)).toThrow("sender_denied");
    for (const recipients of [[], ["outside"], ["worker:b", "worker:b"]]) expect(() => createTaskMessage({ ...input, recipients }, "worker:a", members, 123)).toThrow("recipients_invalid");
    expect(() => createTaskMessage({ ...input, text: "x".repeat(4001) }, "worker:a", members, 123)).toThrow("message_invalid");
  });
  it("binds messaging grants to the signed worker, task, tenant, project and parent", () => {
    const identity = { tenantId: "t", spaceId: "s", projectId: "p", rootRunId: "r", parentDoId: "parent", workerId: "worker:a" };
    const scope = { ...identity, members, recipientGrants: new Map([["worker:a", new Set(["worker:b"])]] ) };
    expect(() => authorizeTaskMessaging(identity, scope, ["worker:b"])).not.toThrow();
    for (const change of [{ tenantId: "other" }, { spaceId: "other" }, { projectId: "other" }, { rootRunId: "other" }, { parentDoId: "other" }, { workerId: "outside" }])
      expect(() => authorizeTaskMessaging({ ...identity, ...change }, scope, ["worker:b"])).toThrow("scope_denied");
    expect(() => authorizeTaskMessaging(identity, scope, ["worker:c"])).toThrow("recipient_denied");
  });
  it("verifies signatures and enforces scoped idempotent storage", async () => {
    const contract: DelegationContract = { tenantId: "t", spaceId: "s", projectId: "p", actorId: "u", agentId: "a", rootRunId: "r", parentRunId: "parent-run", parentDoId: "parent", workerId: "worker:a", depth: 2, planner: false, maxTokens: 100, maxSteps: 1, model: "m", role: "worker", callerRole: "editor", maxTier: 1, localOnly: false };
    const secret = "test-host-secret";
    const token = await issueDelegationContract(contract, secret);
    const scope = { ...contract, members, recipientGrants: new Map([["worker:a", new Set(["worker:b"])]] ) };
    let saved: TaskMessage[] = [];
    const store: TaskMessageStore = { async transact(operation) { const update = operation(saved); saved = update.messages; return update.result; } };
    const params = { contract, token, secret, scope, store, input, now: 123 };
    const first = await appendAuthenticatedTaskMessage(params);
    expect(await appendAuthenticatedTaskMessage({ ...params, now: 456 })).toEqual(first);
    expect(saved).toHaveLength(1);
    await expect(appendAuthenticatedTaskMessage({ ...params, input: { ...input, text: "different" } })).rejects.toThrow("id_conflict");
    await expect(appendAuthenticatedTaskMessage({ ...params, contract: { ...contract, workerId: "worker:c" } })).rejects.toThrow();
    await expect(readAuthenticatedTaskMessages({ ...params, scope: { ...scope, rootRunId: "other" } })).rejects.toThrow("scope_denied");
    expect(await readAuthenticatedTaskMessages(params)).toEqual([first]);
  });
});
