# Prompt: All wrangler.jsonc files (all 21 workers)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate wrangler.jsonc for each of the 21 Naelao workers. Each file is placed at workers/<name>/wrangler.jsonc.

Global settings for ALL workers:
  compatibility_date: "2025-01-01"
  compatibility_flags: ["nodejs_compat"]
  main: "src/index.ts"

For ALL workers, include these KV namespaces:
  { binding: "NAELAO_CONFIG_KV", id: "$NAELAO_CONFIG_KV_ID" }
  { binding: "NAELAO_CIRCUIT_KV", id: "$NAELAO_CIRCUIT_KV_ID" }

CRITICAL (G-G24 fix): NO multi-line // comments. NO localConnectionString on DO bindings. Valid JSONC only.

Generate each wrangler.jsonc:

=== naelao-spaces/wrangler.jsonc ===
name: "naelao-spaces"
Durable Objects:
  SpaceDO { name: "NAELAO_SPACE_DO", class_name: "SpaceDO" }
  WalletDO { name: "NAELAO_WALLET_DO", class_name: "WalletDO" }
  ConcurrencyDO { name: "NAELAO_CONCURRENCY_DO", class_name: "ConcurrencyDO" }
  BuilderAccountDO { name: "NAELAO_BUILDER_DO", class_name: "BuilderAccountDO" }
Migrations: { tag: "v1", new_sqlite_classes: ["SpaceDO","WalletDO","ConcurrencyDO","BuilderAccountDO"] }

=== naelao-auth/wrangler.jsonc ===
name: "naelao-auth"
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces
Vars: ENVIRONMENT = "development"
Secrets (list only): NAELAO_JWT_SECRET

=== naelao-credentials/wrangler.jsonc ===
name: "naelao-credentials"
Secrets: NAELAO_MCP_MASTER_KEY, NAELAO_JWT_SECRET

=== naelao-threads/wrangler.jsonc ===
name: "naelao-threads"
Durable Objects: ThreadsDO { name: "NAELAO_THREADS_DO", class_name: "ThreadsDO" }
Migrations: { tag: "v1", new_sqlite_classes: ["ThreadsDO"] }
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces

=== naelao-knowledge/wrangler.jsonc ===
name: "naelao-knowledge"
Vectorize (CRITICAL G-G10 fix): { binding: "NAELAO_VECTORIZE", index_name: "naelao-knowledge-base" }
AI binding: { binding: "AI" }
R2: { binding: "NAELAO_R2", bucket_name: "naelao-knowledge-docs" }
Queues producer: NAELAO_ANALYTICS_QUEUE -> naelao-analytics
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces
Note in comment: Run before first deploy: wrangler vectorize create naelao-knowledge-base --dimensions=768 --metric=cosine

=== naelao-billing/wrangler.jsonc ===
name: "naelao-billing"
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces, NAELAO_WALLET_DO -> naelao-spaces
Queue producer: NAELAO_NOTIFICATIONS_QUEUE -> naelao-notifications
Queue consumer: { queue: "naelao-billing-events", max_batch_size: 10, max_retries: 5, dead_letter_queue: "naelao-billing-dlq" }
Secrets: LEMON_SQUEEZY_WEBHOOK_SECRET, LEMON_SQUEEZY_API_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY

=== naelao-analytics/wrangler.jsonc ===
name: "naelao-analytics"
Analytics Engine: { binding: "NAELAO_ANALYTICS", dataset: "naelao_events" }
Queue consumer (CRITICAL G-G14 fix): { queue: "naelao-analytics", max_batch_size: 100, max_retries: 5, dead_letter_queue: "naelao-analytics-dlq" }

=== naelao-notifications/wrangler.jsonc ===
name: "naelao-notifications"
Queue consumer: { queue: "naelao-notifications", max_batch_size: 50, max_retries: 3, dead_letter_queue: "naelao-notifications-dlq" }
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces

=== naelao-registry/wrangler.jsonc ===
name: "naelao-registry"
Durable Objects: SpaceTypeRegistryDO, AppRegistryDO, WorkflowRegistryDO (all SQLite)
Migrations: { tag: "v1", new_sqlite_classes: ["SpaceTypeRegistryDO","AppRegistryDO","WorkflowRegistryDO"] }
Queue producer: NAELAO_WORKFLOW_DISPATCH -> naelao-workflow-dispatch

