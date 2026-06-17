# Prompt: workers/naelao-triggers/src/ (2 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite. Service Bindings for Worker comms. Hono for routing. JWT auth. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes /v1/. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-triggers/src/.

Env:
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_WORKFLOW_DISPATCH: Queue
  NAELAO_ANALYTICS: AnalyticsEngineDataset
  NAELAO_JWT_SECRET: string
  GITHUB_WEBHOOK_SECRET: string
  LEMON_SQUEEZY_WEBHOOK_SECRET: string
  STRIPE_WEBHOOK_SECRET?: string

=== File 1: src/verify-signature.ts ===

CRITICAL FIX (G-G09): NEVER return true for unimplemented providers.

  async function verifySignature(provider: string, rawBody: string, headers: Headers, env: Env): Promise<boolean>

  Implemented providers:
  
  'github':
    const sig = headers.get('X-Hub-Signature-256') ?? '';
    HMAC-SHA256(env.GITHUB_WEBHOOK_SECRET, rawBody), compare as 'sha256=' + hexSig
    Use constant-time comparison
  
  'lemon_squeezy':
    const sig = headers.get('X-Signature') ?? '';
    HMAC-SHA256(env.LEMON_SQUEEZY_WEBHOOK_SECRET, rawBody), compare as hexSig
    Use constant-time comparison
  
  'stripe':
    Parse 'Stripe-Signature' header: t=timestamp,v1=hexsig
    Verify: HMAC-SHA256(env.STRIPE_WEBHOOK_SECRET, timestamp + '.' + rawBody)
    Reject if |Date.now()/1000 - timestamp| > 300 seconds
    Use constant-time comparison

  Unimplemented providers: return false immediately (NEVER return true as default)
  
  Constant-time compare (implement manually - no timingSafeEqual in CF Workers):
    function timingSafeEqual(a: string, b: string): boolean {
      if (a.length !== b.length) return false;
      let result = 0;
      for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return result === 0;
    }

=== File 2: src/index.ts ===

CRITICAL FIX (G-G18): extractEventType MUST be implemented (was undefined in spec).

  function extractEventType(provider: string, payload: unknown, headers: Headers): string
  - 'github': return headers.get('X-GitHub-Event') + '.' + (payload as any).action
  - 'lemon_squeezy': return (payload as any).meta?.event_name ?? 'unknown'
  - 'stripe': return (payload as any).type ?? 'unknown'
  - default: return 'unknown'

Routes:
  POST /v1/webhooks/:provider/:spaceId
    1. Read raw body as text BEFORE any parsing
    2. Verify signature: if (!await verifySignature(provider, rawBody, headers, env)) return 401
    3. CRITICAL (G-G18 fix): parse with try/catch + form-urlencoded fallback:
       let payload: unknown;
       try { payload = JSON.parse(rawBody); }
       catch { try { payload = Object.fromEntries(new URLSearchParams(rawBody)); } catch { payload = {}; } }
    4. Extract event type using extractEventType()
    5. Query SpaceDO for registered triggers matching (provider, eventType, spaceId)
    6. For each trigger: send to NAELAO_WORKFLOW_DISPATCH queue
    7. Return 200 immediately (async processing)
    
    Log to NAELAO_ANALYTICS: provider, spaceId, eventType, triggerCount

All webhook routes are PUBLIC (no auth middleware) - auth is via signature verification.

