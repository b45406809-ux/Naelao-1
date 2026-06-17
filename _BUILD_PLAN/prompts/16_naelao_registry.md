# Prompt: workers/naelao-registry/src/ (4 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate FOUR files for workers/naelao-registry/src/.

Env:
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_JWT_SECRET: string
  SpaceTypeRegistryDO: DurableObjectNamespace
  AppRegistryDO: DurableObjectNamespace
  WorkflowRegistryDO: DurableObjectNamespace

=== File 1: src/SpaceTypeRegistryDO.ts ===

CRITICAL FIXES IN THIS FILE:
- G-G11: processCanaryRollouts MUST be called from a cron/alarm, not just defined
- G-F14: canary promotion needs minimum 50 sample events before promoting
- G-G17: implement stale-while-revalidate KV cache (not direct DO hit every time)

class SpaceTypeRegistryDO extends DurableObject<Env> using SQLite.

Schema:
  schema_version (version INTEGER PK DEFAULT 0)
  space_types (id TEXT PK, name TEXT, description TEXT, manifest TEXT, current_version TEXT,
               published_at TEXT, publisher_id TEXT, status TEXT DEFAULT 'active')
  versions (id TEXT PK, type_id TEXT, version TEXT, change_type TEXT, manifest TEXT,
            canary_pct INTEGER DEFAULT 0, canary_sample_count INTEGER DEFAULT 0,
            error_rate REAL DEFAULT 0, published_at TEXT, promoted_at TEXT)
  instances (space_id TEXT PK, type_id TEXT, version TEXT, created_at TEXT)

fetch routes:
  POST /types/register     { id; name; description; manifest; changeType; publisherId } -> { version }
  GET  /types/:id          -> space_type row (with caching: write to KV with 24h TTL + staleAt=1h)
  GET  /types              -> paginated list
  POST /canary/check       { typeId; spaceId } -> { version } (roll dice vs canary_pct)
  POST /canary/process     -> run processCanaryRollouts() (called by sweeper)

processCanaryRollouts():
  For each version with canary_pct < 100:
    Skip if canary_sample_count < 50 (minimum sample size - G-F14 fix)
    Skip if hours since published < 48
    If error_rate < 0.05: increase canary_pct (5 -> 20 -> 50 -> 100)
    If error_rate >= 0.05: rollback (set canary_pct = 0, mark version failed)

rollbackInstances(typeId, badVersion):
  UPDATE instances SET version = prev_stable_version WHERE type_id = ? AND version = ?

=== File 2: src/AppRegistryDO.ts ===

CRITICAL FIX (G-E05): App system prompts and UI instructions MUST be scanned for prompt injection before storage.

class AppRegistryDO extends DurableObject<Env> using SQLite.

Schema:
  apps (id TEXT PK, name TEXT, description TEXT, system_prompt TEXT, ui_instructions TEXT,
        publisher_id TEXT, status TEXT DEFAULT 'pending', scan_result TEXT,
        published_at TEXT, created_at TEXT)
  installs (space_id TEXT, app_id TEXT, installed_at TEXT, PRIMARY KEY(space_id, app_id))
  schema_version (version INTEGER PK DEFAULT 0)

SECURITY: handlePublish must scan content before storing:
  function scanForPromptInjection(text: string): { safe: boolean; reason?: string }
  Patterns to detect (reject if found):
    - 'ignore (all|previous|your) instructions' (case insensitive)
    - 'forget (everything|all|your training)'
    - 'new (persona|role|instructions)'
    - URLs in system prompts (exfiltration risk)
    - 'DAN' mode patterns

  If unsafe: set status='rejected', do not store the instructions
  If safe: set status='pending' (human review before 'active')
  Never set status='active' automatically - require manual approval

fetch routes:
  POST /apps/publish  { id; name; description; systemPrompt; uiInstructions; publisherId }
    -> Scan for injection (reject if detected)
    -> Store with status='pending'
    -> Return { status: 'pending'; message: 'Under review' }
  GET  /apps          paginated list of active apps
  POST /apps/:id/install { spaceId } -> { ok: true }
  GET  /apps/:id      -> app row (system_prompt only if status='active')

=== File 3: src/WorkflowRegistryDO.ts ===

class WorkflowRegistryDO extends DurableObject<Env> using SQLite.

Schema:
  workflows (id TEXT PK, space_id TEXT, name TEXT, code_r2_key TEXT,
             schedule TEXT, timezone TEXT DEFAULT 'UTC', next_run_at TEXT,
             status TEXT DEFAULT 'active', created_at TEXT)
  schema_version (version INTEGER PK DEFAULT 0)
  INDEX: idx_workflows_space ON workflows(space_id)
  INDEX: idx_workflows_next_run ON workflows(next_run_at, status)

CRITICAL FIX (G-F18): Use croner-compatible cron parsing, support timezone, validate at registration:
  function parseNextRun(schedule: string, timezone: string, after?: Date): Date
  - Parse 5-field cron: MIN HOUR DAY_OF_MONTH MONTH DAY_OF_WEEK
  - Handle all 5 fields correctly (do NOT skip day-of-month)
  - Convert timezone using Intl.DateTimeFormat
  - If schedule is invalid: throw Error('invalid_cron: ' + schedule)
  - Validate: if nextRun is > 1 year from now, reject as invalid

CRITICAL FIX (G-F18): Validate cron at registration time:
  try { parseNextRun(schedule, timezone) } catch { return 400 error }

alarm() fan-out (G-N52 fix):
  async alarm() {
    const due = this.sql.exec<{id:string}>('SELECT id FROM workflows WHERE next_run_at <= datetime("now") AND status="active"');
    await Promise.all([...due].map(wf => this.env.NAELAO_WORKFLOW_DISPATCH.send({ workflowId: wf.id })));
    // Update next_run_at for each
    this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

fetch routes:
  POST /workflows/register  { id; spaceId; name; codeR2Key; schedule; timezone } -> { nextRunAt }
    Validate cron, compute nextRunAt, store, set alarm if not already set
  GET  /workflows/:spaceId  -> list
  DELETE /workflows/:id     -> { ok: true }
  POST /workflows/:id/trigger -> immediate dispatch to queue

=== File 4: src/index.ts ===

Hono Worker routing to the three DOs above. All routes require authMiddleware.

  GET  /v1/registry/apps            -> AppRegistryDO list
  POST /v1/registry/apps            -> AppRegistryDO publish
  POST /v1/registry/apps/:id/install -> AppRegistryDO install
  GET  /v1/registry/space-types/:id -> SpaceTypeRegistryDO get (with KV cache)
  POST /v1/registry/workflows       -> WorkflowRegistryDO register
  GET  /v1/registry/workflows/:spaceId -> WorkflowRegistryDO list
  POST /v1/registry/canary/process  -> SpaceTypeRegistryDO processCanaryRollouts (admin only)

