# Prompt 02: packages/types/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---


**Platform context:** Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects.
NO Node.js · NO PostgreSQL · NO Supabase. Data in SpaceDO SQLite. Worker comms via Service Bindings.
Routing via Hono. Auth via JWT (HMAC-SHA256). Billing via Lemon Squeezy (BillingProvider interface).
Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: "2025-01-01".

**Generate ONE file: `packages/types/src/index.ts`**

This is the single source of truth for all TypeScript types shared across Naelao workers.
It must export everything needed so workers never duplicate type definitions.

Include ALL of the following, fully typed (no `any`, no shortcuts):

### Identity & Auth
```typescript
export type SpaceStatus = 'active' | 'suspended' | 'paused' | 'deleted';
export type MemberRole  = 'owner' | 'admin' | 'member' | 'viewer';
export type BillingProvider = 'lemon_squeezy' | 'stripe';

export interface JWTPayload {
  sub: string;         // userId (UUID)
  spaceId: string;     // current space UUID
  rootSpaceId: string; // root/parent space UUID
  role: MemberRole;
  builderId: string;   // UUID of builder account
  exp: number;         // unix seconds
  iat?: number;
  // impersonation (admin only)
  impersonatedBy?: string;
  scope?: string[];
}
```

### Agent types
```typescript
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type FinishReason   = 'stop' | 'tool_calls' | 'max_tokens' | 'error' | 'timeout' | 'cancelled';
export type ToolCallStatus = 'pending' | 'running' | 'complete' | 'failed' | 'timeout';
export type FiberStatus    = 'idle' | 'running' | 'waiting_tool' | 'paused' | 'done' | 'error';

export interface AgentRun { id: string; agentId: string; spaceId: string; status: AgentRunStatus; ... }
export interface ToolCall { id: string; name: string; args: Record<string,unknown>; status: ToolCallStatus; ... }
export interface ToolResult { callId: string; runId: string; output: unknown; error?: string; }
export interface Message { id: string; threadId: string; role: 'user'|'assistant'|'tool'; content: string|ToolCall[]; createdAt: string; seq: number; }
```

### Space & member types
Include: `Space`, `SpaceMember`, `SpaceCreateParams`, `SpaceUpdateParams`

### Knowledge types
Include: `KnowledgeDoc` (id, spaceId, projectId, title, status: 'queued'|'indexing'|'ready'|'failed', chunkCount, errorMessage, createdAt), `KnowledgeChunk`

### Billing types
Include `NormalizedEventType`, `NormalizedBillingEvent`, `CheckoutParams`, `LemonSqueezyOrderPayload`, `LemonSqueezySubscriptionPayload` (full shapes as shown in the gap audit)

### Common API types
```typescript
export type APIResponse<T> = { data: T } | APIError;
export interface APIError { error: { code: string; message: string; details?: Record<string,unknown> } }
export function isAPIError(r: unknown): r is APIError;  // type guard
export function ok<T>(data: T): { data: T };
export function err(code: string, message: string, details?: Record<string,unknown>): APIError;
```

### Analytics
Export: `AnalyticsEventType` union of all event name strings, `AnalyticsDataPoint` interface, `AE` schema registry constant (see below)
```typescript
export const AE = {
  blobs:   { event_type: 0, user_id: 1, agent_id: 2, model_id: 3, run_id: 4, billing_provider: 5 },
  doubles: { credits_used: 0, duration_ms: 1, token_count: 2, amount_cents: 3, cache_hit_rate: 4, error_count: 5 },
} as const;
```

### Notification types
Include: `PushNotificationPayload`, `DeviceToken` (userId, token, platform: 'ios'|'android'|'web', registeredAt)

### MCP types
Include: `MCPTool` (name, description, inputSchema), `MCPToolCall`, `MCPToolResult`

Generate the complete file. Export everything. No `export default`. Pure TypeScript, no runtime code except `isAPIError`, `ok`, `err` helper functions and the `AE` constant.
