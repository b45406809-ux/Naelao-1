Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 4 — Chunk 08**: `specs/phase-4/chunk-08-goal-hook-and-vectorize-bindings.md`.

---

```markdown
---
chunk_id: "phase-4-chunk-08"
phase: 4
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/dual-tier-executor.ts
  - workers/knowledge/wrangler.toml
  - workers/agents/wrangler.toml
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/agents/src/script-engine/dual-tier-executor.ts"
  - "workers/knowledge/wrangler.toml"
  - "workers/agents/wrangler.toml"
expected_outputs:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/dual-tier-executor.ts
  - workers/knowledge/wrangler.toml
  - workers/agents/wrangler.toml
---

# Phase 4 — Remediation Chunk 08: Goal Ingress Hook & Vectorize Metadata Bindings

## 1. Executive Summary & Architectural Vision

This remediation bridge chunk resolves two critical cross-cutting integration requirements in Phase 4:

1. **The Ingress `/goal` Command Hook in `NaelaoAgentDO.ts`:**  
   When a user or Space Assistant triggers a complex architectural goal (e.g. `/goal Refactor auth to support multi-tenant JWTs` or `@DevOperator /goal Build Stripe billing table`), the request must **bypass the standard single-turn conversational REPL loop**. Instead, it triggers the **Dual-Tier Planner-Worker Engine** (`dual-tier-executor.ts`), which decomposes the goal into a structured **Task DAG** via a Frontier Planner (Claude 3.7 / o3) and executes subtasks in parallel using cheap, isolated Edge Workers (Llama 3.3 / Qwen 2.5 Coder).

2. **Cloudflare Vectorize v2 Metadata Indexing Declarations:**  
   Cloudflare Vectorize v2 strictly requires that any property used inside a metadata pre-filter (e.g. `space_id`, `project_id`, `min_role_rank`, `scope`, `bot_id`) be **explicitly declared as an indexed property in `wrangler.toml`**. Without these declarations, Mini-AGI hardware-level vector ACL queries fail or silently fall back to unfiltered searches.

```
[ User types `/goal Build Stripe Webhook Handlers` ]
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. NaelaoAgentDO INGRESS PARSER (`handleScriptRun` in NaelaoAgentDO.ts)     │
│    Detects `/goal` prefix ──► Diverts to Dual-Tier Planner-Worker Engine.   │
└─────────────────────────┬───────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. FRONTIER PLANNER (Claude 3.7 / o3 via Cloudflare AI Gateway)             │
│    • Receives: Clean Goal Prompt + Compressed Repomix Map (~1.5k tokens).   │
│    • Emits: Structured Task DAG (`FrontierArchitecturePlan`).               │
│    • NEVER touches build logs or writes raw code directly.                  │
└─────────────────────────┬───────────────────────────────────────────────────┘
                          │
                          ▼ (Serializes Subtasks to `SpaceDO.project_tasks`)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. ISOLATED EDGE WORKERS (Llama 3.3 70B / Qwen 2.5 Coder in V8 Isolates)    │
│    • Worker 1 executes Subtask 1 (`src/api/stripe.ts`) via AST `Edit`.      │
│    • Worker 2 executes Subtask 2 (`src/db/schema.ts`) via AST `Edit`.       │
│    • Verifies each subtask using `Bash("npm test")`.                        │
└─────────────────────────┬───────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. FINAL ARCHITECTURAL CONSOLIDATION & COMMIT                               │
│    Commits changes to Git branch; logs milestone to Project Journal.        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update Vectorize Bindings in `workers/knowledge/wrangler.toml` & `workers/agents/wrangler.toml`

Declare explicit metadata property indexing for the Mini-AGI ACL hierarchy in both configuration files:

```toml
# In workers/knowledge/wrangler.toml and workers/agents/wrangler.toml

[[vectorize]]
binding = "KB_VECTORS"
index_name = "naelao-kb-vectors"

# Hardware-level pre-filtering index properties for Mini-AGI & Memory OS
[vectorize.metadata_indexes]
space_id = "string"
project_id = "string"
min_role_rank = "number"
scope = "string"
bot_id = "string"
owner_user_id = "string"
```

---

### B. Update Dual-Tier Executor (`workers/agents/src/script-engine/dual-tier-executor.ts`)

Export the command parser, DAG generator, and subtask runner:

```typescript
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { FrontierArchitecturePlan, SubtaskPlanItem } from "@naelao/types";

/**
 * Parses user input to detect if it matches the /goal command syntax.
 * Supports: "/goal <prompt>", "@Agent /goal <prompt>", or "@agent /goal <prompt>"
 */
export function parseGoalCommand(text: string): { isGoalMode: boolean; goalPrompt: string } {
  const goalRegex = /^(?:@[\w-]+(?:\s+))?\/goal\s+([\s\S]+)$/i;
  const match = text.trim().match(goalRegex);

  if (match && match[1]) {
    return {
      isGoalMode: true,
      goalPrompt: match[1].trim()
    };
  }

  return {
    isGoalMode: false,
    goalPrompt: text
  };
}

/**
 * Compiles a structured Task DAG using the Frontier Reasoning model (Claude 3.7 / o3).
 */
export async function planGoalWithFrontier(
  goalPrompt: string,
  repoMap: string,
  env: any
): Promise<FrontierArchitecturePlan> {
  const { object } = await generateObject({
    model: env.AI_GATEWAY("claude-3-7-sonnet"),
    schema: z.object({
      architecturalSummary: z.string().describe("High-level summary of the architectural strategy"),
      targetRepositoryFiles: z.array(z.string()).describe("All files that will be created or modified"),
      tasks: z.array(z.object({
        id: z.string().describe("Unique sequential ID e.g. task_01"),
        title: z.string().describe("Brief descriptive title"),
        targetFiles: z.array(z.string()).describe("Files relevant to this specific subtask"),
        specification: z.string().describe("Self-contained technical specification for the edge worker"),
        assignedModelTier: z.enum(["EDGE_OPEN", "FRONTIER_REASON"]),
        dependencies: z.array(z.string()).describe("Task IDs that must complete before this runs")
      }))
    }),
    prompt: `You are the Lead Systems Architect (Frontier Planner).
