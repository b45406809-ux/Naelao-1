// ── Core identity types ──────────────────────────────────────────────────────
export * from "./managed-billing-events.js";

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

const WORKSPACE_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8", jsonl: "application/x-ndjson; charset=utf-8", html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", cjs: "text/javascript; charset=utf-8",
  xml: "application/xml; charset=utf-8", csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  yaml: "application/yaml; charset=utf-8", yml: "application/yaml; charset=utf-8", toml: "application/toml; charset=utf-8",
  sh: "text/x-shellscript; charset=utf-8", py: "text/x-python; charset=utf-8", sql: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8", tsx: "text/plain; charset=utf-8", jsx: "text/plain; charset=utf-8",
  go: "text/plain; charset=utf-8", rs: "text/plain; charset=utf-8", java: "text/plain; charset=utf-8",
  c: "text/plain; charset=utf-8", h: "text/plain; charset=utf-8", cpp: "text/plain; charset=utf-8", hpp: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg; codecs=opus",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  zip: "application/zip", gz: "application/gzip", wasm: "application/wasm",
};

/** Infer only a known workspace extension; unknown or extensionless files remain opaque. */
export function inferWorkspaceContentType(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "application/octet-stream";
  return WORKSPACE_CONTENT_TYPE_BY_EXTENSION[name.slice(dot + 1)] ?? "application/octet-stream";
}

/** Preserve valid provider MIME metadata, but replace a missing or generic type with a known filename type. */
export function resolveFileContentType(filename: string, declared: unknown): string {
  const fallback = inferWorkspaceContentType(filename);
  if (typeof declared !== "string") return fallback;
  const normalized = declared.trim();
  if (normalized.length > 256 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/.test(normalized)) {
    return fallback;
  }
  return normalized.split(";", 1)[0]!.trim().toLowerCase() === "application/octet-stream" ? fallback : normalized;
}

/** Whether a MIME type is safe for the JSON text-preview route. */
export function isInlineTextContentType(value: string): boolean {
  const mimeType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json") ||
    mimeType === "application/xml" || mimeType.endsWith("+xml") ||
    ["application/yaml", "application/x-yaml", "application/toml", "application/x-ndjson", "application/sql", "application/rtf"].includes(mimeType);
}


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
  if (typeof now !== "number" || !Number.isFinite(now)) return false;
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) return false;
  const start = input.start || "", end = input.end || "";
  if (!start || !end || validateScheduledQuietHours(input)) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: input.timeZone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
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
export type UserRole = "owner" | "admin" | "editor" | "viewer" | "product_end_user" | "agent" | "team_api_key";

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

// ── Managed provider control plane ──────────────────────────────────────────
export type ManagedServiceCapabilityStatus = "draft" | "verified" | "disabled";
export type ManagedServiceConnectionMode = "naelao_managed" | "user_connected" | "provider_managed";
export type ManagedServiceOwnerType = "user" | "organization" | "agent";
export type ManagedServicePayerType = ManagedServiceOwnerType | "platform" | "provider";
export type ManagedServiceCreditPayerType = ManagedServiceOwnerType;
export type ManagedServiceLifecycleState =
  | "provisioning" | "active" | "billing_hold" | "suspended" | "retirement_review_required"
  | "revoking" | "revoked" | "retired" | "failed" | "unknown";
export type ManagedServiceOperationStatus =
  | "pending" | "running" | "complete" | "held" | "uncertain" | "failed" | "cancelled";

/** Versioned provider evidence; eligibility is granted only when an operator marks it verified. */
export interface ManagedServiceCapabilityManifest {
  provider: string;
  serviceId: string;
  version: number;
  category: string;
  operations: string[];
  regions: string[];
  connectionModes: ManagedServiceConnectionMode[];
  isolationModel: string;
  provisioning: Record<string, unknown>;
  metering: Record<string, unknown>;
  externalEffects: string[];
  evidence: Array<{ url: string; checkedAt: string; note?: string }>;
  status: ManagedServiceCapabilityStatus;
  verifiedBy: string | null;
  verifiedAt: string | null;
  validUntil: string | null;
}

export interface ManagedServiceOwnership {
  tenantId: string;
  spaceId: string;
  projectId?: string | null;
  ownerType: ManagedServiceOwnerType;
  ownerId: string;
  agentPortPrincipalId?: string | null;
  agentPortAgentId?: string | null;
  agentPortAccountId?: string | null;
}

export interface ManagedServicePayerMandate {
  payerType: ManagedServiceCreditPayerType;
  payerId: string;
  grantedBy: string;
  operationScopes: string[];
  maxCreditsPerOperation: number;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface ManagedServiceOperationReceipt {
  operationId: string;
  tenantId: string;
  provider: string;
  serviceId: string;
  operationName: string;
  idempotencyKey: string;
  requestSha256: string;
  status: ManagedServiceOperationStatus;
  reservationId?: string | null;
  priceVersion?: string | null;
  providerOperationRef?: string | null;
  resultRef?: string | null;
  errorCode?: string | null;
}
