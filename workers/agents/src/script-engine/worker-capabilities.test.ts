import { describe, expect, it, vi } from "vitest";
import { PREBUILT_SCRIPTS } from "./prebuilt/index.js";
import { UNIVERSAL_PLANNER_PREBUILTS } from "./agent-topology.js";
import {
  DEFAULT_WORKER_CAPABILITY_BUNDLES,
  prioritizeWorkerSkillNames,
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

  it("selects package inspection for a Space Template authoring task without granting it to unrelated tasks", async () => {
    const tools = ["package-authoring", "file-manager", "code-exec"];
    const authoring = await selectDefaultWorkerCapabilities({
      task: "Inspect this extension bundle manifest before I submit it for permission review.",
      enabledPrebuilts: tools,
      skills: [],
      allowRemoteDecision: false,
    });
    expect(authoring.selectedBundles).toContain("package_authoring");
    expect(authoring.enabledPrebuilts).toContain("package-authoring");
    expect(authoring.enabledPrebuilts).not.toContain("code-exec");

    const unrelated = await selectDefaultWorkerCapabilities({
      task: "Summarize the current conversation history.",
      enabledPrebuilts: tools,
      skills: [],
      allowRemoteDecision: false,
    });
    expect(unrelated.enabledPrebuilts).not.toContain("package-authoring");
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
      expect.arrayContaining(["language_services", "approval_and_policy"])
    );
    expect(result.enabledPrebuilts).toEqual(
      expect.arrayContaining([
        "language-detection",
        "language-glossary",
        "language-translation",
        "approvals",
        "plan",
      ])
    );
    expect(result.enabledPrebuilts).not.toContain("code-exec");
    expect(result.enabledPrebuilts).not.toContain("customer-bot");
    expect(result.enabledPrebuilts).not.toContain("foundry-inbox");
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

  it("prioritizes task-matching skill names beyond the bounded metadata scan prefix", () => {
    const names = Array.from(
      { length: 150 },
      (_, index) => `skill-${String(index).padStart(3, "0")}`
    );
    names.push("zz-conversation-research");
    const selected = prioritizeWorkerSkillNames(
      "research the conversation history",
      names,
      100
    );
    expect(selected).toHaveLength(100);
    expect(selected[0]).toBe("zz-conversation-research");
    expect(selected).not.toContain("unsafe/skill");
    expect(
      prioritizeWorkerSkillNames("task", ["../escape", "valid-skill"], 100)
    ).toEqual(["valid-skill"]);
  });

  it("treats malformed decision payloads as unavailable without granting tools", async () => {
    const configured = ["conversation", "document-processing", "code-exec"];
    const result = await selectDefaultWorkerCapabilities({
      task: "Search earlier conversation messages.",
      enabledPrebuilts: configured,
      skills: [],
      decision: {
        classifyWorkerCapabilities: async () =>
          ({
            capabilities: [null, "tool:code-exec"],
            provider: "unknown",
          }) as never,
      } as never,
      allowRemoteDecision: true,
    });
    expect(result.fallback).toBe("decision_unavailable");
    expect(result.enabledPrebuilts).toContain("conversation");
    expect(result.enabledPrebuilts).not.toContain("code-exec");
  });

  it("fails closed to the planner substrate for an ambiguous task", async () => {
    const result = await selectDefaultWorkerCapabilities({
      task: "Do the task.",
      enabledPrebuilts: tools,
      skills: [],
      allowRemoteDecision: false,
    });
    expect(result.enabledPrebuilts).toEqual(["plan"]);
    expect(result.selectedSkills).toEqual([]);
    expect(result.fallback).toBe("no_capability_match");
  });

  it("does not grant tools when an ambiguous task has no planner substrate", async () => {
    const result = await selectDefaultWorkerCapabilities({
      task: "Do the task.",
      enabledPrebuilts: ["code-exec", "workspace-admin"],
      skills: [],
      allowRemoteDecision: false,
    });
    expect(result.enabledPrebuilts).toEqual([]);
    expect(result.selectedSkills).toEqual([]);
  });
  it("routes assistant inbox/verification and demonstration tasks only through configured related tools", async () => {
    const selected = await selectDefaultWorkerCapabilities({
      task: "Test a learned browser demonstration and check email verification",
      enabledPrebuilts: [
        "assistant-mail",
        "assistant-phone",
        "browser-use",
        "browser-demonstrations",
        "plan",
      ],
      skills: [],
      allowRemoteDecision: false,
    });
    expect(selected.enabledPrebuilts).toEqual(
      expect.arrayContaining([
        "assistant-mail",
        "assistant-phone",
        "browser-use",
        "browser-demonstrations",
      ])
    );
    const restricted = await selectDefaultWorkerCapabilities({
      task: "Check email verification and replay a browser demonstration",
      enabledPrebuilts: ["assistant-mail", "plan"],
      skills: [],
      allowRemoteDecision: false,
    });
    expect(restricted.enabledPrebuilts).not.toContain("assistant-phone");
    expect(restricted.enabledPrebuilts).not.toContain("browser-demonstrations");
  });
});
