import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import {
  type DelegationContract,
  issueDelegationContract,
} from "../script-engine/delegation-contract.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

vi.mock("../communications/core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../communications/core.js")>()),
  scopeAccess: vi.fn(async () => true),
}));

describe("task blackboard durable object route", () => {
  it("limits goal activity to the recorded tenant, space and actor", async () => {
    const hash = "a".repeat(64);
    const secret = "test-secret";
    const data = new Map<string, unknown>([
      ["goal-activity:index:run", [hash]],
      [
        `goal-activity:metadata:${hash}`,
        {
          tenantId: "t",
          spaceId: "s",
          actorId: "u",
          tasks: [{ id: "a", title: "Task", dependencies: [] }],
        },
      ],
      [
        `goal-dag:${hash}`,
        {
          verificationRequired: true,
          tasks: {
            a: {
              status: "failed",
              workerId: "w",
              verification: {
                outcome: "failed",
                reason: "Independent evidence rejected.",
              },
            },
          },
          fixers: {
            a: {
              status: "needs_review",
              workerId: "w:fix",
              result: {
                id: "w:fix",
                ok: false,
                output: "private fixer transcript must not be exposed",
              },
            },
          },
        },
      ],
    ]);
    const storage = {
      get: async (key: string) => data.get(key),
      sql: {
        exec: (query: string) => ({
          toArray: () =>
            query.includes("goal_dag_journals")
              ? []
              : [
                  {
                    worker_id: `${hash}:a`,
                    status: "review",
                    attempt: 2,
                    workspace_branch: "private/branch",
                  },
                ],
        }),
      },
    };
    const instance = new NaelaoAgentDO(
      { storage, id: { toString: () => "parent" } } as never,
      { PLATFORM_SECRET: secret } as never
    );
    (instance as unknown as { ensureInit(): void }).ensureInit = () => {};
    const token = await mintInternalToken(secret, "t");
    const get = (actor: string, space: string, internal = token) =>
      instance.fetch(
        new Request(
          `http://agent/internal/goal-activity?run_id=run&space_id=${space}`,
          {
            headers: {
              "x-naelao-tenant-id": "t",
              "x-naelao-user-id": actor,
              "x-naelao-internal-token": internal,
            },
          }
        )
      );
    const ownerResponse = (await (await get("u", "s")).json()) as {
      goals: Array<{
        verificationRequired: boolean;
        tasks: Array<{
          verification?: { outcome: string; reason: string };
          dispatch?: { status: string; attempt?: number };
        }>;
        fixers: Record<string, { status: string }>;
      }>;
    };
    const ownerGoals = ownerResponse.goals;
    expect(ownerGoals).toHaveLength(1);
    expect(ownerGoals[0]).toMatchObject({
      verificationRequired: true,
      tasks: [
        {
          verification: {
            outcome: "failed",
            reason: "Independent evidence rejected.",
          },
          dispatch: { status: "review", attempt: 2 },
        },
      ],
      fixers: { a: { status: "needs_review" } },
    });
    expect(JSON.stringify(ownerResponse)).not.toContain(
      "private fixer transcript must not be exposed"
    );
    expect(JSON.stringify(ownerResponse)).not.toContain("private/branch");
    expect(
      ((await (await get("other", "s")).json()) as { goals: unknown[] }).goals
    ).toHaveLength(0);
    expect(
      ((await (await get("u", "other")).json()) as { goals: unknown[] }).goals
    ).toHaveLength(0);
    expect((await get("u", "s", "invalid")).status).toBe(403);
  });
  it("checks signed task identity and recipient grants before durable message access", async () => {
    const hash = "a".repeat(64);
    const sender = `${hash}:a`;
    const recipient = `${hash}:b`;
    const secret = "test-secret";
    const data = new Map<string, unknown>();
    const transaction = {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => {
        data.set(key, value);
      },
    };
    const storage = {
      get: transaction.get,
      put: transaction.put,
      transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) =>
        fn(transaction),
    };
    data.set(`task-blackboard:scope:${hash}`, {
      tenantId: "t",
      spaceId: "s",
      projectId: "p",
      actorId: "u",
      rootRunId: "root",
      parentDoId: "parent",
      members: [sender, recipient],
      grants: [
        [sender, [recipient]],
        [recipient, []],
      ],
    });
    const instance = new NaelaoAgentDO(
      { storage, id: { toString: () => "parent" } } as never,
      { PLATFORM_SECRET: secret } as never
    );
    (instance as unknown as { ensureInit(): void }).ensureInit = () => {};
    const contract: DelegationContract = {
      tenantId: "t",
      spaceId: "s",
      projectId: "p",
      actorId: "u",
      agentId: "a",
      rootRunId: "root",
      parentRunId: "run",
      parentDoId: "parent",
      workerId: sender,
      depth: 2,
      planner: false,
      maxTokens: 100,
      maxSteps: 1,
      model: "m",
      role: "worker",
      callerRole: "editor",
      maxTier: 1,
      localOnly: false,
    };
    const token = await issueDelegationContract(contract, secret);
    const call = (body: object) =>
      instance.fetch(
        new Request("http://agent/internal/task-blackboard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    const input = {
      id: "msg",
      recipients: [recipient],
      kind: "finding",
      text: "hello",
    };
    expect(
      (await call({ contract, token, action: "publish", input })).status
    ).toBe(200);
    expect(
      (await call({ contract, token, action: "publish", input })).status
    ).toBe(200);
    expect(
      (
        (await (await call({ contract, token, action: "read" })).json()) as {
          messages: unknown[];
        }
      ).messages
    ).toHaveLength(1);
    const recipientContract = { ...contract, workerId: recipient };
    const recipientToken = await issueDelegationContract(
      recipientContract,
      secret
    );
    expect(
      (
        (await (
          await call({
            contract: recipientContract,
            token: recipientToken,
            action: "read",
          })
        ).json()) as { messages: unknown[] }
      ).messages
    ).toHaveLength(1);
    expect(
      (
        await call({
          contract: { ...contract, workerId: recipient },
          token,
          action: "read",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call({
          contract,
          token,
          action: "publish",
          input: { ...input, id: "other", recipients: [sender] },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call({
          contract: { ...contract, rootRunId: "other" },
          token,
          action: "read",
        })
      ).status
    ).toBe(403);
  });

  it("rejects a deterministic adversarial matrix of signed cross-scope identities without storing messages", async () => {
    const hash = "c".repeat(64);
    const secret = "test-secret";
    const sender = `${hash}:worker-a`;
    const recipient = `${hash}:worker-b`;
    const data = new Map<string, unknown>();
    const writes: string[] = [];
    const transaction = {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => {
        writes.push(key);
        data.set(key, value);
      },
    };
    const storage = {
      get: transaction.get,
      put: transaction.put,
      transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) =>
        fn(transaction),
    };
    data.set(`task-blackboard:scope:${hash}`, {
      tenantId: "tenant-a",
      spaceId: "space-a",
      projectId: "project-a",
      actorId: "owner-a",
      rootRunId: "root-a",
      parentDoId: "parent-a",
      members: [sender, recipient],
      grants: [
        [sender, [recipient]],
        [recipient, []],
      ],
    });
    const instance = new NaelaoAgentDO(
      { storage, id: { toString: () => "parent-a" } } as never,
      { PLATFORM_SECRET: secret } as never
    );
    (instance as unknown as { ensureInit(): void }).ensureInit = () => {};
    const base: DelegationContract = {
      tenantId: "tenant-a",
      spaceId: "space-a",
      projectId: "project-a",
      actorId: "owner-a",
      agentId: "assistant-a",
      rootRunId: "root-a",
      parentRunId: "run-a",
      parentDoId: "parent-a",
      workerId: sender,
      depth: 2,
      planner: false,
      maxTokens: 100,
      maxSteps: 1,
      model: "test/local",
      role: "worker",
      callerRole: "editor",
      maxTier: 1,
      localOnly: true,
    };
    const mutations: Array<
      [
        string,
        (contract: DelegationContract, index: number) => DelegationContract,
      ]
    > = [
      ["tenant", (c, i) => ({ ...c, tenantId: `tenant-forged-${i}` })],
      ["space", (c, i) => ({ ...c, spaceId: `space-forged-${i}` })],
      ["project", (c, i) => ({ ...c, projectId: `project-forged-${i}` })],
      ["actor", (c, i) => ({ ...c, actorId: `owner-forged-${i}` })],
      ["goal", (c, i) => ({ ...c, rootRunId: `root-forged-${i}` })],
      ["parent-do", (c, i) => ({ ...c, parentDoId: `parent-forged-${i}` })],
      ["member", (c, i) => ({ ...c, workerId: `${hash}:outsider-${i}` })],
      [
        "other-goal-member",
        (c, i) => ({ ...c, workerId: `${"d".repeat(64)}:worker-${i}` }),
      ],
    ];
    let cases = 0;
    for (const [label, mutate] of mutations) {
      for (let i = 0; i < 8; i++) {
        const contract = mutate(base, i);
        const token = await issueDelegationContract(contract, secret);
        const action = i % 2 === 0 ? "read" : "publish";
        const body =
          action === "read"
            ? { contract, token, action }
            : {
                contract,
                token,
                action,
                input: {
                  id: `${label}-${i}`,
                  recipients: [recipient],
                  kind: "finding",
                  text: "must not persist",
                },
              };
        const response = await instance.fetch(
          new Request("http://agent/internal/task-blackboard", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        );
        expect(response.status, `${label} mutation ${i} should be denied`).toBe(
          403
        );
        expect(await response.text()).not.toContain("must not persist");
        cases++;
      }
    }
    expect(cases).toBe(64);
    expect(data.has(`task-blackboard:messages:${hash}`)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("keeps concurrent retries idempotent and rejects conflicting message-ID reuse", async () => {
    const hash = "e".repeat(64);
    const secret = "test-secret";
    const sender = `${hash}:worker-a`;
    const recipient = `${hash}:worker-b`;
    const data = new Map<string, unknown>();
    const tx = {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => {
        data.set(key, value);
      },
    };
    let tail: Promise<void> = Promise.resolve();
    const storage = {
      get: tx.get,
      put: tx.put,
      transaction: async <T>(
        operation: (transaction: typeof tx) => Promise<T>
      ): Promise<T> => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation(tx);
        } finally {
          release();
        }
      },
    };
    data.set(`task-blackboard:scope:${hash}`, {
      tenantId: "tenant-a",
      spaceId: "space-a",
      projectId: "project-a",
      actorId: "owner-a",
      rootRunId: "root-a",
      parentDoId: "parent-a",
      members: [sender, recipient],
      grants: [
        [sender, [recipient]],
        [recipient, []],
      ],
    });
    const instance = new NaelaoAgentDO(
      { storage, id: { toString: () => "parent-a" } } as never,
      { PLATFORM_SECRET: secret } as never
    );
    (instance as unknown as { ensureInit(): void }).ensureInit = () => {};
    const contract: DelegationContract = {
      tenantId: "tenant-a",
      spaceId: "space-a",
      projectId: "project-a",
      actorId: "owner-a",
      agentId: "assistant-a",
      rootRunId: "root-a",
      parentRunId: "run-a",
      parentDoId: "parent-a",
      workerId: sender,
      depth: 2,
      planner: false,
      maxTokens: 100,
      maxSteps: 1,
      model: "test/local",
      role: "worker",
      callerRole: "editor",
      maxTier: 1,
      localOnly: true,
    };
    const token = await issueDelegationContract(contract, secret);
    const publish = (text: string) =>
      instance.fetch(
        new Request("http://agent/internal/task-blackboard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contract,
            token,
            action: "publish",
            input: {
              id: "same-id",
              recipients: [recipient],
              kind: "finding",
              text,
            },
          }),
        })
      );
    const retries = await Promise.all(
      Array.from({ length: 64 }, () => publish("same payload"))
    );
    expect(retries.every((response) => response.status === 200)).toBe(true);
    expect(data.get(`task-blackboard:messages:${hash}`)).toMatchObject([
      {
        id: "same-id",
        sender,
        recipients: [recipient],
        kind: "finding",
        text: "same payload",
      },
    ]);
    const conflicts = await Promise.all(
      Array.from({ length: 32 }, (_, i) => publish(`different payload ${i}`))
    );
    expect(
      conflicts.filter((response) => response.status === 403)
    ).toHaveLength(32);
    expect(data.get(`task-blackboard:messages:${hash}`)).toMatchObject([
      {
        id: "same-id",
        sender,
        recipients: [recipient],
        kind: "finding",
        text: "same payload",
      },
    ]);
  });
});
