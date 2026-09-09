import type { WorkflowStep } from "cloudflare:workers";

export interface SubagentContext {
  ai: {
    generateText: (prompt: string, opts?: { model?: string }) => Promise<string>;
    generateObject: <T = any>(schema: Record<string, any>, prompt: string, opts?: { model?: string }) => Promise<T>;
  };
  fs: {
    read: (path: string, opts?: { offset?: number; limit?: number }) => Promise<string>;
    write: (path: string, content: string) => Promise<void>;
    edit: (path: string, oldString: string, newString: string) => Promise<boolean>;
    diff: (path: string, newContent: string) => Promise<{ hasChanges: boolean; diffText: string }>;
  };
  cli: {
    exec: (command: string, envVars?: Record<string, string>) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  vault: {
    fetchWithAuth: (url: string, opts: { credentialName: string; method?: string; body?: any; headers?: Record<string, string> }) => Promise<Response>;
  };
  browser: {
    scrape: (url: string, selector?: string) => Promise<{ content: string; title: string }>;
  };
  notify: {
    telegram: (message: string) => Promise<boolean>;
  };
  step: WorkflowStep;
}
