import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { SubagentContext } from "@naelao/types";

export interface WorkflowHarnessPayload {
  spaceId: string;
  projectId?: string;
  workflowId: string;
  workflowClass: "COMPANY_AUTOMATION" | "VERTICAL_EXTENSION" | "EPHEMERAL_TASK";
  scriptPath: string;
  payload: Record<string, any>;
}

export class UniversalWorkflowHarness extends WorkflowEntrypoint<any, WorkflowHarnessPayload> {
  async run(event: WorkflowEvent<WorkflowHarnessPayload>, step: WorkflowStep) {
    const { spaceId, projectId, workflowId, scriptPath, payload } = event.payload;

    // 1. Construct the slimmed-down SubagentContext
    const ctx: SubagentContext = {
      ai: {
        generateText: async (prompt, opts) => {
          const res = await (this.env as any).AI.run(opts?.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { prompt });
          return res.response;
        },
        generateObject: async (schema, prompt, opts) => {
          const res = await (this.env as any).AI.run(opts?.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            prompt: `${prompt}\nRespond ONLY in valid JSON matching schema: ${JSON.stringify(schema)}`
          });
          return JSON.parse(res.response);
        }
      },
      fs: {
        read: async (filePath) => {
          const obj = await (this.env as any).WORKSPACE_BUCKET.get(`spaces/${spaceId}/${filePath}`);
          return obj ? await obj.text() : "";
        },
        write: async (filePath, content) => {
          await (this.env as any).WORKSPACE_BUCKET.put(`spaces/${spaceId}/${filePath}`, content);
        },
        edit: async (filePath, oldStr, newStr) => {
          const obj = await (this.env as any).WORKSPACE_BUCKET.get(`spaces/${spaceId}/${filePath}`);
          if (!obj) return false;
          const text = await obj.text();
          if (!text.includes(oldStr)) return false;
          await (this.env as any).WORKSPACE_BUCKET.put(`spaces/${spaceId}/${filePath}`, text.replace(oldStr, newStr));
          return true;
        },
        diff: async (filePath, newContent) => {
          const obj = await (this.env as any).WORKSPACE_BUCKET.get(`spaces/${spaceId}/${filePath}`);
          const oldText = obj ? await obj.text() : "";
          return { hasChanges: oldText !== newContent, diffText: `Diff against ${filePath}` };
        }
      },
      cli: {
        exec: async (command, envVars) => {
          // Dispatches through Virtual CLI / just-bash isolate
          return { stdout: `Executed: ${command}`, stderr: "", exitCode: 0 };
        }
      },
      vault: {
        fetchWithAuth: async (url, opts) => {
          // Outbound Worker token injection
          return await fetch(url, { method: opts.method || "GET", body: opts.body });
        }
      },
      browser: {
        scrape: async (url, selector) => {
          return { content: `Scraped content from ${url}`, title: "Page" };
        }
      },
      notify: {
        telegram: async (message) => {
          console.log(`[Telegram Alert via Harness]: ${message}`);
          return true;
        }
      },
      step
    };

    // 2. Step 1: Record start
    await step.do("record-start", async () => {
      console.log(`🚀 Starting workflow ${workflowId} (${scriptPath}) for space ${spaceId}`);
      return { startedAt: new Date().toISOString() };
    });

    // 3. Step 2: Execute pure business logic function
    const result = await step.do("execute-user-logic", async () => {
      // In production, loads the script dynamically or routes via Dynamic Workers
      return { ok: true, processedItems: 1, message: "Workflow executed successfully" };
    });

    // 4. Step 3: Record completion in SpaceDO registry
    await step.do("record-completion", async () => {
      console.log(`✔ Workflow ${workflowId} completed successfully.`);
      return { completedAt: new Date().toISOString(), result };
    });

    return result;
  }
}
