/** Public contracts for code authored against the universal AVOS runtime. */
export type RuntimeScope = "SPACE_WIDE" | "PROJECT_BOUND";

/** Public sovereign-permission contract shared by agent integrations. */
export type KnowledgeRole = "owner" | "admin" | "editor" | "member" | "viewer";
export type KnowledgeScope = "USER_PRIVATE" | "PROJECT_BOUND" | "SPACE_WIDE";
export interface KnowledgeCallerClaims {
  userId: string;
  role: KnowledgeRole;
  spaceIds: readonly string[];
  projectIds?: readonly string[];
}
export interface KnowledgeClearance {
  userId: string;
  role: KnowledgeRole;
  roleMask: number;
  spaceId: string;
  projectId?: string;
  scope: KnowledgeScope;
  allowedUserIds: readonly string[];
}

/** Declarative identity for every Naelao runtime. The kernel is shared; only this data varies. */
export type UniversalAgentRole =
  | "DEV_OPERATOR"
  | "GROWTH_OPERATOR"
  | "CUSTOMER_SUPPORT"
  | "ARCHITECT_DELEGATE"
  | "CUSTOM";

export interface UniversalAgentManifest {
  scope: RuntimeScope;
  role: UniversalAgentRole;
  prompts: {
    systemPrompt: string;
    instructions: string;
    userCustomInstructions?: string;
  };
  capabilities: { enabledPrebuilts: string[]; maxTier: number };
  autonomy: {
    approvalMode: "gate_listed" | "gate_unless_listed";
    autoApprovedActions: string[];
    requiresApprovalFor: string[];
  };
}

export interface RuntimeFileSystem {
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  edit(path: string, oldText: string, newText: string): Promise<void>;
  diff(path: string, contents: string): Promise<string>;
  grep(pattern: string, options?: { path?: string; glob?: string }): Promise<unknown>;
  glob(pattern: string): Promise<string[]>;
}

export interface RuntimeProject {
  readonly id: string;
  getJournal(): Promise<unknown>;
  updateJournal(update: unknown): Promise<unknown>;
  createTask(task: Record<string, unknown>): Promise<unknown>;
  listThreads(): Promise<unknown[]>;
  postMessage(threadId: string, message: string): Promise<unknown>;
}

export interface RuntimeSpace {
  readonly id: string;
  createProject(project: Record<string, unknown>): Promise<unknown>;
  listProjects(): Promise<unknown[]>;
  getWalletBalance(): Promise<unknown>;
  sendNotification(notification: Record<string, unknown>): Promise<unknown>;
}

export interface VaultFetchOptions {
  credentialName: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RuntimeVault {
  fetchWithAuth(url: string, options: VaultFetchOptions): Promise<Response>;
}

export interface RuntimeBrowser {
  navigate(url: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  type(selector: string, text: string): Promise<unknown>;
  extract(selector?: string): Promise<unknown>;
}

export interface RuntimeMcp {
  call(server: string, tool: string, params?: Record<string, unknown>): Promise<unknown>;
  listTools(server: string): Promise<unknown>;
}

/** A connector selected by a stable semantic name, never by a physical account handle. */
export interface RuntimeConnector {
  call(tool: string, params?: Record<string, unknown>, requiredScopes?: readonly string[]): Promise<unknown>;
  readonly [tool: string]: unknown;
}
export interface RuntimeConnectors { use(aliasName: string): RuntimeConnector; }
export interface RuntimeConnectorAdapter {
  call(aliasName: string, tool: string, params: Record<string, unknown>, requiredScopes: readonly string[]): Promise<unknown>;
}

export interface RuntimeRun {
  runSkill(name: string, args?: Record<string, unknown>): Promise<unknown>;
}
export interface RuntimeCli {
  run(command: string, args?: string[]): Promise<unknown>;
  /** Persist a deterministic parser in /.avos/bin and hot-mount it for this project. */
  register(name: string, source: string): Promise<string>;
}

export interface RuntimeContextBase {
  fs: RuntimeFileSystem;
  vault: RuntimeVault;
  browser: RuntimeBrowser;
  mcp: RuntimeMcp;
  connectors: RuntimeConnectors;
  run: RuntimeRun;
  cli: RuntimeCli;
}

export interface DelegateRequest {
  targetAgentId: string;
  task: string;
  handoverContext?: Record<string, unknown>;
}

export interface DelegationResult {
  targetAgentId: string;
  depth: 2 | 3;
  delegationToken: string;
}

export interface RuntimeDelegationAdapter {
  transfer(request: DelegateRequest & {
    currentDepth: 1 | 2;
    initiatorUserId: string;
    originatingRoleRank: number;
  }): Promise<DelegationResult>;
}

export interface RuntimeDelegateCapability {
  delegate(request: DelegateRequest): Promise<never>;
}

export type SpaceRuntimeContext = RuntimeContextBase & { space: RuntimeSpace; project?: never };
export type ProjectRuntimeContext = RuntimeContextBase & { project: RuntimeProject; space?: never };
export type RuntimeContext = SpaceRuntimeContext | ProjectRuntimeContext;

/** Host-side implementations. Secrets belong behind `vault.fetchWithAuth`, never in here. */
export interface RuntimeContextServices {
  fs: RuntimeFileSystem;
  vault: RuntimeVault;
  browser: RuntimeBrowser;
  mcp: RuntimeMcp;
  connectors: RuntimeConnectorAdapter;
  run: RuntimeRun;
  cli?: RuntimeCli;
  project?: Omit<RuntimeProject, "id">;
  space?: Omit<RuntimeSpace, "id">;
  delegation?: RuntimeDelegationAdapter;
}

export type CreateRuntimeContextOptions =
  | { scope: "SPACE_WIDE"; spaceId: string; services: RuntimeContextServices; delegationDepth?: 1 | 2 | 3; initiatorUserId?: string; originatingRoleRank?: number }
  | { scope: "PROJECT_BOUND"; projectId: string; services: RuntimeContextServices; delegationDepth?: 1 | 2 | 3; initiatorUserId?: string; originatingRoleRank?: number };
