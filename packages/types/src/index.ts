// ── Core identity types ──────────────────────────────────────────────────────
export type TenantId = string & { readonly _brand: "TenantId" };
export type SpaceId = string & { readonly _brand: "SpaceId" };
export type SpaceTypeId = string & { readonly _brand: "SpaceTypeId" };
export type SessionId = string & { readonly _brand: "SessionId" };
export type MessageId = string & { readonly _brand: "MessageId" };
export type UserId = string & { readonly _brand: "UserId" };
export type OrgId = string & { readonly _brand: "OrgId" };
export type DocId = string & { readonly _brand: "DocId" };
export type ToolId = string & { readonly _brand: "ToolId" };

export function asTenantId(s: string): TenantId { return s as TenantId; }
export function asSpaceId(s: string): SpaceId { return s as SpaceId; }
export function asSessionId(s: string): SessionId { return s as SessionId; }
export function asUserId(s: string): UserId { return s as UserId; }
export function asOrgId(s: string): OrgId { return s as OrgId; }
export function asDocId(s: string): DocId { return s as DocId; }

// ── JWT Claims ───────────────────────────────────────────────────────────────
export interface NaelaoJwtClaims {
  sub: string;        // userId
  tid: string;        // tenantId (orgId)
  email: string;
  role: UserRole;
  scopes: string[];
  iat: number;
  exp: number;
  jti: string;        // unique token ID for revocation
  // G-AD02: token version — must match users.token_version; incrementing revokes all tokens
  tv?: number;
}

// "product_end_user": a Three-Tier Platform Model end user authenticated against ProductUserDO
// (Phase 2) — NOT a platform Team collaborator. claims.tid for this role is still the product's
// OWNING tenant (the builder), so internal-HMAC + quota middleware keep working unchanged; only
// claims.sub (the end_user_id) and claims.role distinguish them. See
// workers/router/src/index.ts's product-session auth path and docs/spec-appendix A1.17 Phase 6.
// "agent" (§A1.17 Phase O): an agent acting through its own nak_... API key — the SAME routes a
// human builder/end-user can call, attributed to the agent itself rather than collapsing into the
// builder's identity. claims.tid is the owning space's tenant (like product_end_user); claims.sub
// is the agentId. A structurally different population from product_end_user (no platform tenant
// at all) — an agent key IS scoped to a tenant's space, just not to a human.
export type UserRole = "owner" | "admin" | "editor" | "viewer" | "product_end_user" | "agent";

// ── Plan tiers ───────────────────────────────────────────────────────────────
export type PlanTier = "free" | "growth" | "business" | "enterprise";

// ── Vertical-Scoped Model Curation & Enforcement ──────────────────────────────
export interface VerticalModelPolicy {
  /** Mode: "whitelist_only" (hard filter) vs "all_allowed" (standard) */
  mode: "whitelist_only" | "all_allowed";
  /** The exact allowed model IDs for this vertical */
  allowedModelIds: string[];
  /** Default selected model on space creation */
  defaultModelId: string;
  /** Can a space admin expand this list, or is it locked by compliance? */
  lockedByCompliancePolicy: boolean;
  /** UI Custom Category Label (e.g. "🏥 Clinically Vetted Models") */
  pickerHeaderLabel?: string;
}

// ── SpaceType / Template ──────────────────────────────────────────────────────
export interface SpaceTypeManifest {
  id: SpaceTypeId;
  version: string;
  name: string;
  description: string;
  systemPromptTemplate: string;
  tools: ToolDefinition[];
  kbConfig: KbConfig;
  modelConfig: ModelConfig;
  runtimeVersion: string;
  publishedAt?: string;
  status: "draft" | "published" | "deprecated";
}

export interface ToolDefinition {
  id: ToolId;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  requiresConfirmation?: boolean;
}

export interface KbConfig {
  maxDocuments: number;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  similarityThreshold: number;
}

export interface ModelConfig {
  provider: "anthropic" | "openai" | "google";
  model: string;
  maxTokens: number;
  temperature: number;
  cacheSystemPrompt: boolean;
}

