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

CRITICAL FIXES FROM APPENDIX I AUDIT:
- G-I01: naelao-eval needs TOGETHER_AI_SERVICE, ANALYTICS_SERVICE, R2_EVAL_RESULTS, KV_EVAL_LOCK, MAX_EVAL_CONCURRENCY — NOT just NAELAO_AGENTS
- G-I02: naelao-triggers needs NAELAO_SPACE_DO service binding (for trigger lookup)
- G-I03: naelao-knowledge needs a NAELAO_KNOWLEDGE_QUEUE consumer binding (dedicated queue, NOT NAELAO_ANALYTICS_QUEUE)
- G-I06: naelao-agents MUST NOT have TOGETHER_AI_API_KEY secret; use NAELAO_TOGETHER_AI service binding instead
- G-I11: naelao-sweeper needs NAELAO_CONCURRENCY_DO service binding (-> naelao-spaces)
- G-I19: naelao-sweeper needs a DLQ queue consumer binding (not just producer) — add queue consumer export

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
Queues producers: NAELAO_ANALYTICS_QUEUE -> naelao-analytics-queue, NAELAO_KNOWLEDGE_QUEUE -> naelao-knowledge-index
Queues consumers: { queue: "naelao-knowledge-index", binding: "NAELAO_KNOWLEDGE_QUEUE", max_batch_size: 5, max_retries: 3, dead_letter_queue: "naelao-dlq" }
CRITICAL (G-I03 fix): Knowledge indexing jobs MUST use NAELAO_KNOWLEDGE_QUEUE (not NAELAO_ANALYTICS_QUEUE). Only analytics events go to NAELAO_ANALYTICS_QUEUE.
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
Service Bindings: NAELAO_SPACES -> naelao-spaces, NAELAO_AUTH -> naelao-auth, NAELAO_CREDENTIALS -> naelao-credentials, NAELAO_THREADS -> naelao-threads, NAELAO_KNOWLEDGE -> naelao-knowledge, NAELAO_BILLING -> naelao-billing, NAELAO_REGISTRY -> naelao-registry, NAELAO_TOGETHER_AI -> naelao-together-ai, NAELAO_MCP_HUB -> naelao-mcp-hub, NAELAO_ADMIN -> naelao-admin
CRITICAL (G-I06 fix): DO NOT add TOGETHER_AI_API_KEY secret. Agents MUST call Together AI via NAELAO_TOGETHER_AI service binding only (so credits are charged).
CRITICAL (G-I06 fix): Add NAELAO_TOGETHER_AI: Service to NaelaoAgentDO Env interface.
Queues: NAELAO_ANALYTICS_QUEUE, NAELAO_WORKFLOW_DISPATCH
Secrets: NAELAO_JWT_SECRET, PLATFORM_DAILY_CREDIT_CEILING_USD

=== naelao-mcp-hub/wrangler.jsonc ===
name: "naelao-mcp-hub"
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces

=== naelao-triggers/wrangler.jsonc ===
name: "naelao-triggers"
Queue producer: NAELAO_WORKFLOW_DISPATCH -> naelao-workflow-dispatch
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces
CRITICAL (G-I02 fix): NAELAO_SPACE_DO service binding is required for trigger lookup. Without it, every inbound webhook fails with TypeError at step 5 (SpaceDO trigger query).
Secrets: GITHUB_WEBHOOK_SECRET, LEMON_SQUEEZY_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET

=== naelao-workflows/wrangler.jsonc ===
name: "naelao-workflows"
R2: { binding: "NAELAO_WORKFLOW_R2", bucket_name: "naelao-workflows" }
Dispatch Namespace: { binding: "DISPATCH_NAMESPACE", namespace: "naelao-workers" }
Queue consumer: { queue: "naelao-workflow-dispatch", max_batch_size: 10, max_retries: 3 }

=== naelao-sweeper/wrangler.jsonc ===
name: "naelao-sweeper"
Triggers: { crons: ["* * * * *"] }  (every minute)
Queue producers: NAELAO_DLQ -> naelao-dlq, NAELAO_WORKFLOW_DISPATCH -> naelao-workflow-dispatch
Queue consumers: { queue: "naelao-dlq", max_batch_size: 100, max_retries: 0 }  (CRITICAL G-I19 fix: sweeper IS the DLQ consumer; remove sweepDLQ() pull pattern)
Service Bindings: NAELAO_SPACE_DO -> naelao-spaces, NAELAO_CONCURRENCY_DO -> naelao-spaces, NAELAO_REGISTRY -> naelao-registry
CRITICAL (G-I11 fix): NAELAO_CONCURRENCY_DO service binding is required. Without it sweepAbandonedAgentRuns throws TypeError on every cron run, concurrency gate fills permanently.
CRITICAL (G-I19 fix): DLQ is push-delivered. sweeper must export a queue(batch, env) handler, NOT call a sweepDLQ() pull function.

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
CRITICAL (G-I01 fix): The following bindings are ALL required. Missing any of them makes the eval worker non-functional at runtime.
Service Bindings: NAELAO_AGENTS -> naelao-agents, TOGETHER_AI_SERVICE -> naelao-together-ai, ANALYTICS_SERVICE -> naelao-analytics
R2: { binding: "R2_EVAL_RESULTS", bucket_name: "naelao-eval-results" }
KV: { binding: "KV_EVAL_LOCK", id: "$NAELAO_EVAL_LOCK_KV_ID" }
Vars: MAX_EVAL_CONCURRENCY = "3"
Secrets: ADMIN_SECRET, EVAL_SPACE_ID

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

