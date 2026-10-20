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
import { approvalPolicyFingerprint, runScriptLoop, stableStringify } from "../../workers/agents/src/script-engine/loop.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { Reasoner, ReasonDecision } from "../../workers/agents/src/script-engine/loop.js";
import type { HITLGateway, ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";
function makeR2(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; etag: string; customMetadata: Record<string, string>; uploaded: Date }>();
  let revision = 0;
  const bucket = {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const previous = store.get(key);
      const onlyIf = options?.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string } | undefined;
      if (onlyIf?.etagMatches !== undefined && previous?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && previous) return null;
      const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === "string" ? value : String(value));
      const etag = String(++revision);
      store.set(key, { bytes: bytes.slice(), etag, customMetadata: options?.customMetadata ?? {}, uploaded: new Date() });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item || item.customMetadata["deleted"] === "true") return null;
      return {
        size: item.bytes.byteLength,
        etag: item.etag,
        uploaded: item.uploaded,
        customMetadata: item.customMetadata,
        async text() { return new TextDecoder().decode(item.bytes); },
        async arrayBuffer() { return item.bytes.slice().buffer; },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const item = store.get(key);
      return item ? { key, size: item.bytes.byteLength, etag: item.etag, uploaded: item.uploaded, customMetadata: item.customMetadata } as R2Object : null;
    },
    async delete(key: string | string[]) {
      for (const item of Array.isArray(key) ? key : [key]) store.delete(item);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const objects = [...store.entries()].filter(([key, item]) => key.startsWith(prefix) && item.customMetadata["deleted"] !== "true").map(([key, item]) => ({ key, size: item.bytes.byteLength, etag: item.etag, uploaded: item.uploaded, customMetadata: item.customMetadata }));
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

describe("a pending approval never fails the run", () => {
  it("parks the gated action and carries on with the rest of the task", async () => {
    // Blocking here is what made an agent useless the moment it needed permission for one thing:
    // an assistant with five jobs would stop dead on the one needing a signature and stay stopped
    // until somebody happened to look.
    const env = makeEnv();
    const { gateway } = pendingGateway();
    env.hitlGateway = gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let step = 0;
    const reasoner: Reasoner = {
      async decide(): Promise<ReasonDecision> {
        // Asks for the gated write first, then does something else, then answers.
        if (step++ === 0) return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
        if (step === 2) return { action: "run", name: "list_files", params: {} };
        return { action: "answer", text: "Listed the files; the write is waiting on you." };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file and list them",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: ["list_files"], // pre-approved; write_file is not
      approvalMode: "gate_unless_listed",
    });

    // A real answer AND outstanding work — not a failure, and not a silent drop.
    expect(result.deferred_approvals).toHaveLength(1);
    expect(result.deferred_approvals![0]!.action_name).toBe("write_file");
    expect(result.deferred_approvals![0]!.approval_id).toBe("appr-1");
    expect(result.result?.ok).toBe(true);
    expect(String(result.result?.output)).toContain("waiting on you");

    // A live UI bug: a parked action's "gate" trace step used to close the activity feed's
    // running segment with no row for the action it described (no `params` carried, and the
    // renderer treated any "gate" step as a segment-closer) — the person saw the model's own
    // "doing" status for write_file with no table underneath it. The trace itself is what the
    // frontend renders from, so pin it here: the gate step names the parked action AND carries
    // its params, which is what lets the UI render it as a row instead of orphaning it.
    const gateStep = result.trace.find((s) => s.phase === "gate" && s.name === "write_file");
    expect(gateStep).toBeDefined();
    expect(gateStep!.detail).toBe("deferred_pending_approval");
    expect(gateStep!.params).toEqual({ path: "a.txt", content: "x", expectedHash: null });
  });

  it("opens exactly one request even if the model asks for the same action again", async () => {
    // And it must never be told the parked action "already ran": it was added to the attempted
    // set but never executed, so the repeat guard would otherwise report a gated action as done.
    const env = makeEnv();
    const { asked, gateway } = pendingGateway();
    env.hitlGateway = gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    let seenSteps: Array<{ name: string; ok: boolean; output?: unknown; error?: string }> = [];
    let step = 0;
    const reasoner: Reasoner = {
      async decide(input): Promise<ReasonDecision> {
        seenSteps = ((input as { priorSteps?: typeof seenSteps }).priorSteps ?? []) as typeof seenSteps;
        if (step++ < 2) return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
        return { action: "answer", text: "done what I could" };
      },
    };

    await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
    });

    expect(asked).toEqual(["write_file"]); // asked once, not twice
    const writeStep = seenSteps.find((s) => s.name === "write_file");
    expect(writeStep?.ok).toBe(false);
    expect(String(writeStep?.error)).toContain("waiting on a human");
  });

  it("does not execute the gated action while it waits", async () => {
    // The property that makes replay-on-resume safe at all: at the moment of suspension the
    // dangerous action has not happened.
    const env = makeEnv();
    env.hitlGateway = pendingGateway().gateway;
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);

    await runScriptLoop(env, tools, { async decide(): Promise<ReasonDecision> {
      return { action: "run", name: "write_file", params: { path: "gated.txt", content: "x", expectedHash: null } };
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
      return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
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
        // An ungated read, then the gated write, then an answer around it.
        if (step++ === 0) return { action: "run", name: "list_files", params: {} };
        if (step === 2) return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } };
        return { action: "answer", text: "listed them; write is pending" };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "list then write",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: ["list_files"], // pre-approved; write_file is not
      approvalMode: "gate_unless_listed",
    });

    const done = result.deferred_approvals![0]!.steps_completed;
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
          ? { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } }
          : { action: "answer", text: "Wrote a.txt." };
      },
    };

    const result = await runScriptLoop(env, tools, reasoner, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
      preApprovedActions: [{ actionName: "write_file", actionInputJson: stableStringify({ path: "a.txt", content: "x", expectedHash: null }), approvalPolicyFingerprint: approvalPolicyFingerprint("gate_unless_listed", []) }],
    });

    expect(asked).toEqual([]);
    expect(result.pending_approval).toBeUndefined();
    expect(result.result?.ok).toBe(true);
  });

  it("requires a fresh approval when the model changes the approved arguments", async () => {
    const env = makeEnv();
    const requestedInputs: Array<Record<string, unknown>> = [];
    env.hitlGateway = {
      async requestApproval(params) {
        requestedInputs.push(params.actionInput);
        return { approvalId: "fresh-approval", approved: false, pending: true };
      },
    };
    const tools = new ScriptToolSurface(env, ["r2-workspace"]);
    const result = await runScriptLoop(env, tools, { async decide(): Promise<ReasonDecision> {
      return { action: "run", name: "write_file", params: { path: "a.txt", content: "changed after approval", expectedHash: null } };
    } }, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
      preApprovedActions: [{ actionName: "write_file", actionInputJson: stableStringify({ path: "a.txt", content: "approved content", expectedHash: null }), approvalPolicyFingerprint: approvalPolicyFingerprint("gate_unless_listed", []) }],
    });

    expect(requestedInputs).toEqual([{ path: "a.txt", content: "changed after approval", expectedHash: null }]);
    expect(result.deferred_approvals?.[0]?.params).toEqual({ path: "a.txt", content: "changed after approval", expectedHash: null });
    const listed = await env.scriptsBucket.list({ prefix: "spaces/space-1/" });
    expect(listed.objects.some((object) => object.key.includes("a.txt"))).toBe(false);
  });

  it("requires a fresh approval when the effective approval policy changed", async () => {
    const env = makeEnv();
    let approvalCount = 0;
    env.hitlGateway = { async requestApproval() {
      approvalCount++;
      return { approvalId: "policy-approval", approved: false, pending: true };
    } };
    const result = await runScriptLoop(env, new ScriptToolSurface(env, ["r2-workspace"]), {
      async decide(): Promise<ReasonDecision> { return { action: "run", name: "write_file", params: { path: "a.txt", content: "x", expectedHash: null } }; },
    }, ["r2-workspace"], {
      goal: "write a file",
      startupObserve: "observe_filesystem",
      requiresApprovalFor: [],
      approvalMode: "gate_unless_listed",
      preApprovedActions: [{ actionName: "write_file", actionInputJson: stableStringify({ path: "a.txt", content: "x", expectedHash: null }), approvalPolicyFingerprint: approvalPolicyFingerprint("gate_listed", ["write_file"]) }],
    });
    expect(approvalCount).toBe(1);
    expect(result.deferred_approvals?.[0]?.action_name).toBe("write_file");
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
      resumeSteps: [{ name: "list_files", params: {}, ok: true, output: ["a.txt"] }],
    });

    expect(seenPriorSteps).toBeDefined();
    expect((seenPriorSteps as Array<{ name: string }>)[0]!.name).toBe("list_files");
  });
});
