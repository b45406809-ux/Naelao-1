/** Public contracts for code authored against the universal AVOS runtime. */
export type RuntimeScope = "USER_PRIVATE" | "SPACE_WIDE" | "PROJECT_BOUND";
/** Canonical installation scopes plus legacy names retained for already-installed manifests. */
export type GadgetScope = RuntimeScope | "PROJECT_SHARED" | "PROJECT_USER" | "SPACE_SHARED" | "SPACE_USER";

/** Canonical public identifiers. Component kinds are never inferred from shape. */
export type TemplateId = `tpl_${string}`;
export type ExtensionId = `ext_${string}`;

const TEMPLATE_ID_PATTERN = /^tpl_[a-z][a-z0-9_]{0,59}$/;
const EXTENSION_ID_PATTERN = /^ext_[a-z][a-z0-9_]{0,59}$/;

export function assertTemplateId(value: string): asserts value is TemplateId {
  if (!TEMPLATE_ID_PATTERN.test(value)) throw new Error(`invalid_template_id:${value}`);
}

export function assertExtensionId(value: string): asserts value is ExtensionId {
  if (!EXTENSION_ID_PATTERN.test(value)) throw new Error(`invalid_extension_id:${value}`);
}

/** Stable Tier-6 ABI. Backend names are never inferred from a URL or provider response. */
export type ContainerBackend =
  | "webcontainer"
  | "cloudflare_container"
  | "local_workstation";

export interface Tier6ContainerOptions {
  backend: ContainerBackend;
  /** Owner/user identity required when routing through LocalTunnelDO. */
  localUserId?: string;
  /** Explicit named machine; legacy user-only targeting is rejected. */
  localMachineId?: string;
  /** Lockfiles are portable state; dependency trees are explicitly non-portable. */
  lockfiles?: Readonly<Partial<Record<"package.json" | "package-lock.json", string>>>;
  migration?: Readonly<{ from: "webcontainer"; previewId: string }>;
}

export type SpaceCabinetWorkerId = "project_manager_worker" | "treasury_worker" | "identity_worker" | "comms_worker";
export interface SpaceCabinetTask { operation: string; params?: Record<string, unknown> }
export interface DelegateToSpaceWorkerInput { worker_id: SpaceCabinetWorkerId; task: SpaceCabinetTask }

/** Space-owned allowance used for a human's personal assistant runs. Cron/system actors omit it. */
export interface UserDailyBudgetEnvelope {
  space_id: string;
  user_id: string;
  daily_credit_limit: number;
  credits_spent_today: number;
  reset_at: string;
}

export type DailyBudgetDebitResult =
  | { ok: true; envelope: UserDailyBudgetEnvelope }
  | { ok: false; error_code: "daily_user_budget_exhausted"; envelope: UserDailyBudgetEnvelope };

export interface AppointmentAvailabilityQuery { startAt: string; endAt: string; timezone?: string; }
export interface CustomerBotServices {
  searchKnowledge(query: string, limit?: number): Promise<unknown>;
  getCannedResponse(key: string): Promise<string | null>;
  getAppointmentAvailability(query: AppointmentAvailabilityQuery): Promise<unknown>;
  escalateToHuman(reason: string): Promise<void>;
}

/** The intentionally tiny, physically isolated public-customer runtime surface. */
export interface CustomerBotContext {
  readonly executionTier: 2;
  readonly knowledge: Readonly<{ search(query: string, limit?: number): Promise<unknown> }>;
  readonly cannedResponses: Readonly<{ get(key: string): Promise<string | null> }>;
  readonly primaryCalendar: Readonly<{ availability(query: AppointmentAvailabilityQuery): Promise<unknown> }>;
  readonly escalateToHuman: (reason: string) => Promise<void>;
}

export type GadgetTier = 1 | 2 | 3;

/** Lifecycle declaration enforced by MicroAppDO, rather than trusted to UI code. */
export interface GadgetManifestLifecycle {
  gadgetTier: GadgetTier;
  scope: GadgetScope;
}
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

/** Configuration stored by a voice agent's human-facing management thread. */
export interface VoiceAgentConfig {
  greeting: string;
  businessHours: Record<string, { open: string; close: string } | null>;
  voiceModel: string;
  fallbackPhoneNumber?: string;
  timezone: string;
}

export type VoiceCallBookingState = "none" | "held" | "confirmed" | "reschedule_requested";

/** Durable audit record produced when an isolated telephone call thread terminates. */
export interface VoiceCallSummary {
  callSid: string;
  callerId: string;
  durationSeconds: number;
  sentimentScore: number;
  transcript: Array<{ role: "caller" | "assistant"; text: string; at: string }>;
  bookingState: VoiceCallBookingState;
  actionOutcomes: Array<{ action: string; ok: boolean; detail?: string }>;
}

/** Public manifest for the deliberately restricted 24/7 telephone receptionist. */
export interface VoiceAgentManifest {
  kind: "voice_agent";
  managementThreadTier: "tier_2_task";
  callThreadTier: "tier_3_consult";
  executionCeiling: 2;
  enabledTools: readonly ["primary_calendar", "faq_search"];
}

export type ProjectMode = "solo_cockpit" | "multiplayer_office";

