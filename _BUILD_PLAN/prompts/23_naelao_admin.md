# Prompt: workers/naelao-admin/src/index.ts

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate ONE file: workers/naelao-admin/src/index.ts

Platform operations dashboard. Requires CF Access in front (not JWT from naelao-auth).

CRITICAL FIXES:
- G-G07: Analytics Engine queries MUST use allowlist for eventType (no string interpolation)
- G-G15: Impersonation tokens MUST be scoped and time-limited
- spaceId in queries MUST be UUID-validated before interpolation

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_ANALYTICS_ACCOUNT_ID: string
  NAELAO_JWT_SECRET: string
  KILL_SWITCH_DO: DurableObjectNamespace

Routes (all require CF Access header 'CF-Access-Authenticated-User-Email'):

  GET  /v1/admin/spaces          paginated space list
  GET  /v1/admin/spaces/:id      space details + credit balance
  POST /v1/admin/spaces/:id/suspend   { reason: string }
  POST /v1/admin/spaces/:id/unsuspend

  GET  /v1/admin/audit?eventType=&spaceId=&limit=
    CRITICAL (G-G07 fix): eventType MUST be allowlisted:
    const ALLOWED_EVENT_TYPES = new Set(['agent_run_complete','tool_execution','token_usage','billing_payment_success','billing_payment_failed','security_rate_limit','security_webhook_forged','knowledge_indexed']);
    if (eventType && !ALLOWED_EVENT_TYPES.has(eventType)) return 400 error
    
    spaceId MUST be UUID validated:
    if (spaceId && !/^[0-9a-f-]{36}$/.test(spaceId)) return 400 error
    
    Query Analytics Engine with validated values (safe to interpolate after allowlist)

  POST /v1/admin/impersonate
    { targetUserId: string; scope: string[]; reason: string }
    CRITICAL (G-G15 fix):
    - scope MUST be subset of ['read:spaces','read:threads','read:agents']
    - Cannot include any write scopes
    - Token expires in 1 hour max
    - Log to Analytics: { event_type:'admin_impersonation', adminId, targetUserId, scope, reason }
    - Token payload: { sub: targetUserId, impersonatedBy: adminId, scope, exp: now+3600 }

  POST /v1/admin/kill-switch/activate    { reason: string }
    - Write to KV: emergency:kill-all-agents = '1', TTL 1 hour
    - Also activate KillSwitchDO: SET /active (G-F23 fix for <1ms propagation)
    - Log security event

  POST /v1/admin/kill-switch/deactivate
    - Delete KV key
    - Deactivate KillSwitchDO

  GET  /v1/admin/dlq-replay
    - List naelao-analytics-dlq messages
    - Re-queue to naelao-analytics queue (G-G14 fix)

