import type { FastDecisionGateway, WorkRuntimeOption } from "@naelao/agent-sdk";

/** Related tool groups offered to the shared default worker. Every group is intersected with
 * the parent's configured prebuilt list; a decision can recommend a subset, never grant a tool. */
export const DEFAULT_WORKER_CAPABILITY_BUNDLES = [
  {
    capability: "conversation_research",
    description:
      "Search current/archived conversation history and use document summarize, extract, or compress on selected excerpts.",
    tools: ["conversation", "document-processing", "knowledge-base"],
    skills: ["conversation-research-worker"],
    match:
      /conversation|transcript|thread history|earlier|previously|what did (?:we|i) say|decided|remember|compacted|summari[sz]e|extract|compress/i,
  },
  {
    capability: "attachment_review",
    description: "Inspect, read, OCR, or transcribe task-scoped attachments.",
    tools: ["attachments", "document-processing"],
    skills: ["attachment-readers"],
    match:
      /attachment|file attached|uploaded|pdf|image|audio|transcri|ocr|extract text/i,
  },
  {
    capability: "web_and_knowledge_research",
    description:
      "Search the web and the authorized Space/project knowledge base.",
    tools: ["web-search", "knowledge-base"],
    skills: [],
    match:
      /web|internet|source|research|knowledge base|vector|rag|citation|current information/i,
  },
  {
    capability: "workspace_files",
    description:
      "Read, write, move, and organize authorized workspace files and artifacts.",
    tools: ["file-manager", "r2-workspace", "workspace", "artifacts"],
    skills: [],
    match:
      /workspace|file|folder|artifact|document|spreadsheet|csv|save|move|rename/i,
  },
  {
    capability: "code_and_runtime",
    description:
      "Run code, shell commands, and inspect or select installed execution runtimes.",
    tools: ["code-exec", "runtime-discovery", "workspace", "file-manager"],
    skills: [],
    match:
      /code|implement|debug|test|build|compile|shell|bash|container|runtime|repository|source code/i,
  },
  {
    capability: "project_operations",
    description: "Manage projects, project agents, journals, and task DAGs.",
    tools: [
      "workspace-admin",
      "project-coordination",
      "project-journal",
      "tasks",
    ],
    skills: [],
    match:
      /project|agent roster|delegate|task dag|project status|project journal|create project|manage project/i,
  },
  {
    capability: "external_integrations",
    description:
      "Use configured MCP connectors and their authorized tools.",
    tools: ["mcp-connector"],
    skills: [],
    match:
      /extension|connector|mcp|third.party|external service|integration|email|inbox|send mail/i,
  },
  {
    capability: "notifications",
    description:
      "Send user-approved notifications and status updates.",
    tools: ["notifications"],
    skills: [],
    match: /notify|notification|reply|message|status update/i,
  },
  {
    capability: "automation_and_scheduling",
    description:
      "Create or run durable workflows, scheduled work, and named-lock coordination.",
    tools: ["dynamic-workflow", "schedule", "lock"],
    skills: [],
    match: /workflow|automate|schedule|recurring|later|cron|lock|background/i,
  },
  {
    capability: "memory_and_journal",
    description:
      "Recall and maintain durable memory, project notes, and curated knowledge.",
    tools: ["memory", "fabric", "wiki", "project-journal"],
    skills: [],
    match:
      /memory|remember|long.term|wiki|journal|standing instructions|past project/i,
  },
  {
    capability: "browser_operations",
    description: "Browse websites and use authorized visual computer controls.",
    tools: ["browser-use", "computer-use"],
    skills: [],
    match: /browser|website|web page|click|navigate|computer|screen|visual|sign.?in|log.?in|website account/i,
  },
  {
    capability: "language_services",
    description: "Detect, translate, and maintain terminology across languages.",
    tools: ["language-detection", "language-glossary", "language-translation"],
    skills: [],
    match: /language|translate|translation|locali[sz]e|glossary|terminology/i,
  },
  {
    capability: "approval_and_policy",
    description: "Review pending approvals and action policies.",
    tools: ["approvals"],
    skills: [],
    match: /approval|approve|permission|policy|authorization/i,
  },
  {
    capability: "skill_library",
    description: "Inspect and maintain the agent's installed skills.",
    tools: ["skill-manager"],
    skills: [],
    match: /skill library|installed skill|skill health|manage skills/i,
  },
  {
    capability: "local_machine_access",
    description: "Use the explicitly authorized local machine connection.",
    tools: ["local-machine"],
    skills: [],
    match: /local machine|my computer|local device/i,
  },
] as const;

