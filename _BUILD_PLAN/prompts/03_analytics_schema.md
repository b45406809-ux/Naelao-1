# Prompt 03: packages/analytics-schema/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---


**Platform context:** Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects.
NO Node.js · NO PostgreSQL · NO Supabase. Data in SpaceDO SQLite. Worker comms via Service Bindings.
Routing via Hono. Auth via JWT (HMAC-SHA256). Billing via Lemon Squeezy (BillingProvider interface).
Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: "2025-01-01".

**Generate ONE file: `packages/analytics-schema/src/index.ts`**

Cloudflare Analytics Engine uses **positional** blob1-blob20 and double1-double20 fields.
Adding a field at position 3 shifts everything after it, silently corrupting all queries.
This file is the single source of truth that prevents that.

Generate a strongly-typed schema registry with:

1. **Named position constants** for each event type:
```typescript
export const AGENT_RUN_SCHEMA = {
  blobs:   { event_type: 0, space_id: 1, agent_id: 2, run_id: 3, model_id: 4, billing_provider: 5 } as const,
  doubles: { credits_used: 0, duration_ms: 1, input_tokens: 2, output_tokens: 3, cost_usd: 4 } as const,
};
export const TOKEN_USAGE_SCHEMA = { ... };  // etc for each event type
export const BILLING_EVENT_SCHEMA = { ... };
export const SECURITY_EVENT_SCHEMA = { ... };
export const KNOWLEDGE_INDEX_SCHEMA = { ... };
```

2. **A typed `writeEvent` helper** for each event type:
```typescript
export function writeAgentRunEvent(ae: AnalyticsEngineDataset, params: AgentRunEventParams): void;
// Uses AGENT_RUN_SCHEMA positions, never raw numbers
```

3. **A typed `buildQuery` helper** that generates ClickHouse-compatible SQL using field name constants instead of raw blob1/double1 references.

4. **Schema version constant**: `export const SCHEMA_VERSION = 1 as const;`

Include event types for: agent_run_complete, tool_execution, token_usage, billing_payment_success, billing_payment_failed, security_rate_limit, security_webhook_forged, knowledge_indexed, knowledge_query.

Rule: **never use raw positional numbers** anywhere in the codebase except in this file.
Generate the complete file with all helpers.
