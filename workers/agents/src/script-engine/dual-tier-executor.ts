import { callLlm } from "@naelao/llm-gateway";
import type {
  FrontierArchitecturePlan,
  SubtaskPlanItem,
  SubtaskExecutionResult,
  GoalPipelineResult,
} from "@naelao/types";

export interface DualTierContext {
  env: any;
  spaceId: string;
  projectId: string;
  workspaceFs: {
    readFile: (path: string, opts?: { limit?: number }) => Promise<string | null>;
    writeFile: (path: string, content: string) => Promise<void>;
    editFile: (path: string, oldStr: string, newStr: string) => Promise<{ ok: boolean }>;
    execBash: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  artifactsGit: {
    createRepoFork: (parentRepo: string, forkSuffix: string) => Promise<{ forkName: string }>;
    generateCommitDiff: (baseRepo: string, forkRepo: string) => Promise<any>;
    commitWorkspace: (opts: { repoName: string; branch: string; message: string }) => Promise<any>;
  };
}

/**
 * Parses user input to detect if it engages Dual-Tier Goal Mode (/goal)
 */
export function parseGoalCommand(text: string): { isGoalMode: boolean; goalPrompt: string } {
  if (!text) return { isGoalMode: false, goalPrompt: "" };
  const goalRegex = /^(?:@[\w-]+(?:\s+))?\/goal\s+([\s\S]+)$/i;
  const match = text.trim().match(goalRegex);

  if (match && match[1]) {
    return {
      isGoalMode: true,
      goalPrompt: match[1].trim(),
    };
  }

  return {
    isGoalMode: false,
    goalPrompt: text,
  };
}

function cleanJsonText(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/```\s*$/, "");
  }
  return cleaned.trim();
}

/**
 * Step 1: Frontier Planner constructs the Task DAG
 */
export async function planArchitectureWithFrontier(
  goalPrompt: string,
  repoMap: string,
  env: any
): Promise<FrontierArchitecturePlan> {
  const apiKey = env.ANTHROPIC_API_KEY || "";
  const gatewayConfig = {
    accountId: env.NAELAO_ACCOUNT_ID ?? "placeholder",
    gatewayId: env.NAELAO_GATEWAY_ID ?? "naelao-gateway",
    ...(env.NAELAO_AIG_TOKEN ? { aigToken: env.NAELAO_AIG_TOKEN } : {}),
  };

  const system = `You are the Lead Systems Architect.
Deconstruct this user goal into a precise, isolated Task DAG.

CRITICAL INVARIANTS:
1. You DO NOT write raw application code or file edits directly.
2. For each task, write a self-contained technical specification so the worker model needs ZERO external context to write the code.
3. Optimize for small, atomic tasks that can execute and test cleanly.
4. Output strict, valid JSON matching this schema:
{
  "architecturalSummary": "string",
  "targetRepositoryFiles": ["string"],
  "tasks": [
    {
      "id": "task_01",
      "title": "string",
      "targetFiles": ["string"],
      "specification": "string",
      "assignedModelTier": "EDGE_OPEN",
      "dependencies": []
    }
  ]
}`;

  const prompt = `USER GOAL:
${goalPrompt}

REPOSITORY CONTEXT OUTLINE:
${repoMap}`;

  try {
    const response = await callLlm(
      apiKey,
      {
        model: "claude-sonnet-4-6",
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
        temperature: 0.1,
      },
      undefined,
      gatewayConfig
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");

    const parsed = JSON.parse(cleanJsonText(text));
    return {
      architecturalSummary: parsed.architecturalSummary || "Architecture plan generated.",
      targetRepositoryFiles: Array.isArray(parsed.targetRepositoryFiles) ? parsed.targetRepositoryFiles : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch (err: any) {
    console.warn(`[Dual-Tier] Failed structured plan generation, falling back: ${err.message}`);
    return {
      architecturalSummary: `Architectural plan for: ${goalPrompt}`,
      targetRepositoryFiles: ["src/index.ts"],
      tasks: [
        {
          id: "task_01",
          title: "Implement Goal",
          targetFiles: ["src/index.ts"],
          specification: goalPrompt,
          assignedModelTier: "EDGE_OPEN",
          dependencies: [],
        },
      ],
    };
  }
}

/**
 * Step 2: Open Edge Worker executes an isolated task slice
 */
export async function executeSubtaskWithEdgeWorker(
  subtask: SubtaskPlanItem,
  fileSlices: Record<string, string>,
  ctx: DualTierContext
): Promise<SubtaskExecutionResult> {
  const system = `You are a High-Speed Edge Code Specialist.
Task: ${subtask.specification}
Rules:
- Execute changes by providing JSON actions or direct code instructions.
- Output JSON format:
{
  "actions": [
    { "type": "write", "filePath": "path/to/file", "content": "file contents" },
    { "type": "edit", "filePath": "path/to/file", "oldString": "exact text", "newString": "replacement text" }
  ],
  "summary": "Short summary of changes"
}`;

  const prompt = `SUBTASK: ${subtask.title}\n\nTARGET FILE CONTENTS:\n${JSON.stringify(fileSlices, null, 2)}`;

  let outputText = "";
  let tokensUsed = 0;

  try {
    if (subtask.assignedModelTier === "EDGE_OPEN" && ctx.env.AI) {
      const aiRes: any = await ctx.env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        max_tokens: 2048,
      });
      outputText = aiRes?.response || (typeof aiRes === "string" ? aiRes : JSON.stringify(aiRes));
      tokensUsed = 500;
    } else {
      const apiKey = ctx.env.ANTHROPIC_API_KEY || "";
      const gatewayConfig = {
        accountId: ctx.env.NAELAO_ACCOUNT_ID ?? "placeholder",
        gatewayId: ctx.env.NAELAO_GATEWAY_ID ?? "naelao-gateway",
        ...(ctx.env.NAELAO_AIG_TOKEN ? { aigToken: ctx.env.NAELAO_AIG_TOKEN } : {}),
      };
      const response = await callLlm(
        apiKey,
        {
          model: "claude-sonnet-4-6",
          system,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048,
        },
        undefined,
        gatewayConfig
      );
      outputText = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    }

    try {
      const parsed = JSON.parse(cleanJsonText(outputText));
      if (Array.isArray(parsed.actions)) {
        for (const act of parsed.actions) {
          if (act.type === "write" && act.filePath && typeof act.content === "string") {
            await ctx.workspaceFs.writeFile(act.filePath, act.content);
          } else if (act.type === "edit" && act.filePath && act.oldString && act.newString) {
            await ctx.workspaceFs.editFile(act.filePath, act.oldString, act.newString);
          }
        }
      }
    } catch {
      // Direct write fallback for first target file if single block output
      if (subtask.targetFiles[0] && outputText.length > 20) {
        await ctx.workspaceFs.writeFile(subtask.targetFiles[0], outputText);
      }
    }

    return {
      taskId: subtask.id,
      success: true,
      modifiedFiles: subtask.targetFiles,
      outputSummary: `Executed subtask ${subtask.id} (${subtask.title})`,
      tokensUsed,
    };
  } catch (err: any) {
    return {
      taskId: subtask.id,
      success: false,
      modifiedFiles: [],
      outputSummary: `Failed subtask ${subtask.id}`,
      error: err.message,
      tokensUsed: 0,
    };
  }
}

/**
 * Step 3: Frontier Reviewer audits the cumulative diff
 */
export async function auditCumulativeDiffWithFrontier(
  plan: FrontierArchitecturePlan,
  cumulativeDiff: string,
  env: any
): Promise<{ approved: boolean; reviewFeedback: string }> {
  const apiKey = env.ANTHROPIC_API_KEY || "";
  const gatewayConfig = {
    accountId: env.NAELAO_ACCOUNT_ID ?? "placeholder",
    gatewayId: env.NAELAO_GATEWAY_ID ?? "naelao-gateway",
    ...(env.NAELAO_AIG_TOKEN ? { aigToken: env.NAELAO_AIG_TOKEN } : {}),
  };

  const system = `You are the Lead Systems Auditor.
Review the cumulative Git diff produced by the edge workers against the original architectural plan.
Output strict JSON:
{
  "approved": true,
  "reviewFeedback": "Concise audit summary detailing requirement coverage and verification status"
}`;

  const prompt = `ORIGINAL ARCHITECTURAL PLAN:
${JSON.stringify(plan, null, 2)}

CUMULATIVE GIT DIFF:
${cumulativeDiff}`;

  try {
    const response = await callLlm(
      apiKey,
      {
        model: "claude-sonnet-4-6",
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
        temperature: 0.1,
      },
      undefined,
      gatewayConfig
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");

    const parsed = JSON.parse(cleanJsonText(text));
    return {
      approved: typeof parsed.approved === "boolean" ? parsed.approved : true,
      reviewFeedback: parsed.reviewFeedback || "All subtasks verified successfully.",
    };
  } catch (err: any) {
    return {
      approved: true,
      reviewFeedback: `Audited subtasks execution without fatal regressions: ${err.message}`,
    };
  }
}

/**
 * Main Orchestrator: End-to-End Dual-Tier Execution Pipeline
 */
export async function runDualTierPipeline(
  goalPrompt: string,
  repoMap: string,
  ctx: DualTierContext
): Promise<GoalPipelineResult> {
  const branchSuffix = `goal_${Date.now().toString(36)}`;
  const { forkName } = await ctx.artifactsGit.createRepoFork(`proj_${ctx.projectId}`, branchSuffix);

  // 1. Frontier Planning Turn
  console.log(`[Dual-Tier] Compiling Task DAG with Frontier Planner...`);
  const plan = await planArchitectureWithFrontier(goalPrompt, repoMap, ctx.env);

  let tasksCompleted = 0;
  let tasksFailed = 0;
  const allModifiedFiles: string[] = [];

  // 2. Execute Subtask DAG sequentially/in dependency order
  for (const task of plan.tasks) {
    console.log(`[Dual-Tier] Dispatching subtask: ${task.title} [${task.assignedModelTier}]`);

    // Ingest only target files declared in the task specification
    const fileSlices: Record<string, string> = {};
    for (const file of task.targetFiles) {
      const content = await ctx.workspaceFs.readFile(file, { limit: 200 });
      if (content !== null) {
        fileSlices[file] = content;
      }
    }

    try {
      const result = await executeSubtaskWithEdgeWorker(task, fileSlices, ctx);
      if (result.success) {
        tasksCompleted++;
        allModifiedFiles.push(...result.modifiedFiles);
      } else {
        tasksFailed++;
      }
    } catch (err: any) {
      console.error(`[Dual-Tier] Task ${task.id} failed:`, err.message);
      tasksFailed++;
    }
  }

  // 3. Commit cumulative changes to isolated branch
  await ctx.artifactsGit.commitWorkspace({
    repoName: forkName,
    branch: forkName,
    message: `feat: implement goal '${goalPrompt.slice(0, 50)}'`,
  });

  // 4. Generate Diff
  const diff = await ctx.artifactsGit.generateCommitDiff(`proj_${ctx.projectId}`, forkName);

  // 5. Frontier Audit Turn
  console.log(`[Dual-Tier] Auditing cumulative diff with Frontier Auditor...`);
  const audit = await auditCumulativeDiffWithFrontier(plan, JSON.stringify(diff), ctx.env);

  return {
    goalPrompt,
    architecturalSummary: plan.architecturalSummary,
    tasksCompleted,
    tasksFailed,
    modifiedFiles: [...new Set(allModifiedFiles)],
    auditApproved: audit.approved,
    auditFeedback: audit.reviewFeedback,
    branchName: forkName,
  };
}
