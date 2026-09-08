export interface AgentScriptContext {
  projectId: string;
  spaceId: string;
  gatekeeperToken: string;
}

export interface AgentExecutionResult {
  success: boolean;
  artifactsCreated: string[];
  durationMs: number;
  error?: string;
}

export interface ScriptEngineConfig {
  maxExecutionTimeMs: number;
  allowedImports: string[];
  memoryLimitMb: number;
}

export interface WorkspaceFileUpdate {
  filePath: string;
  content: string;
  action: 'create' | 'edit' | 'delete';
}
