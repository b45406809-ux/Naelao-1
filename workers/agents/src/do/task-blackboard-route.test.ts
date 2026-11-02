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

  it("preserves seeded tenant, project, and recipient grants during concurrent cross-tenant traffic", async () => {
    const secret = "test-secret";
    const parentDoId = "parent-multi-tenant";
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
    const instance = new NaelaoAgentDO(
      { storage, id: { toString: () => parentDoId } } as never,
      { PLATFORM_SECRET: secret } as never
    );
    (instance as unknown as { ensureInit(): void }).ensureInit = () => {};

    let seed = 0x51ace;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const tenants = await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        const hash = (index + 1).toString(16).padStart(64, "0");
        const sender = `${hash}:sender`;
        const recipient = `${hash}:recipient`;
        const tenantId = `tenant-${index}`;
        const spaceId = `space-${Math.floor(random() * 4)}`;
        const projectId = `project-${Math.floor(random() * 5)}`;
        const actorId = `owner-${index}`;
        const rootRunId = `root-${index}`;
        const allowed = random() >= 0.5;
        data.set(`task-blackboard:scope:${hash}`, {
          tenantId,
          spaceId,
          projectId,
          actorId,
          rootRunId,
          parentDoId,
          members: [sender, recipient],
          grants: [
            [sender, allowed ? [recipient] : []],
            [recipient, []],
          ],
        });
        const contract: DelegationContract = {
          tenantId,
          spaceId,
          projectId,
          actorId,
          agentId: `project-assistant-${index}`,
          rootRunId,
          parentRunId: `run-${index}`,
          parentDoId,
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
        return {
          hash,
          sender,
          recipient,
          allowed,
          contract,
          token: await issueDelegationContract(contract, secret),
          text: `private-tenant-${index}`,
        };
      })
    );

    const request = (
      contract: DelegationContract,
      token: string,
      action: "read" | "publish",
      input?: Record<string, unknown>
    ) =>
      instance.fetch(
        new Request("http://agent/internal/task-blackboard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contract,
            token,
            action,
            ...(input ? { input } : {}),
          }),
        })
      );

    const writes = await Promise.all(
      tenants.map((tenant) =>
        request(tenant.contract, tenant.token, "publish", {
          id: `message-${tenant.hash}`,
          recipients: [tenant.recipient],
          kind: "finding",
          text: tenant.text,
        })
      )
    );
    for (const [index, response] of writes.entries()) {
      const tenant = tenants[index];
      if (!tenant) throw new Error(`tenant fixture missing at ${index}`);
      expect(response.status, `tenant ${index} grant result`).toBe(
        tenant.allowed ? 200 : 403
      );
    }

    const reads = await Promise.all(
      tenants.map(async (tenant) => {
        const recipientContract = {
          ...tenant.contract,
          workerId: tenant.recipient,
        };
        const recipientToken = await issueDelegationContract(
          recipientContract,
          secret
        );
        return request(recipientContract, recipientToken, "read");
      })
    );
    for (const [index, response] of reads.entries()) {
      const tenant = tenants[index];
      if (!tenant) throw new Error(`tenant fixture missing at ${index}`);
      const payload = (await response.json()) as {
        messages: Array<{ text: string }>;
      };
      expect(response.status).toBe(200);
      expect(payload.messages.map((message) => message.text)).toEqual(
        tenant.allowed ? [tenant.text] : []
      );
      for (const [otherIndex, tenant] of tenants.entries())
        if (otherIndex !== index)
          expect(
            payload.messages.some((message) => message.text === tenant.text)
          ).toBe(false);
    }

    const crossTenant = await Promise.all(
      tenants.map(async (tenant, index) => {
        const other = tenants[(index + 1) % tenants.length];
        if (!other) throw new Error(`cross-tenant fixture missing at ${index}`);
        const forged = { ...tenant.contract, workerId: other.sender };
        return request(
          forged,
          await issueDelegationContract(forged, secret),
          "read"
        );
      })
    );
    expect(crossTenant.every((response) => response.status === 403)).toBe(true);
    for (const tenant of tenants) {
      const messages = data.get(`task-blackboard:messages:${tenant.hash}`) as
        | Array<{ text: string }>
        | undefined;
      expect((messages ?? []).map((message) => message.text)).toEqual(
        tenant.allowed ? [tenant.text] : []
      );
    }
  });
});