// ── Space (deployed instance of a SpaceType) ─────────────────────────────────
export interface Space {
  id: SpaceId;
  tenantId: TenantId;
  spaceTypeId: SpaceTypeId;
  name: string;
  status: "active" | "paused" | "suspended" | "deleted";
  configOverrides: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Session + Message ─────────────────────────────────────────────────────────
export type SessionStatus = "active" | "completed" | "abandoned" | "error";
export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface SessionRecord {
  id: SessionId;
  spaceId: SpaceId;
  tenantId: TenantId;
  endUserId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface MessageRecord {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  createdAt: string;
  tokenCount?: number;
}

// ── KB Document ──────────────────────────────────────────────────────────────
export interface KbDocument {
  id: DocId;
  spaceId: SpaceId;
  title: string;
  sourceUrl?: string;
  contentType: "text" | "pdf" | "url" | "code";
  status: "pending" | "processing" | "indexed" | "failed";
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KbChunk {
  docId: DocId;
  chunkIndex: number;
  content: string;
  score?: number;
}

// ── Analytics events ─────────────────────────────────────────────────────────
export type AnalyticsEventType =
  | "session_start"
  | "message_sent"
  | "agent_response"
  | "tool_called"
  | "kb_retrieved"
  | "session_end"
  | "error"
  | "rating_submitted";

export interface AnalyticsEvent {
  timestamp: number;
  spaceId: SpaceId;
  tenantId: TenantId;
  sessionId?: SessionId;
  eventType: AnalyticsEventType;
  durationMs?: number;
  tokenCount?: number;
  errorCode?: string;
  rating?: number;
  metadata?: Record<string, string>;
}

// ── API error envelope ────────────────────────────────────────────────────────
export interface ApiError {
  error_code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string;
}

export interface ApiResponse<T> {
  data: T;
  request_id: string;
}

// ── Worker Env helpers ────────────────────────────────────────────────────────
export interface BaseEnv {
  PLATFORM_SECRET: string;
  ENVIRONMENT: "development" | "staging" | "production";
}

// ── Axis 6: 4-Tier Collaboration Model (Apple on the Surface, Linux at the Edge) ──
export type CollaborationTierLevel = 1 | 2 | 3 | 4;

export interface CollaborationLaneConfig {
  tier: CollaborationTierLevel;
  name: "Tier 1: Team Room" | "Tier 2: Task Workstations" | "Tier 3: System Consult Lanes" | "Tier 4: Private Scratchpad" | string;
  /** Human-friendly UI label in Business Mode */
  displayLabel: "Project Chat" | "Active Tasks" | "System Consult (Internal)" | "My Private Drafts" | string;
  /** Short description of the space */
  description?: string;
  visibility: "public_to_project" | "internal_system" | "strictly_private";
  interactionModel: "humans_and_at_mentions" | "feature_dag_and_at_mentions" | "internal_specialist_consult" | "private_direct_unmentioned";
  workspaceWritePermission: "full_execution" | "coordination_only" | "read_only_simulation";
  requiresAtMentionForAgents: boolean;
  canMutateFilesystem: boolean;
}

// ── Axis 6: Optimistic Concurrency Control (OCC) & Mutex ───────────────────────
export interface AstPatchOperation {
  file: string;
  findBlock: string;
  replaceBlock: string;
  expectedBaseHash: string;
  fuzzyThreshold?: number;
}

export interface OccConflictDetails {
  file: string;
  expectedHash: string;
  currentHash: string;
  isLocked: boolean;
  lockedBy?: string;
  nearbyLines?: string[];
  conflictDiff?: string;
}

export interface OccCommitResult {
  success: boolean;
  newHash?: string;
  bytesWritten?: number;
  conflict?: OccConflictDetails;
}

// ── Axis 7: 6-Tier Compute Execution Ladder ───────────────────────────────────
export type ExecutionTierLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface ComputeLadderTierDefinition {
  tier: ExecutionTierLevel;
  code: "VIRTUAL_FS" | "V8_ISOLATE" | "DYNAMIC_WORKFLOW" | "KITESURF_BROWSER" | "PUPPETEER_CHROMIUM" | "LINUX_CONTAINER";
  name: string;
  description: string;
  typicalColdStartMs: number;
  costWeight: number; // relative normalized cost
  capabilities: string[];
}

// ── Part 1: 3-Tier Scoped Knowledge Base (Mini-AGI ACL) ────────────────────────
export type MemberRoleRank = "viewer" | "member" | "editor" | "admin" | "owner";

export const ROLE_HIERARCHY_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

export interface ChunkVectorMetadata {
  space_id: string;
  project_id: string; // "" = Space-wide, otherwise specific projectId
  min_role_rank: number; // e.g. 4 for Admin-only documents
  doc_id: string;
  chunk_index?: number;
  title: string;
  text: string;
  source_url?: string;
}

// ── Part 2: Google Search AI Mode at the Edge ─────────────────────────────────
export interface SearchCitation {
  index: number;
  title: string;
  docId: string;
  snippet: string;
  sourceUrl?: string;
}

export interface GoogleModeSearchResult {
  text?: string;
  source: "SEMANTIC_CACHE" | "HYBRID_RRF" | "LIVE_WEB_GROUNDING";
  latencyMs: number;
  confidenceScore?: number;
  chunks?: Array<{ id: string; score: number; content?: string }>;
  citations: SearchCitation[];
}

// ── Part 3: Virtual FS Branching & Pull Request Engine ────────────────────────
export type PullRequestStatus = "OPEN" | "MERGED" | "REJECTED" | "CHANGES_REQUESTED";

export interface FileDiffItem {
  path: string;
  status: "MODIFIED" | "CREATED" | "DELETED";
  oldContent?: string;
  newContent?: string;
  oldHash?: string;
  newHash?: string;
  additions?: number;
  deletions?: number;
}

export interface PullRequestRecord {
  id: string;
  space_id: string;
  project_id: string;
  source_branch: string;
  target_branch: string;
  title: string;
  reasoning_summary: string;
  diff_manifest_json: string;
  diff_manifest?: FileDiffItem[];
  author_user_id: string;
  status: PullRequestStatus;
  created_at: string;
  merged_at?: string | null;
}

// ── Cloudflare Artifacts Multi-Agent Git Extensions (241-243) ─────────────────

export interface BranchDivergenceStatus {
  branch: string;
  upstreamBranch: string;
  commitsBehind: number;
  commitsAhead: number;
  baseCommit: string;
  upstreamHead: string;
  localHead: string;
  changedFiles: string[];
}

export type UpstreamReconcileStatus = "UP_TO_DATE" | "AUTO_REBASED" | "REVIEW_REQUIRED" | "CONFLICT_RESOLVED";

export interface UpstreamReconcileResult {
  status: UpstreamReconcileStatus;
  commitsPulled?: number;
  commitsBehind?: number;
  overlappingFiles?: string[];
  upstreamChangesSummary?: string;
  message: string;
  rebasedCommit?: string;
}

export interface ReasoningCommitMeta {
  author: string;
  goal?: string;
  rationale: string;
  task_id?: string;
  turn_number?: number;
  [key: string]: any;
}

export interface TurnCheckpointRecord {
  turn_number: number;
  commit_hash: string;
  message: string;
  reasoning?: string;
  files_changed: string[];
  created_at: string;
}

export interface BlameReasoningItem {
  line: number;
  content: string;
  commit_hash: string;
  author: string;
  goal?: string;
  rationale?: string;
  task_id?: string;
  timestamp: string;
}

export interface ModelBranchCandidate {
  modelId: string;
  branchName: string;
  commitHash: string;
  testsPassed: number;
  testsTotal: number;
  executionTurns: number;
  durationMs: number;
  score: number; // 0-100 normalized
  patchSummary: string;
}

export interface BranchRaceResult {
  taskId: string;
  winningModelId: string;
  winningBranch: string;
  winningScore: number;
  candidates: ModelBranchCandidate[];
  prId?: string;
  summary: string;
}

export interface AstConflictResolution {
  filePath: string;
  clean3WayMerge: boolean;
  resolvedContent: string;
  conflictsDetected: number;
  resolvedNodes: string[];
  manualReviewRequired: boolean;
}

// ── Template Feature Gating & Mutual Exclusivity Monetization ─────────────────
export type MonetizationModel = "FREEMIUM_TIERED_SAAS" | "FIXED_ONE_OFF_UNLOCKED";

export interface PlanTierAccessRule {
  allowedProjectKinds: string[];
  allowedPlugins: string[];
  maxExecutionTier: number;
  monthlyQueryAllowance: number;
}

export interface TierAccessRules {
  entryPlan: PlanTierAccessRule;   // $20 / mo (plans <= $25)
  growthPlan: PlanTierAccessRule;  // $50 / mo (plans $26 - $149)
  proPlan: PlanTierAccessRule;     // $150+ / mo (plans >= $150)
}

export interface TemplateFeatureGating {
  /** Enforce Mutual Exclusivity: Freemium Tiered SaaS ($0 upfront + gating) vs Fixed One-Off (100% unlocked) */
  monetizationModel: MonetizationModel;
  /** Set ONLY when monetizationModel === "FIXED_ONE_OFF_UNLOCKED" (e.g. 9900 = $99.00) */
  fixedPriceCents?: number;
  /** Set ONLY when monetizationModel === "FREEMIUM_TIERED_SAAS" (Upfront is always $0) */
  tierAccessRules?: TierAccessRules;
}

// ── Project Lifecycle & Sleep Cycles (Finite vs Standing Desks) ───────────────
export type ProjectLifecycle = "finite" | "continuous";
export type ProjectLifecycleStatus = "active" | "dormant" | "completed" | "sleeping";

export interface ProjectLifecycleEvent {
  projectId: string;
  spaceId: string;
  lifecycle: ProjectLifecycle;
  status: ProjectLifecycleStatus;
  totalTasks: number;
  completedTasks: number;
  message: string;
  hibernatedAt?: string;
}

// ── Connector Account Intelligence: 3-Layer Intent & Context Filter ───────────
export type ConnectorAccountScope = "personal" | "company_shared" | "business";

export interface ConnectorAccountOption {
  scope: ConnectorAccountScope;
  label: string;
  description: string;
  icon: string;
}

export interface ConnectorAccountResolution {
  connectorId: string;
  accountScope: ConnectorAccountScope;
  source: "thread_tier_default" | "linguistic_intent" | "composer_pill_override" | "clarification_prompt";
  confidence: number;
  userName?: string;
  companyName?: string;
  ambiguous?: boolean;
  options?: ConnectorAccountOption[];
}

export interface ConnectorScopePillState {
  connectorId: string;
  connectorName: string;
  activeScope: ConnectorAccountScope;
  accountLabel: string;
  icon: string;
}

export interface ConnectorClarificationCardMetadata {
  connector_id: string;
  prompt_question: string;
  options: Array<{
    scope: ConnectorAccountScope;
    label: string;
    description: string;
    icon?: string;
  }>;
  resolved_scope?: ConnectorAccountScope;
}




export type { BusinessBlueprint } from "./blueprint.js";
export type { AgentScope, AgentArchetypeRole, UniversalAgentManifest } from "./agent.js";
