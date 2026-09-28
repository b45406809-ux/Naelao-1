import { describe, expect, it } from "vitest";
import { createSubagentContext, spawnSubagentVerb } from "./subagent-context.js";
import { emitWorkflowReceiptCard } from "./receipt-card.js";

function fixture() {
  const files = new Map<string, string>([["/workspace/a.ts", "old"]]);
  return {
    files,
    context: createSubagentContext({
      ai: { complete: async (request) => request.maxTokens },
      fs: {
        read: async (path) => files.get(path) ?? Promise.reject(new Error("missing")),
        write: async (path, value) => { files.set(path, value); },
        edit: async () => {}, diff: async () => "", grep: async () => [],
        glob: async () => [...files.keys()],
      },
      cli: { run: async () => ({}), register: async () => "/.avos/bin/tool" },
      vault: { fetchWithAuth: async () => new Response() },
      step: { do: async (_name, callback) => callback(), sleep: async () => {} },
    }),
  };
}

describe("ephemeral subagent runtime", () => {
  it("physically exposes only five capabilities and reports all workspace changes", async () => {
    const { context } = fixture();
    expect(Object.keys(context).sort()).toEqual(["ai", "cli", "fs", "step", "vault"]);
    expect("threads" in context).toBe(false);
    const result = await spawnSubagentVerb({ task: "edit", maxTokens: 9_000, execute: async (_task, ctx) => {
      await ctx.fs.write("/workspace/a.ts", "new");
      await ctx.fs.write("/workspace/new.ts", "created");
      return ctx.ai.complete({ prompt: "done", maxTokens: 9_000 });
    } }, context);
    expect(result).toMatchObject({ ok: true, output: 1_999, modifiedFiles: ["/workspace/a.ts", "/workspace/new.ts"] });
    expect(result.receipt).toEqual(["Subagent completed", "2 files changed"]);
    expect(Object.keys(result)).not.toContain("thread");
  });

  it("offloads logs before emitting a compact two-line receipt", async () => {
    const events: string[] = [];
    const card = await emitWorkflowReceiptCard({ runId: "r1", workflowName: "nightly", status: "succeeded", durationMs: 12, summary: "done", stdout: "heavy" }, {
      logs: { put: async (key) => { events.push(`put:${key}`); } }, emit: async () => { events.push("emit"); },
    });
    expect(events).toEqual(["put:runs/r1/logs.txt", "emit"]);
    expect(card.lines).toHaveLength(2);
  });
});
