import { describe, expect, it, vi } from "vitest";
import { PREBUILT_SCRIPTS } from "./prebuilt/index.js";
import { UNIVERSAL_PLANNER_PREBUILTS } from "./agent-topology.js";
import {
  DEFAULT_WORKER_CAPABILITY_BUNDLES,
  selectDefaultWorkerCapabilities,
} from "./worker-capabilities.js";

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

  it("offers built-in tool families beyond the former first-nine standalone cutoff", async () => {
    const configured = [
      "browser-use",
      "computer-use",
      "language-detection",
      "language-glossary",
      "language-translation",
      "approvals",
      "business-diagnostics",
      "revenue-tracker",
      "foundry-inbox",
      "skill-manager",
      "local-machine",
      "customer-bot",
      "code-exec",
      "plan",
    ];
    const result = await selectDefaultWorkerCapabilities({
      task: "Translate this customer intake into French and inspect the approval policy.",
      enabledPrebuilts: configured,
      skills: [],
      allowRemoteDecision: false,
    });
    expect(result.selectedBundles).toEqual(
      expect.arrayContaining([
        "language_services",
        "customer_intake",
        "approval_and_policy",
      ])
    );
    expect(result.enabledPrebuilts).toEqual(
      expect.arrayContaining([
        "language-detection",
        "language-glossary",
        "language-translation",
        "foundry-inbox",
        "approvals",
        "plan",
      ])
    );
    expect(result.enabledPrebuilts).not.toContain("code-exec");
  });

  it("has a worker capability group for every non-planner built-in prebuilt", () => {
    const grouped = new Set(
      DEFAULT_WORKER_CAPABILITY_BUNDLES.flatMap((bundle) => [...bundle.tools])
    );
    const plannerOnly = new Set<string>(UNIVERSAL_PLANNER_PREBUILTS);
    const missing = Object.keys(PREBUILT_SCRIPTS).filter(
      (name) => name !== "plan" && !plannerOnly.has(name) && !grouped.has(name)
    );
    expect(missing).toEqual([]);
  });

  it("treats malformed decision payloads as unavailable without granting tools", async () => {
    const configured = ["conversation", "document-processing", "code-exec"];
    const result = await selectDefaultWorkerCapabilities({
      task: "Search earlier conversation messages.",
      enabledPrebuilts: configured,
      skills: [],
      decision: {
        classifyWorkerCapabilities: async () =>
          ({ capabilities: [null, "tool:code-exec"], provider: "unknown" }) as never,
      } as never,
      allowRemoteDecision: true,
    });
    expect(result.fallback).toBe("decision_unavailable");
    expect(result.enabledPrebuilts).toContain("conversation");
    expect(result.enabledPrebuilts).not.toContain("code-exec");
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
