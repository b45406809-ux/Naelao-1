import { describe, expect, it, vi } from "vitest";
import type { DurableWorkflowIdentity, WorkflowCheckpointPointer } from "@naelao/agent-sdk";
import { readWorkflowGrant } from "../workflows/workflow-host.js";
import type { WorkflowJournalRecord } from "../workflows/workflow-state.js";
import { WorkflowRunDO } from "./WorkflowRunDO.js";

function harness() {
  const values = new Map<string, unknown>();
  const artifacts = new Set<string>();
  const alarms: number[] = [];
  let member = true;
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, value); },
    async list({ prefix, limit = 1000 }: { prefix?: string; limit?: number }) { return new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix)).slice(0, limit)); },
    async delete(keys: string[] | string) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    async transaction<T>(callback: (storage: typeof storage) => Promise<T>) { return callback(storage); },
    async setAlarm(value: number) { alarms.push(value); },
    async deleteAlarm() { alarms.push(0); },
  };
  const bucket = {
    async get(key: string) {
      if (!key.startsWith("spaces/space-a/agents/agent-a/")) return null;
      return { size: 7, async text() { return "fixture"; } };
    },
    async list({ prefix }: { prefix: string }) { return { objects: [...artifacts].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 1 })), truncated: false }; },
    async delete(keys: string[]) { for (const key of keys) artifacts.delete(key); },
  };
  const env: Record<string, any> = {
    PLATFORM_SECRET: "workflow-run-test-secret",
    SCRIPTS_R2: bucket,
    SPACES_WORKER: { async fetch() { return Response.json({ data: member ? [{ user_id: "actor-a", role: "owner" }] : [] }); } },
  };
  return {
    instance: new WorkflowRunDO({ storage } as never, env as never),
    env,
    values,
    artifacts,
    alarms,
    revoke() { member = false; },
  };
}