Deconstruct the following user objective into an isolated, sequential Task DAG.

CRITICAL INSTRUCTIONS:
1. Do NOT write raw code or full file rewrites.
2. For each task, write a self-contained technical specification so the worker needs zero additional context.
3. Order dependencies strictly so prerequisite interfaces are built before consumers.

GOAL:
${goalPrompt}

REPOSITORY CONTEXT:
${repoMap}`
  });

  return object as FrontierArchitecturePlan;
}

/**
 * Executes a single subtask slice using an isolated Edge Worker model (Llama 3.3 70B / Qwen 2.5 Coder).
 */
export async function executeSubtaskSlice(
  subtask: SubtaskPlanItem,
  fileSlices: Record<string, string>,
  env: any,
  tools: any
) {
  const workerMessages = [
    {
      role: "system" as const,
      content: `You are an Edge Code Specialist.
Task Specification: ${subtask.specification}

OPERATING CONSTRAINTS:
1. Always use 'Edit' for surgical AST search-and-replace block patches. Never rewrite full files.
2. Use 'Read' to inspect line numbers before applying edits.
3. Verify your changes by running build checks or tests with 'Bash'.
4. Do not output conversational filler. Execute tool calls immediately.`
    },
    {
      role: "user" as const,
      content: `TASK: ${subtask.title}\n\nTARGET CODE SLICES:\n${JSON.stringify(fileSlices, null, 2)}`
    }
  ];

  return await generateText({
    model: env.WORKERS_AI("@cf/meta/llama-3.3-70b-instruct"),
    messages: workerMessages,
    tools,
    maxSteps: 8
  });
}
```

---

### C. Update `workers/agents/src/do/NaelaoAgentDO.ts`

Hook the `/goal` interception directly into `handleScriptRun` before the main reasoning turn:

```typescript
import { parseGoalCommand, planGoalWithFrontier, executeSubtaskSlice } from "../script-engine/dual-tier-executor";

// Inside NaelaoAgentDO class in workers/agents/src/do/NaelaoAgentDO.ts:

async handleScriptRun(request: Request): Promise<Response> {
  const body = await request.json() as any;
  const userPrompt = body.goal || body.prompt || "";

  // 1. Check for /goal command syntax
  const { isGoalMode, goalPrompt } = parseGoalCommand(userPrompt);

  if (isGoalMode) {
    console.log(`🚀 Ingress Goal Intercepted: "${goalPrompt}". Engaging Dual-Tier Planner-Worker Engine...`);

    // A. Generate compressed repository outline from DO Virtual FS
    const repoMap = await this.virtualShell.exec("tree -L 2 -I 'node_modules|dist|.git'");

    // B. Compile Task DAG with Frontier Planner
    const plan = await planGoalWithFrontier(goalPrompt, repoMap.stdout, this.env);

    // C. Execute each subtask using isolated Edge Workers
    const completedTasks: string[] = [];
    for (const task of plan.tasks) {
      // Gather file slices needed for this subtask
      const fileSlices: Record<string, string> = {};
      for (const filePath of task.targetFiles) {
        const content = await this.virtualShell.exec(`head -n 120 ${filePath}`);
        fileSlices[filePath] = content.stdout;
      }

      // Execute subtask with Edge Worker
      await executeSubtaskSlice(task, fileSlices, this.env, this.tools);
      completedTasks.push(task.title);

      // Log progress to Project Journal
      await this.projectJournal.logMilestone(task.id, task.title, "COMPLETED");
    }

    // D. Return consolidated milestone output
    return Response.json({
      status: "completed",
      final_answer: `✔ Architectural Goal Completed: ${plan.architecturalSummary}\n\nExecuted ${completedTasks.length} subtasks:\n${completedTasks.map(t => `- ${t}`).join("\n")}`,
      plan_summary: plan.architecturalSummary,
      tasks_completed: completedTasks.length
    });
  }

  // 2. Standard single-turn / iterative execution loop continues below for normal prompts...
  return await this.executeStandardReActLoop(body);
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. **Update `workers/knowledge/wrangler.toml` and `workers/agents/wrangler.toml`:**
   - Add the `[vectorize.metadata_indexes]` block with `space_id`, `project_id`, `min_role_rank`, `scope`, `bot_id`, and `owner_user_id`.
2. **Update `workers/agents/src/script-engine/dual-tier-executor.ts`:**
   - Export `parseGoalCommand`, `planGoalWithFrontier`, and `executeSubtaskSlice`.
   - Ensure the prompt strictly instructs the Frontier model not to write application code directly.
3. **Update `workers/agents/src/do/NaelaoAgentDO.ts`:**
   - In `handleScriptRun`, import `parseGoalCommand` and branch when `isGoalMode === true`.
4. **Syntax Verification:** Run `node --check` across all modified TypeScript files.
```
