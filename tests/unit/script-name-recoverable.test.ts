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
