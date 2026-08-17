import { describe, it, expect, beforeEach } from "vitest";
import { SkillLibrary } from "../../workers/agents/src/script-engine/skill-library.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

/**
 * Regression cover for a real production failure on the UNATTENDED proactive path.
 *
 * The scheduled wake-up fired correctly, the reasoner ran, and the model chose to run a script
 * it named `"notifications prebuilt"` — the prebuilt's descriptive phrase rather than one of its
 * actual operation names (`notify.email`, ...). `SkillLibrary.read()` asserted the name was a
 * safe path segment and THREW, which escaped `ScriptToolSurface.run()`'s per-step error handling
 * and killed the entire run: `{"error":"Invalid script name: \"notifications prebuilt\""}`,
 * recorded as `consecutive_failures: 1` on the job with nobody watching.
 *
 * A model getting a name wrong must be a step it can observe and correct, never a fatal error.
 */

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const touched: string[] = [];
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      touched.push(key);
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { async text() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      touched.push(key);
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false } as unknown as R2Objects;
    },
    __touched: touched,
  };
  return bucket as unknown as R2Bucket;
}

function makeEnv(bucket: R2Bucket): ScriptEngineEnv {
  return { scriptsBucket: bucket, spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1" };
}

describe("a model naming a script wrong is recoverable, not fatal", () => {
  let bucket: R2Bucket;
  let env: ScriptEngineEnv;

  beforeEach(() => {
    bucket = makeR2();
    env = makeEnv(bucket);
  });

  it("returns a failed step (never throws) for the exact name that killed a live run", async () => {
    const tools = new ScriptToolSurface(env, ["notifications"]);

    // The assertion that matters: this resolves rather than rejecting.
    const res = await tools.run("notifications prebuilt", {});

    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown script or operation");
  });

  it("names real operations so the next turn can correct itself", async () => {
    const tools = new ScriptToolSurface(env, ["notifications"]);
    const res = await tools.run("notifications prebuilt", {});

    // `notifications` owns ops prefixed `notify.` — matching op names alone would suggest
    // nothing here, which is precisely the case the suggester exists for.
    expect(res.error).toContain("Did you mean");
    expect(res.error).toContain("notify.email");
  });

  it("stays silent when nothing plausibly matches, rather than suggesting noise", async () => {
    const tools = new ScriptToolSurface(env, ["notifications"]);
    const res = await tools.run("zzzz_unrelated_thing", {});

    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown script or operation");
    expect(res.error).not.toContain("Did you mean");
  });

  it("a traversal attempt reports not-found and never reaches the bucket", async () => {
    const lib = new SkillLibrary(bucket, "space-1");
    const touched = (bucket as unknown as { __touched: string[] }).__touched;
    touched.length = 0;

    await expect(lib.read("../../../etc/passwd")).resolves.toBeNull();
    await expect(lib.exists("../../../etc/passwd")).resolves.toBe(false);

    // Path safety is the whole point of the guard — relaxing the throw must not relax this.
    expect(touched).toHaveLength(0);
  });

  // Live-reported, second time, and the exact literal string from that trace: dispatched through
  // the reasoner this now resolves directly (reasoner.ts's stripNamespacePrefix) and never reaches
  // this suggester at all — but ScriptToolSurface.run() itself is deliberately left strict (see
  // stripNamespacePrefix's own doc on why normalization must happen upstream of the HITL gate),
  // so calling it directly with the raw guess, as this test does, still exercises the exact path
  // that failed live. Confirmed to reproduce the OLD "Did you mean" list byte-for-byte
  // (thread.create, thread.delete, thread.list, thread.read, thread.rename, thread.search — the
  // literal 6 the live run showed) before this fix, with thread.send_message and agent.consult
  // both silently excluded by the old alphabetical-tie-break + cap-6: every op in
  // "project-coordination" scored identically from matching the script-name tokens alone, and
  // "send_message" simply sorted last among the tied group.
  it("suggests the real answer for a namespaced guess, not just its same-scored siblings", async () => {
    const tools = new ScriptToolSurface(env, ["project-coordination"]);
    const res = await tools.run("project-coordination:thread.create", {});

    expect(res.ok).toBe(false);
    expect(res.error).toContain("Did you mean");
    expect(res.error).toContain("thread.send_message");
    expect(res.error).toContain("thread.consult");
  });

  it("still throws on a bad name for WRITE paths, where it is a bug or an attack", async () => {
    const lib = new SkillLibrary(bucket, "space-1");

    await expect(
      lib.create({
        name: "../escape",
        code: "x",
        metadata: { description: "d", domain: "compute", requires_tier: 2 },
      })
    ).rejects.toThrow(/Invalid script name/);

    await expect(lib.delete("../escape")).rejects.toThrow(/Invalid script name/);
  });
});

/**
 * A model addressing an operation THROUGH its owning script — both spellings seen live in one
 * unattended run, each costing a wasted reasoning turn on a self-correction the platform can do.
 *
 * The narrowness is the safety property: a prefix is only stripped when the script exists AND the
 * remainder is an operation that script owns, so this can never conjure an action that wasn't
 * already callable.
 */
describe("script-qualified operation names resolve to the real op", () => {
  it("resolves '<script>.<op>' — the exact live failure", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin"]);
    expect(tools.resolveOperationAlias("workspace-admin.project.list", {}))
      .toEqual({ name: "project.list", params: {} });
  });

  it("resolves '<script>:<op>' the same way", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin"]);
    expect(tools.resolveOperationAlias("workspace-admin:project.list", {}).name).toBe("project.list");
  });

  it("resolves a bare script name whose operation was moved into params", () => {
    // Live: business-diagnostics with params {operation: "diagnostics.overview"}.
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["business-diagnostics"]);
    expect(tools.resolveOperationAlias("business-diagnostics", { operation: "diagnostics.overview", window_hours: 24 }))
      .toEqual({ name: "diagnostics.overview", params: { window_hours: 24 } });
  });

  it("leaves a real operation name completely alone", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin"]);
    expect(tools.resolveOperationAlias("project.list", { a: 1 })).toEqual({ name: "project.list", params: { a: 1 } });
  });

  it("a RENAMED operation still answers to its old name, so stored R2 skills survive the rename", () => {
    // `agent.consult` became `thread.consult` so every thread-scoped operation is namespaced the
    // same way. Learned skills are stored code in R2 that a deploy cannot rewrite — without this
    // alias, a business whose skill library already calls the old name breaks on next use.
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["project-coordination"]);
    expect(tools.resolveOperationAlias("agent.consult", { agent_id: "a1", message: "hi" }))
      .toEqual({ name: "thread.consult", params: { agent_id: "a1", message: "hi" } });
  });

  it("the old name is NOT advertised — it resolves, it just isn't offered", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["project-coordination"]);
    const offered = tools.availableOperations();
    expect(offered).toContain("thread.consult");
    expect(offered).not.toContain("agent.consult");
  });

  it("never invents an action: an unknown script prefix is passed through untouched", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin"]);
    expect(tools.resolveOperationAlias("totally-made-up.project.list", {}).name)
      .toBe("totally-made-up.project.list");
    // A real script + an operation it does NOT own must not resolve either.
    expect(tools.resolveOperationAlias("workspace-admin", { operation: "notify.email" }).name)
      .toBe("workspace-admin");
  });

  it("does not cross scripts: an op from another script is not reachable via this one's name", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin", "notifications"]);
    expect(tools.resolveOperationAlias("workspace-admin.notify.email", {}).name)
      .toBe("workspace-admin.notify.email");
  });
});

