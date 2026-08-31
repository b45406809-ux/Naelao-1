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

// ── Universal Agent Manifest & Configuration Hierarchy ─────────────────────────
export type AgentScope = "SPACE_WIDE" | "PROJECT_BOUND";
export type AgentArchetypeRole =
  | "DEV_OPERATOR"
  | "GROWTH_OPERATOR"
  | "CUSTOMER_SUPPORT"
  | "ARCHITECT_DELEGATE"
  | "CUSTOM";

export interface AgentPrompts {
  systemPrompt: string;              // Role definition & task framing
  instructions: string;              // Operating guidelines (agents.md)
  userCustomInstructions?: string;   // Founder's custom prompt overrides from the UI
}

export interface AgentCapabilities {
  enabledPrebuilts: string[];        // e.g. ["r2-workspace", "code-exec", "memory", "web-search"]
  installedPlugins: string[];        // e.g. ["plugin_legal_redline", "plugin_seo_linter"]
  maxTier: 1 | 2 | 3 | 4 | 5;        // 1 (Isolate) to 5 (Linux Container)
}

export interface AgentAutonomy {
  approvalMode: "always_ask" | "gate_unless_listed" | "yolo";
  autoApprovedActions: string[];
  requiresApprovalFor: string[];
}

export interface AgentTriggers {
  proactiveHeartbeat: boolean;       // true for Space Assistant, false for project agents
  cronSchedule?: string;             // e.g. "0 9 * * *" for daily reports
  reactiveToThreads: boolean;        // true for project agents responding to user chat
}

export interface UniversalAgentManifest {
  id: string;                        // e.g., "naelao-agent" (Assistant) or "custom_tax_auditor"
  name: string;                      // "Space Assistant" or "Senior Tax Analyst"
  description?: string;
  // 1. SCOPING & FILESYSTEM BOUNDARY
  // Space Assistant = Space-wide (`spaces/{spaceId}/workspace/`)
  // Project Agent   = Project-scoped (`spaces/{spaceId}/projects/{projectId}/workspace/`)
  scope: AgentScope;
  projectId?: string;
  // 2. ARCHETYPE ROLE & CAPABILITY FIREWALL
  role: AgentArchetypeRole;
  // 3. INSTRUCTION & PROMPT LAYERS
  prompts: AgentPrompts;
  // 4. TOOLSET & EXECUTION LADDER CEILING
  capabilities: AgentCapabilities;
  // 5. AUTONOMY & HITL APPROVAL POSTURE
  autonomy: AgentAutonomy;
  // 6. TRIGGER CADENCE (Proactive vs. Reactive)
  triggers: AgentTriggers;
}
