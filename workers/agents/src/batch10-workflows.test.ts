import { describe, expect, it } from "vitest";
import { compileWorkflowEntrypoint } from "./workflows/workflow-harness.js";
import { partitionAtomicChunks } from "./workflows/chunked-subagent-workflow.js";

describe("Batch 10 workflow primitives", () => {
  it("wraps each developer step with durable artifact pointers and authorization", () => {
    const compiled = compileWorkflowEntrypoint("export async function execute(step: WorkflowStep, ctx: SubagentContext) { return { ok: true }; }");
    expect(compiled.source).toContain("extends WorkflowEntrypoint");
    expect(compiled.source).toContain("await nativeStep.do(name,{retries:{limit:0,delay:0}}");
    expect(compiled.source).toContain("control.putArtifact(identity.runId,await callback())");
    expect(compiled.source).toContain("control.readArtifact(identity.runId,pointer)");
    expect(compiled.source).toContain("await control.authorize(identity.runId)");
  });
  it("rejects sessionful authored workflows", () => {
    expect(() => compileWorkflowEntrypoint("export async function execute(step: X, ctx: X) { return ctx.threads; }")).toThrow(/conversational/);
  });
  it("partitions a repository map into bounded atomic chunks", () => {
    const chunks = partitionAtomicChunks("change", Array.from({ length: 25 }, (_, i) => ({ path: `${i}.ts`, bytes: i })), 12);
    expect(chunks.map((chunk) => chunk.paths.length)).toEqual([12, 12, 1]);
  });
});
