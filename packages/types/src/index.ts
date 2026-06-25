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

export type UserRole = "owner" | "admin" | "editor" | "viewer";

// ── Plan tiers ───────────────────────────────────────────────────────────────
export type PlanTier = "free" | "growth" | "business" | "enterprise";

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
