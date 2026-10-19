import { describe, expect, it, vi } from "vitest";
import { selectDefaultWorkerCapabilities } from "./worker-capabilities.js";

describe("task-filtered default worker capabilities", () => {
  const tools = [
    "conversation",
    "document-processing",
    "knowledge-base",
    "web-search",
    "code-exec",
    "workspace-admin",
    "plan",
  ];

  it("selects the related transcript and document tools, excluding unrelated tools", async () => {
    const result = await selectDefaultWorkerCapabilities({
      task: "Search the archived conversation for the launch decision and summarize the original message.",
      enabledPrebuilts: tools,
      skills: [],
      allowRemoteDecision: false,
    });
    expect(result.selectedBundles).toContain("conversation_research");
    expect(result.enabledPrebuilts).toContain("conversation");
    expect(result.enabledPrebuilts).toContain("document-processing");
    expect(result.enabledPrebuilts).toContain("knowledge-base");
    expect(result.enabledPrebuilts).not.toContain("code-exec");
    expect(result.enabledPrebuilts).not.toContain("workspace-admin");
    expect(result.selectedSkills).toContain("conversation-research-worker");
  });

  it("unions the validated decision with deterministic matches and always intersects parent authority", async () => {
    const classifyWorkerCapabilities = vi.fn(async () => ({
      capabilities: [
        "code_and_runtime",
        "tool:workspace-admin",
        "unrecognized-secret-tool",
      ],
      provider: "openrouter" as const,
      confidence: 0.95,
    }));
    const result = await selectDefaultWorkerCapabilities({
      task: "Search the conversation history for an earlier decision.",
      enabledPrebuilts: tools,
      skills: [],
      decision: { classifyWorkerCapabilities } as never,
      allowRemoteDecision: true,
    });
    expect(classifyWorkerCapabilities).toHaveBeenCalledOnce();
    expect(result.selectedBundles).toContain("conversation_research");
    expect(result.selectedBundles).toContain("code_and_runtime");
    expect(result.enabledPrebuilts).toContain("code-exec");
    expect(result.enabledPrebuilts).not.toContain("workspace-admin");
    expect(result.enabledPrebuilts.every((name) => tools.includes(name))).toBe(
      true
    );
    expect(result.provider).toBe("openrouter");
  });

  it("falls back to the deterministic task match when the decision service fails", async () => {
    const result = await selectDefaultWorkerCapabilities({
      task: "Inspect the attached PDF and extract its invoice number.",
      enabledPrebuilts: [
        "attachments",
        "customer-attachments",
        "document-processing",
        "code-exec",
      ],
      skills: [],
      decision: {
        classifyWorkerCapabilities: async () => {
          throw new Error("offline");
        },
      } as never,
      allowRemoteDecision: true,
    });
    expect(result.selectedBundles).toContain("attachment_review");
    expect(result.enabledPrebuilts).toContain("attachments");
    expect(result.enabledPrebuilts).not.toContain("code-exec");
    expect(result.fallback).toBe("decision_unavailable");
  });

  it("retains the full configured set for an ambiguous task rather than breaking legacy tasks", async () => {
    const result = await selectDefaultWorkerCapabilities({
      task: "Do the task.",
      enabledPrebuilts: tools,
      skills: [],
      allowRemoteDecision: false,
    });
    expect(result.enabledPrebuilts).toEqual(tools);
    expect(result.fallback).toBe("full_toolset_ambiguous");
  });
});