describe("WorkflowRunDO persisted authorization", () => {
  it("persists initialization and rejects resumed work after its membership grant is revoked", async () => {
    const h = harness();
    const identity = {
      schema: 1, runId: "run-a", tenantId: "tenant-a", spaceId: "space-a", actorId: "actor-a", agentId: "agent-a",
      grantVersion: "pending", codeDigest: "a".repeat(64), codeKey: "workflow-code/tenant-a/space-a/code-a",
      startKey: "start-a", expiresAt: Date.now() + 300_000, workflowClass: "ephemeral_task", capabilities: [],
    } as DurableWorkflowIdentity;
    identity.grantVersion = (await readWorkflowGrant(h.env as never, identity)).version;
    const input: WorkflowCheckpointPointer = {
      schema: 1, r2_key: "workflow-artifacts/tenant-a/space-a/run-a/input.json", sha256: "b".repeat(64), bytes: 2,
    };
    await h.instance.initialize(identity, input, {});
    expect((await h.instance.existing())?.status).toBe("queued");
    expect(h.alarms).toEqual([identity.expiresAt]);
    h.revoke();
    await expect(h.instance.authorize("run-a")).rejects.toThrow("workflow_membership_revoked");
    await expect(h.instance.authorize("another-run")).rejects.toThrow("workflow_run_scope_mismatch");
  });

  it("keeps a failed run retryable when budget reservation is unavailable", async () => {
    const h = harness();
    const identity = {
      schema: 1, runId: "run-a", tenantId: "tenant-a", spaceId: "space-a", actorId: "actor-a", agentId: "agent-a",
      grantVersion: "pending", codeDigest: "a".repeat(64), codeKey: "workflow-code/tenant-a/space-a/code-a",
      startKey: "start-a", expiresAt: Date.now() + 300_000, workflowClass: "ephemeral_task", capabilities: [],
    } as DurableWorkflowIdentity;
    identity.grantVersion = (await readWorkflowGrant(h.env as never, identity)).version;
    const input: WorkflowCheckpointPointer = {
      schema: 1, r2_key: "workflow-artifacts/tenant-a/space-a/run-a/input.json", sha256: "b".repeat(64), bytes: 2,
    };
    await h.instance.initialize(identity, input, { budgetCredits: 5 });
    await h.instance.finish("run-a", "failed", "prior failure");
    h.env.AGENT_SCRIPT_WORKFLOW = { async get() { throw new Error("must_not_start_before_reservation"); } };
    h.env.BILLING_WORKER = { async fetch() { return new Response("unavailable", { status: 503 }); } };

    await expect(h.instance.retry("actor-a")).rejects.toThrow("workflow budget reservation failed (503)");
    expect((await h.instance.existing())?.status).toBe("failed");
  });

  it("settles measured workflow usage on failure instead of releasing the whole reservation", async () => {
    const h = harness();
    const identity = {
      schema: 1, runId: "run-a", tenantId: "tenant-a", spaceId: "space-a", actorId: "actor-a", agentId: "agent-a",
      grantVersion: "pending", codeDigest: "a".repeat(64), codeKey: "workflow-code/tenant-a/space-a/code-a",
      startKey: "start-a", reservationId: "reservation-a", expiresAt: Date.now() + 300_000, workflowClass: "ephemeral_task", capabilities: [],
    } as DurableWorkflowIdentity;
    identity.grantVersion = (await readWorkflowGrant(h.env as never, identity)).version;
    await h.instance.initialize(identity, {
      schema: 1, r2_key: "workflow-artifacts/tenant-a/space-a/run-a/input.json", sha256: "b".repeat(64), bytes: 2,
    }, { budgetCredits: 5 });
    const requests: Array<{ path: string; body: unknown }> = [];
    h.env.BILLING_WORKER = { async fetch(request: Request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ ok: true });
    } };

    await h.instance.finish("run-a", "failed", "workflow failed");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: "/internal/workflows/budget/settle", body: { reservation_id: "reservation-a", quantity: 0 } });
  });

  it("settles the reserved ceiling when an in-flight external effect becomes stale and indeterminate", async () => {
    const h = harness();
    const identity = {
      schema: 1, runId: "run-a", tenantId: "tenant-a", spaceId: "space-a", actorId: "actor-a", agentId: "agent-a",
      grantVersion: "pending", codeDigest: "a".repeat(64), codeKey: "workflow-code/tenant-a/space-a/code-a",
      startKey: "start-a", reservationId: "reservation-a", expiresAt: Date.now() + 300_000, workflowClass: "ephemeral_task", capabilities: [],
    } as DurableWorkflowIdentity;
    identity.grantVersion = (await readWorkflowGrant(h.env as never, identity)).version;
    await h.instance.initialize(identity, {
      schema: 1, r2_key: "workflow-artifacts/tenant-a/space-a/run-a/input.json", sha256: "b".repeat(64), bytes: 2,
    }, { budgetCredits: 5 });
    h.values.set("run", { ...(h.values.get("run") as WorkflowJournalRecord), status: "running", activeEffects: ["effect-a"] });
    h.values.set("effect:effect-a", { key: "effect-a", operation: "agent.run", inputDigest: "digest", status: "prepared", startedAt: Date.now() - 120_000 });
    const requests: Array<{ path: string; body: unknown }> = [];
    h.env.BILLING_WORKER = { async fetch(request: Request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ ok: true });
    } };

    await h.instance.finish("run-a", "failed", "workflow failed");
    expect(h.values.get("effect:effect-a")).toMatchObject({ status: "indeterminate" });
    expect(requests[0]).toMatchObject({ path: "/internal/workflows/budget/settle", body: { reservation_id: "reservation-a", quantity: 5 } });
  });

  it("deletes run artifacts at expiry while retaining an expired replay tombstone", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const expiresAt = Date.now() + 100;
      const identity = {
        schema: 1, runId: "run-a", tenantId: "tenant-a", spaceId: "space-a", actorId: "actor-a", agentId: "agent-a",
        grantVersion: "pending", codeDigest: "a".repeat(64), codeKey: "workflow-code/tenant-a/space-a/code-a",
        startKey: "start-a", expiresAt, workflowClass: "ephemeral_task", capabilities: [],
      } as DurableWorkflowIdentity;
      identity.grantVersion = (await readWorkflowGrant(h.env as never, identity)).version;
      const input: WorkflowCheckpointPointer = { schema: 1, r2_key: "workflow-artifacts/tenant-a/space-a/run-a/input.json", sha256: "b".repeat(64), bytes: 2 };
      h.artifacts.add(input.r2_key);
      h.artifacts.add("workflow-artifacts/tenant-a/space-a/run-a/step.json");
      h.values.set("effect:old-step", { key: "old-step", status: "committed" });
      await h.instance.initialize(identity, input, {});
      await vi.advanceTimersByTimeAsync(101);

      await h.instance.alarm();
      expect(h.artifacts.size).toBe(0);
      expect(h.values.has("effect:old-step")).toBe(false);
      expect((await h.instance.existing())?.status).toBe("expired");
      await expect(h.instance.authorize("run-a")).rejects.toThrow("workflow_expired");
    } finally {
      vi.useRealTimers();
    }
  });
});
