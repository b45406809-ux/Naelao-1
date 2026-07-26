// Approvals a human can actually answer.
//
// Before this, "human in the loop" meant the human had ~28 seconds: the gate polled inline and
// then returned `approved: false, reason: "HITL polling timeout"`, which the loop treated as a
// refusal. HITLApprovalDO auto-rejected at 30s to match. An owner who was asleep, at work, or
// simply on another screen could never approve anything, and their absence was reported to the
// user as a rejection — the exact failure mode that makes an "ask before you spend money" agent
// unusable for the business it's supposed to run.
//
// The fix is a third outcome. These tests pin the properties that make it trustworthy: a pending
// approval suspends instead of failing, nothing gated executes while it waits, the work already
// done is carried so it isn't repeated, and a resume doesn't re-ask about the very action that
// was just approved.

import { describe, it, expect } from "vitest";
import { runScriptLoop } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { Reasoner, ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import type { HITLGateway, ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";
function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const meta = new Map<string, Date>();
  const bucket = {
    async put(key: string, value: unknown) {
      const text = typeof value === "string" ? value : String(value);
      store.set(key, text);
      meta.set(key, new Date());
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return {
        size: text.length,
        uploaded: meta.get(key) ?? new Date(),
        async text() {
          return text;
        },
        get body() {
          return text;
        },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
        meta.delete(k);
      }
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ key: k, size: store.get(k)!.length, uploaded: meta.get(k) ?? new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}


function makeEnv(): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" };
}

/** A gateway that never gets an answer in time — the normal case for a real human. */
function pendingGateway(): { asked: string[]; gateway: HITLGateway } {
  const asked: string[] = [];
  return {
    asked,
    gateway: {
      async requestApproval(params) {
        asked.push(params.actionName);
        return { approvalId: "appr-1", approved: false, pending: true, expiresAt: 1_800_000_000_000 };
      },
    },
  };
}

/** A gateway where a human said no. Distinct from nobody answering. */
function rejectingGateway(): { asked: string[]; gateway: HITLGateway } {
  const asked: string[] = [];
  return {
    asked,
    gateway: {
      async requestApproval(params) {
        asked.push(params.actionName);
        return { approvalId: "appr-2", approved: false, reason: "too expensive" };
      },
    },
  };
}

describe("a pending approval suspends the run rather than failing it", () => {
  it("returns pending_approval, not an error result", async () => {
    const env = makeEnv();
    const { gateway } = pendingGateway();
    env.hitlGateway = gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return { action: "run", name: "write_file", params: { path: "a.txt", content: "x" } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
    });

    expect(result.pending_approval).toBeDefined();
    expect(result.pending_approval!.approval_id).toBe("appr-1");
    expect(result.pending_approval!.action_name).toBe("write_file");
    // Not an error. Rendering a waiting run as a failure is what made approvals look broken.
    expect(result.result).toBeUndefined();
  });

  it("does not execute the gated action while it waits", async () => {
    // The property that makes replay-on-resume safe at all: at the moment of suspension the
    // dangerous action has not happened.
    const env = makeEnv();
    env.hitlGateway = pendingGateway().gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);

    await runScriptLoop(env, tools, { async decide(): Promise<ReasonDecision> {
      return { action: "run", name: "write_file", params: { path: "gated.txt", content: "x" } };
    } }, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
    });

    // Asserted against the real store rather than a spy: what matters is that the side effect
    // did not happen, not that a particular function wasn't called.
    const listed = await env.scriptsBucket.list({ prefix: "spaces/space-1/" });
    expect(listed.objects.map((o) => o.key).some((k) => k.includes("gated.txt"))).toBe(false);
  });

  it("still fails the action when a human actually says no", async () => {
    // Suspension must not swallow a real refusal — "nobody answered" and "someone declined" are
    // different answers and only one of them should ever be retried.
    const env = makeEnv();
    env.hitlGateway = rejectingGateway().gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);

    const result = await runScriptLoop(env, tools, { async decide(): Promise<ReasonDecision> {
      return { action: "run", name: "write_file", params: { path: "a.txt", content: "x" } };
    } }, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
    });

    expect(result.pending_approval).toBeUndefined();
    expect(result.result?.ok).toBe(false);
    expect(String(result.result?.error)).toContain("needed approval");
  });

  it("carries the work already done so a resume doesn't repeat it", async () => {
    const env = makeEnv();
    env.hitlGateway = pendingGateway().gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let step = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        // First an ungated read, then the gated write that suspends.
        return step++ === 0
          ? { action: "run", name: "list_files", params: {} }
          : { action: "run", name: "write_file", params: { path: "a.txt", content: "x" } };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "list then write",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: ["list_files"], // pre-approved; write_file is not
      approvalMode: "gate_unless_listed",
    });

    expect(result.pending_approval).toBeDefined();
    const done = result.pending_approval!.steps_completed;
    expect(done.map((s) => s.name)).toContain("list_files");
    // The gated action is never in the completed list — it hadn't run.
    expect(done.map((s) => s.name)).not.toContain("write_file");
  });
});

describe("resuming after a human approves", () => {
  it("does not re-ask about the action that was just approved", async () => {
    // Without this, every resume would open a brand new approval request for the very action a
    // human had already approved, and no gated action could ever actually run.
    const env = makeEnv();
    const { asked, gateway } = pendingGateway();
    env.hitlGateway = gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let step = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        return step++ === 0
          ? { action: "run", name: "write_file", params: { path: "a.txt", content: "x" } }
          : { action: "answer", text: "Wrote a.txt." };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
      preApprovedActions: ["write_file"],
    });

    expect(asked).toEqual([]);
    expect(result.pending_approval).toBeUndefined();
    expect(result.result?.ok).toBe(true);
  });

  it("hands the suspended pass's steps back to the model as work already done", async () => {
    const env = makeEnv();
    env.hitlGateway = pendingGateway().gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let seenPriorSteps: unknown[] | undefined;
    const reasoner: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        seenPriorSteps = (input as { priorSteps?: unknown[] }).priorSteps;
        return { action: "answer", text: "done" };
      },
    };

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "finish the job",
      startupObserve: "observe_filesystem",
      preApprovedActions: ["write_file"],
      resumeSteps: [{ name: "list_files", params: {}, ok: true, output: ["a.txt"] }],
    });

    expect(seenPriorSteps).toBeDefined();
    expect((seenPriorSteps as Array<{ name: string }>)[0]!.name).toBe("list_files");
  });
});