export interface WorkerSkillCandidate {
  name: string;
  description: string;
}
export interface WorkerCapabilitySelection {
  enabledPrebuilts: string[];
  selectedSkills: string[];
  selectedBundles: string[];
  provider: "deterministic" | "openrouter";
  fallback: "none" | "no_capability_match" | "decision_unavailable";
}

const MAX_TASK_CHARS = 4_000;
const MAX_SKILL_CANDIDATES = 20;

function taskTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 2)
  );
}

/** Stable, bounded metadata scan: prioritize task terms found in skill names before the R2 read cap. */
export function prioritizeWorkerSkillNames(
  task: string,
  names: readonly string[],
  limit = 100
): string[] {
  const tokens = taskTokens(task);
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(500, limit)) : 100;
  return [...new Set(names)]
    .filter((name) => /^[a-zA-Z0-9._-]{1,128}$/.test(name))
    .map((name) => {
      const nameTokens = taskTokens(name.replace(/[._-]/g, " "));
      let score = 0;
      for (const token of tokens) if (nameTokens.has(token)) score++;
      return { name, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, safeLimit)
    .map((item) => item.name);
}

function rankSkills(
  task: string,
  skills: readonly WorkerSkillCandidate[]
): WorkerSkillCandidate[] {
  const tokens = taskTokens(task);
  return skills
    .filter((skill) => /^[a-zA-Z0-9._-]{1,128}$/.test(skill.name))
    .map((skill) => {
      const metadata = taskTokens(
        `${skill.name.replace(/[._-]/g, " ")} ${skill.description.slice(0, 500)}`
      );
      let score = 0;
      for (const token of tokens) if (metadata.has(token)) score++;
      return { skill, score };
    })
    .filter((row) => row.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name)
    )
    .slice(0, MAX_SKILL_CANDIDATES)
    .map((row) => row.skill);
}

function selectedByTask(
  task: string,
  candidates: readonly (typeof DEFAULT_WORKER_CAPABILITY_BUNDLES)[number][]
): string[] {
  return candidates
    .filter((bundle) => bundle.match.test(task))
    .map((bundle) => bundle.capability);
}

