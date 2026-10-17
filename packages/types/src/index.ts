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

/** Normalize a saved BCP-47 language preference. */
export function normalizePreferredLanguage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 35) return null;
  const input = value.trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input)) return null;
  try { return Intl.getCanonicalLocales(input)[0] ?? null; } catch { return null; }
}

export interface ScheduledQuietHours {
  start: string | null | undefined;
  end: string | null | undefined;
  timeZone: string | null | undefined;
}

/** Validate a paired local-time quiet window and its IANA time zone. Empty endpoints disable it. */
export function validateScheduledQuietHours(input: ScheduledQuietHours): string | null {
  const start = input.start || "", end = input.end || "";
  if ((start === "") !== (end === "")) return "quiet_hours_start_and_end_must_be_paired";
  if (start && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end))) return "quiet_hours_time_invalid";
  try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone || "UTC" }).format(0); }
  catch { return "quiet_hours_timezone_invalid"; }
  return null;
}

/** True when a scheduled job's local-time quiet window contains this instant. */
export function isWithinScheduledQuietHours(input: ScheduledQuietHours, now: number): boolean {
  const start = input.start || "", end = input.end || "";
  if (!start || !end || validateScheduledQuietHours(input)) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: input.timeZone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const local = hour * 60 + minute;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const from = startHour! * 60 + startMinute!, to = endHour! * 60 + endMinute!;
  if (from === to) return false;
  return from < to ? local >= from && local < to : local >= from || local < to;
}

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
