Here is the complete, full, long, and detailed specification file for **Phase 7 — Chunk 02**: `specs/phase-7/chunk-02-asymmetric-subagents-and-slim-context.md`.

---

```markdown
---
chunk_id: "phase-7-chunk-02"
phase: 7
include_files:
  - workers/agents/src/workflows/AgentTaskWorkflow.ts
  - workers/agents/src/workflows/ScriptRunWorkflow.ts
  - workers/agents/src/script-engine/types.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/agents/src/workflows/AgentTaskWorkflow.ts"
  - "workers/agents/src/workflows/ScriptRunWorkflow.ts"
  - "workers/agents/src/script-engine/types.ts"
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - packages/types/src/subagent-context.ts
  - packages/types/src/index.ts
  - workers/agents/src/workflows/SubagentTaskWorkflow.ts
  - workers/agents/src/script-engine/subagent-runner.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
---

# Phase 7 — Chunk 02: Asymmetric Subagent Topology & Slimmed-Down SubagentContext

## 1. Executive Summary & Architectural Vision

Traditional multi-agent frameworks make the fatal mistake of treating subagents as full virtual citizens—granting them the ability to create chat threads, manage session histories, escalate execution tiers, and manipulate WebSocket connections. When subagents run inside **Cloudflare Workflows (`WorkflowEntrypoint`)**, this pattern creates severe architectural failures:
1. **Serialization Breakdown:** Cloudflare Workflows require every value returned across `step.do()` to be JSON-serializable. Passing stateful Durable Object stubs or active WebSocket connections causes instant runtime crashes.
2. **Split-Brain Thread Sprawl:** Subagents spawning uncoordinated threads in the background flood the human UI with phantom conversations that have no clear lifecycle.
3. **Severe Latency Penalties:** Step serialization across conversational turns inside a workflow takes 15–20 seconds per interaction, compared to sub-second execution in V8 Isolates.
4. **Prompt Hallucination:** Asking an LLM to generate complex orchestration boilerplate (managing threads, message trees, and ladder tiers) results in high error rates.

### The Solution: The Asymmetric Subagent Principle
* **Subagents are VERBS (Ephemeral Execution Functions):** A subagent is a stateless, pure asynchronous task function (`export async function run(payload, ctx)`) designed to do one discrete job (e.g. Repomix file chunking, bulk web crawling, or AST code generation) and terminate.
* **Parent Agents are NOUNS (Stateful Entities):** Only the Parent Agent (`NaelaoAgentDO`) manages threads, messages, human interactions, and UI receipt cards.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE ASYMMETRIC SUBAGENT TOPOLOGY                                     │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 🏛️ PARENT AGENT (`NaelaoAgentDO` in Durable Object)                                                    │
│ • Owns the conversation thread, WebSockets, human interaction, and Git branches.                      │
│ • Launches durable subagent tasks: `ctx.workflows.start("repomix-chunker", { chunk: "01" })`          │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                    │
                                                    ▼ (Dispatches Task via Cloudflare Workflows)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⚡ TIER 3 CLOUDFLARE WORKFLOW: `SubagentTaskWorkflow` (`repomix-chunker.ts`)                           │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ • Receives a **Slimmed-Down `SubagentContext`** (Only what it needs to execute the task).              │
│ • Has ZERO access to thread creation, message trees, WebSocket channels, or session state.            │
│ • Step 1: `step.do("map", () => ctx.cli.exec("repomix --compress"))`                                  │
│ • Step 2: `step.do("select", () => ctx.ai.selectFiles(map, chunk))`                                   │
│ • Step 3: `step.do("generate", () => ctx.ai.generateCode(files, chunk))`                              │
│ • Step 4: `step.do("commit", () => ctx.fs.writeAndCommit(files))`                                     │
│ • Returns clean JSON: `{ success: true, commitSha: "c_8a12", filesChanged: 3 }`                        │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                    │
                                                    ▼ (Emits Completion Event via RPC / WebSockets)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 📬 PARENT AGENT RENDERS INLINE RECEIPT CARD                                                            │
│ • Parent receives structured JSON result; logs milestone to Project Journal.                           │
│ • Renders a 2-line expandable card in the thread: `[ ⏰ Background Task Complete: c_8a12 ]`            │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The `SubagentContext` Contract

To guarantee safety and prevent runtime serialization errors, subagents receive a lightweight, functional interface. All session, thread, and tier-escalation mechanics are physically omitted.

### Create `packages/types/src/subagent-context.ts`:

```typescript
import { WorkflowStep } from "cloudflare:workers";

export interface SubagentAiPrimitives {
  generateText: (prompt: string, opts?: { model?: string; temperature?: number }) => Promise<string>;
  generateObject: <T = any>(schema: Record<string, any>, prompt: string, opts?: { model?: string }) => Promise<T>;
}

