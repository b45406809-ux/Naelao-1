import { describe, expect, it, vi } from "vitest";
import { privacyBridgeCard, ScriptToolSurface } from "./tool-surface.js";
import { runAfterStep, validateStepPipeline } from "./step-pipeline.js";

const bucket = { list: vi.fn(async () => ({ objects: [], truncated: false })) } as unknown as R2Bucket;

describe("public tool surface", () => {
  it("physically removes private and high privilege operations", () => {
    const tools = new ScriptToolSurface({ scriptsBucket: bucket, spaceId: "s", agentId: "a", tenantId: "t" }, ["business-email", "code-exec", "web-search"], { roomType: "public_channel" });
    const operations = tools.availableOperations();
    expect(operations).not.toContain("email.send");
    expect(operations).not.toContain("Bash");
    expect(operations).toContain("search");
    expect(privacyBridgeCard("thread 1", "private")).toMatchObject({ type: "fork_scratchpad_card", target_thread_id: "thread 1" });
  });
});

describe("declarative pipelines", () => {
  it("rejects executable source and returns deterministic gate failures", async () => {
    expect(() => validateStepPipeline({ beforeStep: [{ type: "context_query", indexer: "budget", query: {}, javascript: "alert(1)" }] })).toThrow(/executable/);
    expect(() => validateStepPipeline({ afterStep: [{ type: "verification", command: "rm -rf /" }] })).toThrow(/allowlisted/);
    const result = await runAfterStep({ afterStep: [{ type: "verification", command: "pnpm test" }] }, { query: vi.fn(), verify: vi.fn(async () => ({ ok: false, error: "tests failed" })) });
    expect(result).toEqual({ ok: false, failures: [{ command: "pnpm test", error: "tests failed" }] });
  });
});
