import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileWorkflowEntrypoint } from "./workflows/workflow-harness.js";
import { partitionAtomicChunks } from "./workflows/chunked-subagent-workflow.js";

describe("Batch 10 workflow primitives", () => {
  it("wraps each developer step with durable artifact pointers and authorization", async () => {
    const compiled = await compileWorkflowEntrypoint("export async function execute(step: WorkflowStep, ctx: SubagentContext) { return { ok: true }; }");
    expect(compiled.source).toContain("extends WorkflowEntrypoint");
    expect(compiled.source).toContain("await nativeStep.do(name,{retries:{limit:0,delay:0}}");
    expect(compiled.source).toContain("control.putArtifact(identity.runId,await callback())");
    expect(compiled.source).toContain("control.readArtifact(identity.runId,pointer)");
    expect(compiled.source).toContain("await control.authorize(identity.runId)");
  });
  it("rejects sessionful authored workflows", async () => {
    await expect(compileWorkflowEntrypoint("export async function execute(step: X, ctx: X) { return ctx.threads; }")).rejects.toThrow(/conversational/);
  });
  it("compiles the composed Trading Mentor worker without importing planner context", async () => {
    const source = readFileSync(new URL("../../../packages/agent-sdk/examples/trading-mentor-channel/place-order.ts", import.meta.url), "utf8");
    const compiled = await compileWorkflowEntrypoint(source);
    expect(compiled.source).toContain('"orders.place"');
    expect(compiled.source).toContain("order_requires_explicit_member_confirmation");
  });
  it("partitions a repository map into bounded atomic chunks", () => {
    const chunks = partitionAtomicChunks("change", Array.from({ length: 25 }, (_, i) => ({ path: `${i}.ts`, bytes: i })), 12);
    expect(chunks.map((chunk) => chunk.paths.length)).toEqual([12, 12, 1]);
  });
});