export interface SubagentFsPrimitives {
  read: (path: string, opts?: { offset?: number; limit?: number }) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  edit: (path: string, oldString: string, newString: string) => Promise<boolean>;
  diff: (path: string, newContent: string) => Promise<{ hasChanges: boolean; patch: string }>;
  exists: (path: string) => Promise<boolean>;
}

export interface SubagentCliPrimitives {
  exec: (command: string, envVars?: Record<string, string>) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
  }>;
}

export interface SubagentVaultPrimitives {
  fetchWithAuth: (
    url: string,
    opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> }
  ) => Promise<Response>;
}

export interface SubagentBrowserPrimitives {
  scrape: (url: string, selector?: string) => Promise<{ title: string; content: string }>;
}

/**
 * The clean, functional context injected into Dynamic Workflow Subagents.
 * Strictly free of stateful DO stubs, WebSocket references, or thread management.
 */
export interface SubagentContext {
  ai: SubagentAiPrimitives;
  fs: SubagentFsPrimitives;
  cli: SubagentCliPrimitives;
  vault: SubagentVaultPrimitives;
  browser: SubagentBrowserPrimitives;
  step: WorkflowStep;
}

export interface SubagentExecutionResult<T = any> {
  success: boolean;
  taskId: string;
  data?: T;
  error?: string;
  durationMs: number;
}
```

---

## 3. The `SubagentTaskWorkflow` Implementation

Create the generic workflow engine in `workers/agents/src/workflows/SubagentTaskWorkflow.ts` that safely executes subagent task files:

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { SubagentContext, SubagentExecutionResult } from "@naelao/types";

export interface SubagentWorkflowPayload {
  spaceId: string;
  projectId: string;
  taskId: string;
  taskScriptPath: string; // e.g. "/.avos/shared/workflows/repomix-chunker.ts"
  params: Record<string, any>;
  originSessionId?: string;
}

export class SubagentTaskWorkflow extends WorkflowEntrypoint<Env, SubagentWorkflowPayload> {
  async run(
    event: WorkflowEvent<SubagentWorkflowPayload>,
    step: WorkflowStep
  ): Promise<SubagentExecutionResult> {
    const { spaceId, projectId, taskId, taskScriptPath, params } = event.payload;
    const startTime = Date.now();

    try {
      // 1. Step: Fetch Subagent Task Script from Workspace Storage
      const scriptCode = await step.do("load-subagent-script", async () => {
        const spaceDOId = this.env.SPACE_DO.idFromName(spaceId);
        const spaceDO = this.env.SPACE_DO.get(spaceDOId);
        const res = await spaceDO.fetch(`http://internal/workspace/file?path=${encodeURIComponent(taskScriptPath)}&project_id=${projectId}`);
        if (!res.ok) throw new Error(`Subagent task script not found at ${taskScriptPath}`);
        const data = await res.json() as { content: string };
        return data.content;
      });

      // 2. Step: Assemble Functional SubagentContext
      const subagentCtx: SubagentContext = {
        step,
        ai: {
          generateText: async (prompt, opts) => {
            const response = await this.env.AI.run(opts?.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
              prompt,
              temperature: opts?.temperature ?? 0.2
            });
            return (response as any).response || "";
          },
          generateObject: async (schema, prompt, opts) => {
            const raw = await this.env.AI.run(opts?.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
              prompt: `${prompt}\n\nEmit strictly valid JSON matching this schema:\n${JSON.stringify(schema)}`
            });
            return JSON.parse((raw as any).response);
          }
        },
        fs: {
          read: async (filePath) => {
            const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
            const res = await spaceDO.fetch(`http://internal/workspace/file?path=${encodeURIComponent(filePath)}&project_id=${projectId}`);
            const data = await res.json() as { content: string };
            return data.content;
          },
          write: async (filePath, content) => {
            const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
            await spaceDO.fetch(`http://internal/workspace/file`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ path: filePath, content, project_id: projectId })
            });
          },
          edit: async (filePath, oldString, newString) => {
            const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
            const res = await spaceDO.fetch(`http://internal/workspace/edit`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ path: filePath, oldString, newString, project_id: projectId })
            });
            return res.ok;
          },
          diff: async (filePath, newContent) => {
            return { hasChanges: true, patch: "" };
          },
          exists: async (filePath) => {
            const spaceDO = this.env.SPACE_DO.get(this.env.SPACE_DO.idFromName(spaceId));
            const res = await spaceDO.fetch(`http://internal/workspace/file?path=${encodeURIComponent(filePath)}&project_id=${projectId}`);
            return res.ok;
          }
        },
        cli: {
          exec: async (command, envVars) => {
            // Invokes virtual shell or container through the agent DO gateway
            const agentDO = this.env.NAELAO_AGENT_DO.get(this.env.NAELAO_AGENT_DO.idFromName(`${spaceId}:${projectId}:_subagent`));
            const res = await agentDO.fetch("http://internal/exec-command", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ command, envVars })
            });
            return await res.json() as any;
          }
        },
        vault: {
          fetchWithAuth: async (url, opts) => {
            return await fetch(url, {
              method: opts.method || "GET",
              body: opts.body ? JSON.stringify(opts.body) : undefined,
              headers: { ...opts.headers, "x-vault-credential": opts.credentialName }
            });
          }
        },
        browser: {
          scrape: async (url, selector) => {
            const res = await this.env.BROWSER_WORKER.fetch("http://internal/scrape", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url, selector })
            });
            return await res.json() as any;
          }
        }
      };

      // 3. Step: Execute Subagent Dynamic Task Function
      const taskResult = await step.do("execute-subagent-logic", async () => {
        // Dynamically instantiate task function
        const moduleFactory = new Function("exports", "require", scriptCode);
        const moduleExports: any = {};
        moduleFactory(moduleExports, () => {});
        
        const taskFn = moduleExports.run || moduleExports.execute || moduleExports.default;
        if (typeof taskFn !== "function") {
          throw new Error(`Subagent script at ${taskScriptPath} does not export a 'run' or 'execute' function.`);
        }

        return await taskFn(params, subagentCtx);
      });

      // 4. Step: Notify Parent DO of Completion
      await step.do("notify-parent-agent", async () => {
        if (event.payload.originSessionId) {
          const agentDO = this.env.NAELAO_AGENT_DO.get(this.env.NAELAO_AGENT_DO.idFromName(event.payload.originSessionId));
          await agentDO.fetch("http://internal/subagent/completed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              taskId,
              success: true,
              result: taskResult,
              durationMs: Date.now() - startTime
            })
          });
        }
      });

      return {
        success: true,
        taskId,
        data: taskResult,
        durationMs: Date.now() - startTime
      };
    } catch (err: any) {
      return {
        success: false,
        taskId,
        error: err.message || "Unknown subagent execution failure",
        durationMs: Date.now() - startTime
      };
    }
  }
}
```

---

## 4. Subagent Runner Helper (`workers/agents/src/script-engine/subagent-runner.ts`)

Implement the subagent orchestration helper for parent agents:

```typescript
import { SubagentWorkflowPayload } from "../workflows/SubagentTaskWorkflow";

