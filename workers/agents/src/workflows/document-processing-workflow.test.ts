import { createDocumentSummaryWorkflowSource } from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";
import { compileWorkflowEntrypoint } from "./workflow-compiler.js";

describe("FDE document workflow recipe", () => {
  it("compiles as a durable extension workflow and records source provenance", async () => {
    const source = createDocumentSummaryWorkflowSource();
    const compiled = await compileWorkflowEntrypoint(source);
    expect(compiled.className).toBe("CompiledWorkflow");
    expect(compiled.source).toContain(
      'ctx.tools.call("partition-source", "document.partition"'
    );
    expect(compiled.source).toContain(
      'ctx.tools.call("summarize-" + chunk.index, "document.summarize"'
    );
    expect(compiled.source).toContain("storage:Object.freeze");
    expect(compiled.source).toContain("sourceHash: manifest.sourceHash");
  });
});
