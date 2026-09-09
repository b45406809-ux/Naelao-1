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