export class SubagentRunner {
  constructor(private env: Env) {}

  /**
   * Spawns an asymmetric, durable subagent workflow execution.
   */
  async dispatchSubagentTask(payload: {
    spaceId: string;
    projectId: string;
    taskScriptPath: string;
    params: Record<string, any>;
    originSessionId?: string;
  }): Promise<{ workflowId: string; taskId: string }> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    
    const workflowPayload: SubagentWorkflowPayload = {
      ...payload,
      taskId
    };

    const instance = await this.env.AGENT_SUBAGENT_WORKFLOW.create({
      id: taskId,
      params: workflowPayload
    });

    return {
      workflowId: instance.id,
      taskId
    };
  }
}
```

---

## 5. Parent DO Hook & Receipt Card Emission (`workers/agents/src/do/NaelaoAgentDO.ts`)

In `NaelaoAgentDO.ts`, add the completion listener and receipt card generator:

```typescript
// Inside NaelaoAgentDO fetch router:
if (url.pathname === "/subagent/completed") {
  const body = await request.json() as {
    taskId: string;
    success: boolean;
    result: any;
    durationMs: number;
  };

  // 1. Log milestone to Project Journal
  if (this.currentProjectId) {
    const summaryText = body.result?.commit || body.result?.summary || `Completed task ${body.taskId}`;
    await this.ctx.storage.sql.exec(
      `INSERT INTO project_tasks (id, project_id, title, status, created_at) VALUES (?, ?, ?, 'COMPLETED', datetime('now'))`,
      body.taskId, this.currentProjectId, summaryText
    );
  }

  // 2. Append compact 2-line Receipt Card to session messages
  await this.appendReceiptCardMessage({
    taskId: body.taskId,
    title: body.result?.title || "Background Subagent Task",
    summary: body.result?.summary || "Successfully processed batch operations.",
    commitSha: body.result?.commitSha,
    durationMs: body.durationMs
  });

  return Response.json({ ok: true });
}
```

---

## 6. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/subagent-context.ts` defining `SubagentContext`, `SubagentAiPrimitives`, `SubagentFsPrimitives`, and `SubagentExecutionResult`.
2. Re-export `subagent-context.ts` from `packages/types/src/index.ts`.
3. Create `workers/agents/src/workflows/SubagentTaskWorkflow.ts` implementing `WorkflowEntrypoint<Env, SubagentWorkflowPayload>`.
4. Create `workers/agents/src/script-engine/subagent-runner.ts` providing `dispatchSubagentTask`.
5. Update `workers/agents/src/do/NaelaoAgentDO.ts` to handle `/subagent/completed` callbacks and generate compact receipt cards.
6. Run `node --check` syntax checks across all new and modified files.
```