/** Kernel-owned interaction layouts. Domain behavior belongs to Space Templates/extensions. */
export type ProjectKind = "DualPane" | "CanvasFirst" | "HeadlessPipeline" | "TerminalFirst";

/** User-facing complexity level. Business mode deliberately receives a redacted projection. */
export type DisplayMode = "business" | "developer";

/** Controls how much configuration and diagnostic detail the shell shows. This is a
 * presentation preference only and must never change an assistant's permissions. */
export type PresentationProfile = "guided" | "balanced" | "advanced";

export const PRESENTATION_PROFILES: readonly PresentationProfile[] = ["guided", "balanced", "advanced"];

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
  canvasPrimary: boolean;
  mount?: "right_sidebar";
  tab?: "Canvases";
}

/** Portable, secret-free representation of a Space. Version 2 is deliberately data-only. */
export interface BlueprintCredential {
  name: string;
  description: string;
  required: boolean;
}

export interface BlueprintTask {
  id?: string;
  title: string;
  status?: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  dependencies?: string[];
  assignedAgent?: string;
}

export interface BlueprintStarterFile {
  path: string;
  content: string;
}

export interface BlueprintProject {
  id?: string;
  name: string;
  kind: ProjectKind;
  templateMode: TemplateMode;
  viewports: Record<string, unknown>;
  systemPrompt: string;
  initialTasks: BlueprintTask[];
  starterFiles: BlueprintStarterFile[];
  configuration?: Record<string, unknown>;
  /** Optional declarations inspected by the marketplace capability firewall. */
  roles?: string[];
  capabilities?: string[];
  executionTier?: number;
}

export interface SpaceBlueprint {
  id: string;
  schemaVersion: "2.0";
  metadata: Record<string, unknown> & { name?: string; exportedAt?: string };
  templateCategory: string;
  projects: BlueprintProject[];
  requiredExtensions: string[];
  requiredCredentials: BlueprintCredential[];
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
  existingBranch?: string;
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
/** A role describes a worker; authority comes from its manifest and attested grants. */
export type UniversalAgentRole = string;

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

/** Present only when the host grants this installation access to the common Space drive. */
export type RuntimeSharedDrive = RuntimeFileSystem;

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
  /** Space owner configured OpenRouter worker pool; candidates still pass live-card checks. */
  workerModelIds?: string[];
  workerSelectionMode?: "automatic" | "planner";
  workerModelPriceCeiling?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number };
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
  /** Optional provider auth shape. Basic auth uses the vaulted secret as the password. */
  auth?: { type: "basic"; username: string };
  method?: string;
  /** Required for non-read methods so replay never repeats an external mutation. */
  idempotencyKey?: string;
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
import type { ConnectorProviderPreference } from "./connector-provider.js";

export interface RuntimeConnector {
  call(tool: string, params?: Record<string, unknown>, requiredScopes?: readonly string[]): Promise<unknown>;
  readonly [tool: string]: unknown;
}
export interface RuntimeConnectors {
  /** Provider-neutral lookup; the host resolves and enforces the workspace's authoritative pin. */
  get(appId: string, options?: ConnectorProviderPreference): RuntimeConnector;
  /** Backward-compatible alias for get(appId). */
  use(aliasName: string): RuntimeConnector;
}
export interface RuntimeConnectorAdapter {
  call(aliasName: string, tool: string, params: Record<string, unknown>, requiredScopes: readonly string[], options?: ConnectorProviderPreference): Promise<unknown>;
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
  sharedDrive?: RuntimeSharedDrive;
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
  /** Omit unless the active SPACE_SHARED installation has explicit filesystem grants. */
  sharedDrive?: RuntimeSharedDrive;
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

// Step 02 kernel contracts. These are deliberately domain-neutral; business roles and
// project templates belong to extensions, while the kernel only validates identifiers.
export type WorkerRole = string & { readonly __workerRoleBrand?: never };
export const WORKER_ROLE_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
export function assertWorkerRole(value: string): asserts value is WorkerRole {
  if (!WORKER_ROLE_PATTERN.test(value)) throw new Error("invalid_worker_role: use 2-64 lowercase letters, digits, '.', '_' or '-'");
}

export type KernelLayout = "DualPane" | "CanvasFirst";
export type ExecutionMode = "interactive" | "headless";
export type PermissionAction = "read" | "write" | "execute" | "network" | "admin";

export interface RelationalStateSubstrate { readonly name: "relational_state_git_mesh"; readonly version: string; }
export interface ComputeHypervisorSubstrate { readonly name: "compute_hypervisor"; readonly version: string; }
export interface UniversalToolSurface { readonly name: "universal_tool_surface"; readonly version: string; readonly tools: readonly string[]; }
export interface ZeroLeakVaultSubstrate { readonly name: "zero_leak_vault"; readonly version: string; }
export interface TunnelMeshSubstrate { readonly name: "tunnel_mesh"; readonly version: string; }
export interface KernelSubstrates {
  readonly state: RelationalStateSubstrate;
  readonly compute: ComputeHypervisorSubstrate;
  readonly tools: UniversalToolSurface;
  readonly vault: ZeroLeakVaultSubstrate;
  readonly tunnels: TunnelMeshSubstrate;
}
