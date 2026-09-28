/** Public contracts for code authored against the universal AVOS runtime. */
export type RuntimeScope = "USER_PRIVATE" | "SPACE_WIDE" | "PROJECT_BOUND";

export type GadgetScope = RuntimeScope;
export interface GadgetActorScope {
  scope: GadgetScope;
  appId: string;
  spaceId: string;
  projectId?: string;
  userId?: string;
}

export type DurableDaemonState = "STOPPED" | "RUNNING" | "PAUSED" | "ERROR";

export interface ProvenanceEntryInput {
  human_trigger_id: string;
  assistant_actor_id: string;
  project_executor_id: string;
  git_commit_oid: string;
  task_id?: string;
  created_at?: string;
}

export interface ProvenanceEntry extends Required<Omit<ProvenanceEntryInput, "task_id">> {
  task_id: string | null;
  prev_hash: string;
  entry_hash: string;
}

export type ActorAddressInput =
  | { scope: "USER_PRIVATE"; spaceId: string; userId: string }
  | { scope: "PROJECT_BOUND"; spaceId: string; projectId: string }
  | { scope: "SPACE_WIDE"; spaceId: string };

/** Conversation visibility is structural, rather than a UI-only convention. */
export type ThreadTier =
  | "tier_1_team"
  | "tier_2_task"
  | "tier_3_consult"
  | "tier_4_scratchpad";

export interface RuntimeThread {
  id: string;
  space_id: string;
  project_id: string | null;
  created_by: string | null;
  thread_tier: ThreadTier;
  system_internal: boolean;
}

export type ProjectMode = "solo_cockpit" | "multiplayer_office";

/** User-facing complexity level. Business mode deliberately receives a redacted projection. */
export type DisplayMode = "business" | "developer";

/**
 * Product taxonomy only. Both modes run the same autonomous kernel (including
 * planning, delegation and proactive REPL wakes); the mode selects seeded
 * projects, channels and viewports, never permissions.
 */
export type TemplateMode = "autonomous_venture_os" | "cowork_studio" | "autonomous_operator";

export interface UserInterfacePreferences {
  display_mode: DisplayMode;
}

export interface ViewportConfiguration {
  component: string;
  copilotPlacement: "docked" | "side_panel";
  canvasPrimary: true;
}

export interface ExecutionTelemetry {
  commit_oid?: string;
  git_oid?: string;
  raw_tier_id?: string;
  v8_cold_start_log?: string;
  token_breakdown?: Record<string, number>;
  [key: string]: unknown;
}

export interface TaskLeaseResult {
  success: boolean;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  status?: "CLAIMED" | "SPECTATING";
  activeLead?: string | null;
}

export interface IntentDeduplicationResult {
  duplicate: boolean;
  existingTaskId?: string;
  threadId?: string | null;
  similarity?: number;
}

export interface SponsorDirective {
  sponsorId: string;
  directive: string;
}

export interface SponsorRfcResult {
  id: string;
  projectId: string;
  status: "OPEN";
  executionStatus: "FROZEN_FOR_RFC";
}

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
  write(path: string, contents: string, options?: { expectedHash?: string }): Promise<void>;
  edit(path: string, oldText: string, newText: string, options?: { expectedHash?: string }): Promise<void>;
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

/** Server-enforced model controls attached to a vertical template or an individual space. */
export interface SpaceModelPolicy {
  mode: "open" | "whitelist_only";
  allowedModelIds: string[];
}

export interface SpaceCompliancePolicy {
  /** When enabled, inference may only use a local/* model through the on-premise tunnel. */
  airGappedOnly?: boolean;
}

export type ProjectLifecycle = "finite" | "continuous";

export interface CustomModelManifest {
  modelId: `custom/${string}`;
  baseModel: string;
  loraAdapterId: string;
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
  /** Call a registered external MCP server or a sibling project id in the current space. */
  call(server: string, tool: string, params?: Record<string, unknown>): Promise<unknown>;
  listTools(server: string): Promise<unknown>;
}

export interface ProjectMcpClientOptions {
  spacesWorker: { fetch(input: Request): Promise<Response> };
  spaceId: string;
  tenantId: string;
  internalToken: string;
  userId?: string;
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

/** The deliberately small capability surface given to an ephemeral subagent. */
export interface RuntimeAi {
  complete(request: { prompt: string; maxTokens: number; system?: string }): Promise<unknown>;
}

export interface RuntimeWorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}

/**
 * Subagents are execution functions, not actors.  In particular this type must never grow
 * thread, session, channel, presence, websocket, or delegation handles.
 */
export interface SubagentContext {
  readonly ai: RuntimeAi;
  readonly fs: RuntimeFileSystem;
  readonly cli: RuntimeCli;
  readonly vault: RuntimeVault;
  readonly step: RuntimeWorkflowStep;
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