/** Select a subset only. `decision` is advisory: invalid/unavailable results do not alter authority. */
export async function selectDefaultWorkerCapabilities(input: {
  task: string;
  enabledPrebuilts: readonly string[];
  toolDescriptions?: Readonly<Record<string, string>>;
  skills: readonly WorkerSkillCandidate[];
  decision?: FastDecisionGateway;
  allowRemoteDecision: boolean;
}): Promise<WorkerCapabilitySelection> {
  const task = input.task.slice(0, MAX_TASK_CHARS);
  const configured = new Set(input.enabledPrebuilts);
  const bundles = DEFAULT_WORKER_CAPABILITY_BUNDLES.filter((bundle) =>
    bundle.tools.some((tool) => configured.has(tool))
  );
  const bundledTools = new Set<string>(
    bundles.flatMap((bundle) => [...bundle.tools])
  );
  const standaloneTools = input.enabledPrebuilts
    .filter((name) => !bundledTools.has(name) && name !== "plan")
    .slice(0, 9)
    .map((name) => ({
      capability: `tool:${name}`,
      description: `Tool group ${name}: ${(input.toolDescriptions?.[name] ?? "Execute this configured Naelao tool family.").slice(0, 300)}`,
    }));
  const learned = rankSkills(task, input.skills).filter(
    (skill) => !bundleSkillNames.has(skill.name)
  );
  const candidates: WorkRuntimeOption[] = [
    ...bundles.map((bundle) => ({
      capability: bundle.capability,
      description: bundle.description,
    })),
    ...standaloneTools,
    ...learned.map((skill) => ({
      capability: `skill:${skill.name}`,
      description: `Worker skill ${skill.name}: ${skill.description.slice(0, 300)}`,
    })),
  ].slice(0, 40);

  const deterministicBundles = selectedByTask(task, bundles);
  const deterministicSkills = learned
    .filter((skill) => {
      const tokens = taskTokens(task);
      const meta = taskTokens(
        `${skill.name.replace(/[._-]/g, " ")} ${skill.description.slice(0, 300)}`
      );
      return [...tokens].some((token) => meta.has(token));
    })
    .map((skill) => skill.name);

  let aiSelections: string[] = [];
  let provider: WorkerCapabilitySelection["provider"] = "deterministic";
  let decisionUnavailable = false;
  if (
    input.allowRemoteDecision &&
    input.decision?.classifyWorkerCapabilities &&
    candidates.length > 0
  ) {
    try {
      const decision = await input.decision.classifyWorkerCapabilities({
        task,
        capabilities: candidates,
      });
      if (
        !decision ||
        !Array.isArray(decision.capabilities) ||
        (decision.provider !== "deterministic" && decision.provider !== "openrouter")
      ) {
        decisionUnavailable = true;
      } else {
        aiSelections = decision.capabilities.filter(
          (name): name is string => typeof name === "string"
        );
        provider = decision.provider;
      }
    } catch {
      decisionUnavailable = true;
    }
  }
  const allowed = new Set(candidates.map((candidate) => candidate.capability));
  aiSelections = aiSelections.filter((name) => allowed.has(name));
  const selectedBundles = [
    ...new Set([
      ...deterministicBundles,
      ...aiSelections.filter((name) => !name.startsWith("skill:")),
    ]),
  ];
  const selectedSkills = new Set<string>([
    ...deterministicSkills,
    ...aiSelections
      .filter((name) => name.startsWith("skill:"))
      .map((name) => name.slice("skill:".length)),
  ]);
  const byBundle = new Map<
    string,
    (typeof DEFAULT_WORKER_CAPABILITY_BUNDLES)[number]
  >(bundles.map((bundle) => [bundle.capability, bundle]));
  for (const name of selectedBundles)
    for (const skill of byBundle.get(name)?.skills ?? [])
      selectedSkills.add(skill);

  const selectedToolNames = new Set<string>();
  for (const name of selectedBundles)
    for (const tool of byBundle.get(name)?.tools ?? [])
      if (configured.has(tool)) selectedToolNames.add(tool);
  for (const name of selectedBundles)
    if (name.startsWith("tool:")) {
      const tool = name.slice("tool:".length);
      if (configured.has(tool)) selectedToolNames.add(tool);
    }
  // Leave a small worker substrate installed for the task loop and capability introspection.
  if (configured.has("plan")) selectedToolNames.add("plan");

  if (selectedBundles.length === 0) {
    return {
      // Ambiguous tasks must not receive every configured tool. Keep only the planning
      // substrate so the child can report that it needs a narrower task or more context.
      enabledPrebuilts: configured.has("plan") ? ["plan"] : [],
      selectedSkills: [],
      selectedBundles: [],
      provider,
      fallback: decisionUnavailable
        ? "decision_unavailable"
        : "no_capability_match",
    };
  }
  return {
    enabledPrebuilts: input.enabledPrebuilts.filter((name) =>
      selectedToolNames.has(name)
    ),
    selectedSkills: [...selectedSkills].filter((name) =>
      /^[a-zA-Z0-9._-]{1,128}$/.test(name)
    ),
    selectedBundles,
    provider,
    fallback: decisionUnavailable ? "decision_unavailable" : "none",
  };
}

const bundleSkillNames = new Set<string>(
  DEFAULT_WORKER_CAPABILITY_BUNDLES.flatMap((bundle) => [...bundle.skills])
);