=== naelao-agents/wrangler.jsonc ===
name: "naelao-agents"
Durable Objects: NaelaoAgentDO (SQLite, Unbound), LocalTunnelDO (SQLite)
Migrations: { tag: "v1", new_sqlite_classes: ["NaelaoAgentDO","LocalTunnelDO"] }
Usage model: unbound (for NaelaoAgentDO long-running)
Service Bindings: all other workers
Queues: NAELAO_ANALYTICS_QUEUE, NAELAO_WORKFLOW_DISPATCH
Secrets: TOGETHER_AI_API_KEY

=== naelao-mcp-hub/wrangler.jsonc ===
name: "naelao-mcp-hub"
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces

=== naelao-triggers/wrangler.jsonc ===
name: "naelao-triggers"
Queue producer: NAELAO_WORKFLOW_DISPATCH -> naelao-workflow-dispatch
Secrets: GITHUB_WEBHOOK_SECRET, LEMON_SQUEEZY_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET

=== naelao-workflows/wrangler.jsonc ===
name: "naelao-workflows"
R2: { binding: "NAELAO_WORKFLOW_R2", bucket_name: "naelao-workflows" }
Dispatch Namespace: { binding: "DISPATCH_NAMESPACE", namespace: "naelao-workers" }
Queue consumer: { queue: "naelao-workflow-dispatch", max_batch_size: 10, max_retries: 3 }

=== naelao-sweeper/wrangler.jsonc ===
name: "naelao-sweeper"
Triggers: { crons: ["* * * * *"] }  (every minute)
Queue producer: NAELAO_DLQ
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces, NAELAO_REGISTRY -> naelao-registry

=== naelao-provisioner/wrangler.jsonc ===
name: "naelao-provisioner"
R2: NAELAO_WORKSPACE, NAELAO_WORKFLOW_R2
Vectorize: NAELAO_VECTORIZE (same index as knowledge worker)
KV: also NAELAO_PORTAL_ROUTES (G-F10 fix)
Service Bindings: NAELAO_SPACE_DO, NAELAO_REGISTRY

=== naelao-together-ai/wrangler.jsonc ===
name: "naelao-together-ai"
Service Bindings: NAELAO_SPACE_DO, NAELAO_WALLET_DO (from naelao-spaces)
Queue producer: NAELAO_ANALYTICS_QUEUE
Secrets: TOGETHER_AI_API_KEY

=== naelao-admin/wrangler.jsonc ===
name: "naelao-admin"
Durable Objects: KillSwitchDO { name: "KILL_SWITCH_DO", class_name: "KillSwitchDO" }
Migrations: { tag: "v1", new_sqlite_classes: ["KillSwitchDO"] }
Analytics Engine: NAELAO_ANALYTICS
Service Bindings: NAELAO_SPACE_DO
Note: Protected by CF Access (configure in Cloudflare dashboard, not in wrangler)

=== naelao-eval/wrangler.jsonc ===
name: "naelao-eval"
Service Bindings: NAELAO_AGENTS -> naelao-agents

=== naelao-portal-router/wrangler.jsonc ===
name: "naelao-portal-router"
KV: NAELAO_PORTAL_ROUTES (separate from NAELAO_CONFIG_KV - G-F10 fix)
Service Bindings: NAELAO_SPACES -> naelao-spaces
routes: [{ pattern: "*.naelao.app/*" }, { pattern: "naelao.app/*" }]

=== naelao-artifact/wrangler.jsonc ===
name: "naelao-artifact"
R2: NAELAO_ARTIFACTS
KV: NAELAO_ARTIFACT_KV
Dispatch Namespace: { binding: "NAELAO_DISPATCH_NS", namespace: "naelao-workers" }

=== naelao-router/wrangler.jsonc ===
name: "naelao-router"
routes: [{ pattern: "api.naelao.com/*", zone_name: "naelao.com" }]
Service Bindings: ALL 20 other workers
This is deployed LAST.