/**
 * The third spelling, and the most expensive one: the operation used as a KEY whose value is the
 * real argument object. Live, the model had assembled correct arguments for project.create, was
 * refused, LOST them, and retried the right operation with an empty params — three wasted steps
 * for a call that was fully formed the first time.
 */
describe("operation-as-params-key resolves too", () => {
  it("resolves '<script>' + {'<op>': {args}} and keeps the arguments", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin"]);
    expect(
      tools.resolveOperationAlias("workspace-admin", { "project.create": { name: "Lead Tracking" } })
    ).toEqual({ name: "project.create", params: { name: "Lead Tracking" } });
  });

  it("does not fire when the key names an operation the script does not own", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin", "notifications"]);
    expect(tools.resolveOperationAlias("workspace-admin", { "notify.email": { to: "x@y.z" } }).name)
      .toBe("workspace-admin");
  });

  it("does not guess when two operation-shaped keys are present", () => {
    const tools = new ScriptToolSurface(makeEnv(makeR2()), ["workspace-admin"]);
    expect(
      tools.resolveOperationAlias("workspace-admin", {
        "project.create": { name: "A" },
        "project.list": {},
      }).name
    ).toBe("workspace-admin");
  });
});

/**
 * Every script the assistant is INSTRUCTED to use must actually be in its tool list. The
 * project journal was told about eleven times across the two profiles and listed in neither —
 * the assistant reached for Memory OS instead, so a project's own state had nowhere to live.
 */
describe("assistant profiles can call every script their prose instructs", () => {
  it("both assistant profiles carry the scripts their own instructions name", async () => {
    const { DEFAULT_NAELAO_AGENT, LAUNCHPAD_ASSISTANT_PROFILE } = await import(
      "../../workers/agents/src/script-engine/profiles.js"
    );
    for (const profile of [DEFAULT_NAELAO_AGENT, LAUNCHPAD_ASSISTANT_PROFILE]) {
      const listed = profile.config.scripts.prebuilt;
      const prose = `${profile.config.agentsMd}\n${profile.config.systemPrompt ?? ""}`;
      // Instructed by op name in the prose → the owning script must be listed.
      for (const [op, script] of [
        ["project_journal.read", "project-journal"],
        ["thread.send_message", "project-coordination"],
        ["project.create", "workspace-admin"],
      ] as const) {
        if (prose.includes(op)) {
          expect(listed, `${profile.agentId} instructs ${op} but does not list ${script}`).toContain(script);
        }
      }
    }
  });
});
