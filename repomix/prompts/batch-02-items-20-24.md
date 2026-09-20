# AI Studio implementation prompt — batch 02, plan items 20–24

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Runtime SDK, vault, WriteGuard, and virtual CLI**. This prompt is self-contained: the feature definitions and retained implementation
constraints have already been extracted and reconciled into the final specification below.
Do not seek or cite external design context. Repository code is evidence of current
state, not evidence that a requirement is complete.

When present, the **Final reconciled architectural changes** section is the newest authority in
this prompt. Where it updates or replaces a numbered plan requirement or retained constraint,
implement the new architecture and do not preserve the superseded behavior for compatibility.

## Non-negotiable production rules

- Trace and use the real router → authorization → worker/Durable Object → scoped persistence or
  binding → shell path. A helper, type, schema, comment, standalone endpoint, mock, or UI placeholder
  is not an implementation.
- Scope durable state and cache/index keys by every applicable tenant, space, project, invoker/user,
  actor, extension/gadget, and policy version. Conceal inaccessible private resources exactly like
  absent resources. Security-sensitive resolution fails closed.
- Reauthorize immediately before external side effects, artifact commits, merges, connector calls,
  workflow dispatch, and sibling-project calls. Preserve the original human invoker through every
  delegation and background boundary.
- Add migrations and identical development/staging/production Wrangler bindings, service bindings,
  queues, workflows, R2/KV/Vectorize/Analytics resources, secrets documentation, rotations,
  backfills, limits, alarms, and rollback behavior required by the feature.
- Add the real shell experience where applicable, including loading, empty, error, unauthorized,
  offline/reconnecting, spectator/frozen, air-gapped, and completed states. Treat model and source
  data as untrusted; never execute supplied HTML, JavaScript, URLs, or expressions.
- Add contract, isolation, race, replay, expiry, crash/hibernation, fail-closed, and router-to-worker
  journeys using realistic Cloudflare behavior. Success-only mocks may not replace authorization,
  transactions, bindings, namespace isolation, alarms, WebSockets, or Workflow behavior.
- Update the requirements trace matrix only after verification. Mark an item IMPLEMENTED only when
  every required production boundary and meaningful integration/E2E evidence exists.

## Final resolved implementation specification

### 20. Universal Runtime SDK (`ctx`)

**Final behavior:** Injected typed API namespace (`fs`, `project`, `space`, `vault`, `cli`, `browser`, `connectors`) giving scripts programmatic control over the workspace.

**Production acceptance contract:**
Production entry: isolate harness and `createRuntimeContext`; production code runner injects scoped proxies.
Persistence/deployment: no secret persistence in ctx; service bindings stay in host.
Required observable verification: code-runner/runtime tests execute scripts against ctx and assert omitted unavailable capabilities.

**Retained implementation constraints:**
- 90. **"Can't change assistant configs" root-caused to a one-word role check — and verifying the fix
    against production surfaced THREE more real bugs, including an infinite refetch loop that had
    been silently blanking the Dashboard. Plus the QClay-style composer dock and two real settings
    pages.**
    - **The reported bug.** `apps/shell`'s Dashboard gated every config control on
      `business?.role === "admin"` — an EXACT match. Whoever creates a business is inserted as
      `'owner'` (`workers/spaces/src/business-routes.ts`), and the backend ranks
      `owner(3) >= admin(2)` (`business-auth.ts`'s `ROLE_RANK`), so the server would have accepted
      every write the UI never offered: the creator of a business could not change their own
      assistant's autonomy, model, or approved actions. `spaces/[businessId]/page.tsx` had the
      same check written correctly (`=== "owner" || === "admin"`), which is how the two drifted.
      Fixed by extracting the ranked comparison into `apps/shell/src/lib/roles.ts`
      (`roleAtLeast`/`canManageSpaceSettings`, mirroring `ROLE_RANK`) and using it everywhere;
      `tests/unit/shell-role-gate.test.ts` asserts the UI predicate agrees with the REAL backend
      `resolveEndUserBusinessRole` for a business creator's actual stored row — verified to fail
      (3 of 7 cases) when the exact-match bug is reintroduced.
    - **Infinite refetch loop (found while verifying, pre-existing, worse than the reported bug).**
      Pages wrote `const creds = session ? {sessionToken, endUserId} : null` in the render body and
      listed `creds` in a data-loading effect's dependency array. That literal is a NEW object every
      render, so: the effect fires a batch of fetches → the first resolves and calls setState → the
      re-render mints a new `creds` → deps "changed" → React runs the cleanup, flipping the batch's
      `cancelled` flag and DISCARDING every result still in flight → a fresh batch starts. Forever.
      Visible damage: the Dashboard hammering the API in a loop, panels rendering "Couldn't read the
      capability list" / 0 members / 0 connectors even though those requests returned 200, and a
      "Loading…" that never cleared. Fixed with a memoised `useSessionCredentials()` hook
      (`auth-provider.tsx`), keyed on the primitive token/id.
      **Diagnostic technique worth keeping:** curl from the sandbox showed every endpoint 200 and
      fast, which looked like the server was fine and the clien
- Required Fix: Add optional COMPOSIO_API_KEY and PIPEDREAM_API_KEY Workers Secrets to mcp-hub. Key resolution per provider-routed server: (1) if the server row carries auth_secret_name , the builder's own vault credential wins (a builder running their own Composio project keeps full control and their own billing); (2) otherwise the PLATFORM key for that provider is injected server-side — the builder and end user never see it, never enter it; (3) if neither exists, fail with a clear "provider not configured on this platform" error. The platform key lives only inside mcp-hub (already the case for vault credentials — isolates receive only 60-second internal tokens). The reserved money-in tool-name guard is unchanged and applies to platform-keyed calls identically. Naelao's Composio spend becomes a platform cost recovered through credits, exactly like LLM tokens.
- - **G-BF02 — platform Composio/Pipedream keys in mcp-hub.** `COMPOSIO_API_KEY`/`PIPEDREAM_API_KEY`
  optional Workers Secrets; new `resolveProviderApiKey` — a BYO vault credential (`auth_secret_name`)
  still WINS when present (a builder running their own provider project keeps control + their own
  billing); otherwise the platform key is injected server-side and never leaves the worker; neither
  → honest 503 `provider_not_configured`. A BYO declaration that resolves to no key errors clearly
  (400) instead of silently falling back — fallback would mask the misconfiguration and bill
  Naelao's provider account. Applied to both provider branches (tools-list + tool-call); the
  reserved money-in tool-name guard covers platform-keyed calls identically. This closes §A1.18
  Phase P: the routing existed; the key model was the missing piece. Still needed for live use:
  `wrangler secret put COMPOSIO_API_KEY` per environment (degrades honestly until set); the
  per-user OAuth connect flow (G-BF03) and the curated universal catalogue entries (G-BF04) are
  the next increments.
- **G-BF08 — `free_tier_eligible` enforcement.** The flag existed since Phase F, was projected to
  the dashboard, and was never checked anywhere. New `workers/spaces/src/template-catalog.ts`
  (loadTemplateCatalog extracted from index.ts — preserving business-create.ts/create-space.ts's
  one-way import rule — with `free_tier_eligible` added to the projection and the KV cache key
  bumped to v2), plus `resolveOrgPlanTier` (unknown org → "free", fails CLOSED) and
  `checkFreeTierTemplateEligibility`. Gated at BOTH template entry points: `createBusinessForEndUser`
  (product businesses + reseller spaces — the plan checked is the OWNING builder org's, checked
  before any side effect) and `createSpaceRecord` (POST /spaces + /builder/products). Deliberate
  asymmetry, documented in code: the TIER lookup fails closed, but a genuinely UNAVAILABLE
  catalogue degrades OPEN — this is a monetization gate, not a security boundary, and failing
  closed would 403 every free-plan creation during an agents-worker outage (and break every
  dev/test env without the binding). `shell/manifest.template_catalog` now carries the flag for
  the create-business dialog.
- ### 1. The Universal `ctx` Runtime SDK Across All 6 Tiers
Every script executed in Tier 2 (Isolates), Tier 3 (Workflows), or Tier 6 (Containers) receives an authoritative, scoped `ctx` object:
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE AVOS RUNTIME SDK (`ctx`)                                         │
├───────────────────┬────────────────────────────────────────────────────────────────────────────────────┤
│ SDK Subsystem     │ Capabilities & Methods Exposed to the Script                                       │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 📁 `ctx.fs`       │ `read(path, {offset, limit})`, `edit(path, oldStr, newStr)`, `write(path, content)`,│
│                   │ `grep(pattern, path)`, `glob(pattern)`, `diff(path, newContent)`                  │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🏢 `ctx.space`    │ *(Space Assistant Only)*                                                          │
│                   │ `createProject(name, kind, templateId)`, `listProjects()`, `configureProject(id)`, │
│                   │ `getWalletBalance()`, `requestPayout(destId, cents)`, `sendNotification(title)`    │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 📋 `ctx.project`  │ `getJournal()`, `updateJournal(goal, status)`, `createTask(title, deps)`,         │
│                   │ `listThreads()`, `postMessage(threadId, text)`, `readRules()`                     │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🌐 `ctx.browser`  │ *(Tier 4/5)*                                                                       │
│                   │ `navigate(url)`, `click(selector)`, `type(selector, text)`, `extract(selector)`   │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ ⚡ `ctx.mcp`      │ `call(serverName, toolName, params)`, `listTools(serverName)`                      │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🔒 `ctx.vault`    │ `fetchWithAuth(url, { credentialName: "STRIPE_KEY" })` (Zero-Leak Secret Injection)│
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🔄 `ctx.run`      │ `runSkill(skillName, args)` (Call existing distilled skills in R2)                │
└───────────────────┴────────────────────────────────────────────────────────────────────────────────────┘
```
- ### 4. The `AVOS_SDK.d.ts` Reference Injected into the Agent Prompt
The agent receives this clean, complete TypeScript definition file in its context. Because LLMs are trained on millions of lines of TypeScript, **giving it standard types produces syntactically flawless code on Turn 1**:
```typescript
/**
* AVOS RUNTIME ENVIRONMENT DEFINITIONS (v2.0)
* Available in all Isolate CodeMode (Tier 2), Workflows (Tier 3), and Container (Tier 6) scripts.
*/
declare namespace ctx {
  namespace fs {
    function read(path: string, opts?: { offset?: number; limit?: number }): Promise<{ content: string; totalLines: number }>;
    function edit(path: string, oldString: string, newString: string): Promise<{ ok: boolean; message: string }>;
    function write(path: string, content: string): Promise<{ ok: boolean; bytesWritten: number }>;
    function grep(pattern: string, path?: string): Promise<{ matches: Array<{ file: string; line: number; text: string }> }>;
    function glob(pattern: string): Promise<{ files: string[] }>;
  }
  namespace project {
    const id: string;
    function getJournal(): Promise<{ goal: string; status: string; todos: Array<{ text: string; done: boolean }> }>;
    function updateJournal(status: string): Promise<{ ok: boolean }>;
    function createTask(title: string): Promise<{ ok: boolean }>;
    function listThreads(): Promise<Array<{ id: string; title: string }>>;
    function postMessage(threadId: string, text: string): Promise<{ ok: boolean }>;
  }
  // ONLY available in Space Assistant (CEO) context
  namespace space {
    const id: string;
    function createProject(name: string, kind: string, templateId?: string): Promise<{ id: string; name: string }>;
    function listProjects(): Promise<Array<{ id: string; name: string; kind: string }>>;
    function getWalletBalance(): Promise<{ balance_cents: number; currency: string }>;
    function sendNotification(title: string, body: string): Promise<{ ok: boolean }>;
  }
  namespace mcp {
    function call(server: string, tool: string, params: Record<string, any>): Promise<any>;
    function listTools(server: string): Promise<Array<{ name: string; description: string }>>;
  }
  namespace browser {
    function navigate(url: string): Promise<{ title: string; textContent: string }>;
    function click(selector: string): Promise<{ ok: boolean }>;
    function type(selector: string, text: string): Promise<{ ok: boolean }>;
    function extract(selector: string): Promise<string[]>;
  }
  function runSkill(skillName: string, args: Record<string, any>): Promise<any>;
}
```
- ### Summary of What This Achieves:
1. **True Metaprogramming:** The AI is not limited by a static set of tools. It has full programmatic access to its workspace via `ctx` and can automate any workflow the human could do.
2. **Deterministic RBAC:** The Space Assistant gets space-wide orchestration APIs (`ctx.space`); Project Agents are physically bounded to their project container (`ctx.project` & scoped `ctx.fs`).
3. **Zero Secret Leakage:** Vault credentials are resolved and injected transparently at the edge network boundary.
4. **Benchmark-Dominating Speed & Economy:** Composing loops and multi-step logic in code eliminates 90%+ of conversational turn latency and token bills.

### 21. Universal Vault Layer with Edge Outbound Workers

**Final behavior:** Zero-leak secret injection. Application code refers to logical credential names; Outbound Workers inject decrypted `Authorization` headers at the edge network boundary.

**Production acceptance contract:**
Production entry: credentials worker + MCP/security outbound path.
Persistence/deployment: encrypted credential rows; `CREDENTIALS_WORKER`, encryption secret.
Required observable verification: credential/MCP tests assert scripts see logical names only.

**Retained implementation constraints:**
- 93. **Channels made real (they could not reply at all), Telegram added, the webdev store made
    deterministic, and a live end-to-end run that found two more bugs — plus an OpenClaw/Hermes
    gap analysis in `docs/COMPETITIVE_2026-08-05_openclaw_hermes.md`.**
    - **Reported bug: the Channels panel could not connect anything.** It listed connected channels
      and offered no way to add one — the only connect route was `POST /channels/:channel/connect`,
      builder-only and left out of the router's end-user allowlist. New `POST /spaces/:spaceId/
      assistant/channels` (same path as the existing GET, `action` in the body — a dynamic segment
      followed by a static suffix is the shape that has repeatedly corrupted this codebase's Hono
      route tables), gated by `requireEndUserBusinessMembership` at a NEW admin floor: changing how
      a business is reached from outside is not a plain member action. Owner outranks admin (the
      item 90 bug, avoided here rather than repeated). Returns the webhook URL, since connecting on
      our side is only half of it. New `ChannelConnect` component in the shell.
    - **Unreported and worse: NO channel could reply.** `/internal/notify` handled email and
      returned `delivered:false` for everything else, so a customer could message a business on
      Slack/Discord/WhatsApp, the agent would run and produce a real answer, and the reply never
      left the building. Slack, Discord, WhatsApp and Telegram now send for real, resolving the
      space's own bot token from the vault at send time (`CHANNEL_SEND_CREDENTIAL` — a DIFFERENT
      secret from the inbound-verification one). Slack's 200-with-`ok:false` is treated as the
      failure it is. New `CREDENTIALS_WORKER` binding on the notifications worker.
    - **Telegram** (`ChannelType` gained a 5th member): free, no business verification, no
      per-message billing, no 24-hour reply window — the opposite of WhatsApp on every axis that
      matters to a $0-budget business, and the top gap the OpenClaw/Hermes analysis identified.
      Auth is unlike every other adapter: Telegram does not sign payloads, it echoes back a secret
      token the owner chose at `setWebhook` time, so this is a shared bearer secret compared in
      constant time, not a signature. Keys on the CHAT id (a group reply must go to the
      conversation, not the sender) and dedupes on `chat:message_id` since message_id is only
      unique per chat. Signal/iMessage deliberatel
- // workers/naelao-workflows/src/index.ts – deployWorkflow()
async function deployWorkflow(workflowId: string, code: string, env: Env): Promise<void> {
 const scriptName = env.DISPATCH_NAMESPACE_NAME + '-' + workflowId;
 const res = await fetch(
 `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE_NAME}/scripts/${scriptName}`,
 { method: 'PUT', headers: { 'Authorization': 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/javascript' }, body: code }
 );
 if (!res.ok) throw new Error('Deploy failed: ' + await res.text());
}
// Call deployWorkflow() on POST /workflows/:id (create/update) BEFORE storing to R2.
// Add CF_ACCOUNT_ID, CF_API_TOKEN, DISPATCH_NAMESPACE_NAME to Env and wrangler secrets.
- - **`packages/billing-core/src/providers/stripe.ts`** — fetch-based `StripeProvider`
  (form-encoded, no SDK): `verifyWebhook` (Stripe-Signature `t=…,v1=…` HMAC, 5-min tolerance,
  constant-time compare), `parseWebhookEvent` (checkout.session.completed → payment.success,
  subscription.*, charge.refunded → refund.issued; folds the Connect event's `account` into
  `metadata.stripe_account` and captures `payment_intent` — the ONE id shared between a
  checkout event and its later refund event), `createCheckout` (ad-hoc `price_data`, direct
  charge + application fee). Connect helpers: `createExpressAccount` / `createAccountLink` /
  `getAccountStatus`. LS provider gained `lsListStores` / `lsCreateWebhook` / `lsDeleteWebhook`.
- **Migration `0063_payment_connections`** — one live (non-disabled) connection per space
  (partial unique index, the 0040 technique); vault credential POINTERS only; indexed by
  `(provider, provider_account_id)` for webhook dispatch.
- **`workers/billing/src/wallet-connections.ts`** — HMAC-gated, owner/admin-only lifecycle
  routes (`GET/DELETE /billing/wallet/connection`, `POST /billing/wallet/connect/{stripe,
  lemon-squeezy}`), tenant/space ownership checked on every route; `role="agent"` can never
  manage payments. Disconnect keeps the row as an audit record (`disabled`), best-effort
  deletes the LS webhook, and deliberately never deletes the Stripe account (it's the
  builder's own business account — they keep it via their Express dashboard).
- **`workers/billing/src/wallet-checkout.ts`** — `/internal/commerce/checkout` (which the
  storefront also flows through) routes to the builder's provider when a connection is ACTIVE;
  no connection → the Naelao-store path byte-identical. **Fail-closed rule:** a broken rail on
  a connected space (missing platform key, unreachable vault) 503s rather than falling back —
  falling back would settle revenue into the wrong custody, the exact thing this feature
  prevents. The LS rail lazily provisions a product+variant ONCE on the builder's own store
  (cached in `details_json.product_variants`).
- **`workers/billing/src/wallet-webhooks.ts`** — two public signature-verified ingress routes
  (router-proxied like the platform LS webhook): `POST /v1/webhooks/stripe` (the platform's ONE
  Connect endpoint; connection resolved from the event's connected-account id) and
  `POST /v1/webhooks/lemon-squeezy/wallet/:connectionId` (per-connection vault secret; a
  builder controls their own store so t
- ### 1. The Universal `ctx` Runtime SDK Across All 6 Tiers
Every script executed in Tier 2 (Isolates), Tier 3 (Workflows), or Tier 6 (Containers) receives an authoritative, scoped `ctx` object:
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE AVOS RUNTIME SDK (`ctx`)                                         │
├───────────────────┬────────────────────────────────────────────────────────────────────────────────────┤
│ SDK Subsystem     │ Capabilities & Methods Exposed to the Script                                       │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 📁 `ctx.fs`       │ `read(path, {offset, limit})`, `edit(path, oldStr, newStr)`, `write(path, content)`,│
│                   │ `grep(pattern, path)`, `glob(pattern)`, `diff(path, newContent)`                  │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🏢 `ctx.space`    │ *(Space Assistant Only)*                                                          │
│                   │ `createProject(name, kind, templateId)`, `listProjects()`, `configureProject(id)`, │
│                   │ `getWalletBalance()`, `requestPayout(destId, cents)`, `sendNotification(title)`    │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 📋 `ctx.project`  │ `getJournal()`, `updateJournal(goal, status)`, `createTask(title, deps)`,         │
│                   │ `listThreads()`, `postMessage(threadId, text)`, `readRules()`                     │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🌐 `ctx.browser`  │ *(Tier 4/5)*                                                                       │
│                   │ `navigate(url)`, `click(selector)`, `type(selector, text)`, `extract(selector)`   │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ ⚡ `ctx.mcp`      │ `call(serverName, toolName, params)`, `listTools(serverName)`                      │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🔒 `ctx.vault`    │ `fetchWithAuth(url, { credentialName: "STRIPE_KEY" })` (Zero-Leak Secret Injection)│
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 🔄 `ctx.run`      │ `runSkill(skillName, args)` (Call existing distilled skills in R2)                │
└───────────────────┴────────────────────────────────────────────────────────────────────────────────────┘
```
- ### 3. The Zero-Leak Secret Injection Protocol
To ensure that API keys (Stripe secrets, GitHub tokens, database passwords) **never leak into the LLM context or conversation logs**:
1. Secrets live encrypted in `space_credentials` (AES-256-GCM).
2. The agent writes code referring only to the **credential name** (`ctx.vault.fetchWithAuth` or `ctx.mcp.call`).
3. The Cloudflare Worker injects the decrypted secret at the **edge network boundary** during the outbound fetch. The script code never holds `const key = "sk-live-..."`.
```typescript
// How the agent writes a script using vault credentials safely:
export async function run(args: any, ctx: any) {
  // The SDK automatically resolves 'STRIPE_API_KEY' inside the Worker runtime.
  // The secret is injected into the Authorization header at the network hop!
  const response = await ctx.vault.fetchWithAuth("https://api.stripe.com/v1/charges", {
    credentialName: "STRIPE_API_KEY",
    method: "POST",
    body: new URLSearchParams({ amount: args.amount, currency: "usd" })
  });
  return response.json();
}
```
- ### Summary of What This Achieves:
1. **True Metaprogramming:** The AI is not limited by a static set of tools. It has full programmatic access to its workspace via `ctx` and can automate any workflow the human could do.
2. **Deterministic RBAC:** The Space Assistant gets space-wide orchestration APIs (`ctx.space`); Project Agents are physically bounded to their project container (`ctx.project` & scoped `ctx.fs`).
3. **Zero Secret Leakage:** Vault credentials are resolved and injected transparently at the edge network boundary.
4. **Benchmark-Dominating Speed & Economy:** Composing loops and multi-step logic in code eliminates 90%+ of conversational turn latency and token bills.
- ### 2. Outbound Workers & WriteGuard: Zero-Trust Security at the Edge
When an agent writes code in Tier 2 CodeMode or executes scripts in Tier 6 Containers, you cannot give the script open internet access or direct database delete privileges.
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   OUTBOUND WORKER & WRITEGUARD PROXY                        │
│                                                                             │
│ [ Agent CodeMode Script / Container Tool Execution ]                        │
│                 │                                                           │
│                 ├──► Outbound HTTP Fetch (e.g. `fetch("https://api.stripe.com")`)
│                 │          │                                                │
│                 │          ▼                                                │
│                 │   ┌─────────────────────────────────────────────────────┐ │
│                 │   │ 🛡️ OUTBOUND WORKER (Egress Security Proxy)          │ │
│                 │   │ • Blocks SSRF (blocks `169.254.169.254`, localhost) │ │
│                 │   │ • Injects `Authorization: Bearer sk_live_...` at the│ │
│                 │   │   network boundary (Zero keys exposed in code).     │ │
│                 │   └─────────────────────────────────────────────────────┘ │
│                 │                                                           │
│                 └──► Database Mutation / Tool Call (e.g. `delete_workspace`)│
│                            │                                                │
│                            ▼                                                │
│                     ┌─────────────────────────────────────────────────────┐ │
│                     │ 🛑 WRITEGUARD (MCP Mutation Interceptor)             │ │
│                     │ • Inspects SQL AST & Tool parameters.               │ │
│                     │ • Blocks destructive operations (`DROP`, `DELETE *`)│ │
│                     │   unless accompanied by an authorized Gatekeeper    │ │
│                     │   cryptographic signature token.                    │ │
│                     └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```
- # 6. Is This Their Full Potential on Our Platform?
**No—their full potential happens when all 5 primitives interlock into a self-reinforcing autonomous cycle:**
```
                                  ┌──────────────────────────────────────────────┐
                                  │ 1. RADAR RESEARCHER SCOUTS GLOBAL TRENDS     │
                                  │ Detects a 60% surge in Dental SaaS searches. │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                                                         ▼
                                  ┌──────────────────────────────────────────────┐
                                  │ 2. AGENT COMPILES A STATEFUL MICRO-APP       │
                                  │ Uses DO Facets to spin up an instant SQLite  │
                                  │ booking app in 30 seconds.                   │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                                                         ▼
                                  ┌──────────────────────────────────────────────┐
                                  │ 3. BIDIRECTIONAL MCP-UI ON CANVAS            │
                                  │ Customer interacts with live app; agent sees │
                                  │ actions in real time and updates records.    │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                                                         ▼
                                  ┌──────────────────────────────────────────────┐
                                  │ 4. WRITEGUARD & OUTBOUND WORKERS SECURE EGRESS
                                  │ Secret credentials injected safely; invalid  │
                                  │ mutations blocked at edge boundary.          │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                                                         ▼
                                  ┌──────────────────────────────────────────────┐
                                  │ 5. PIPELINES + ICEBERG POWERS MARKET RADAR   │
                                  │ Ingests revenue telemetry to update the      │
                                  │ live template opportunity score to 98/100.   │
                                  └──────────────────────────────────────────────┘
```
- ### Summary of Platform Superpowers:
1. **Micro-Apps vs. Artifacts:** Artifacts are **versioned deliverables** (PDFs, Git commits). Micro-Apps are **stateful, living Artifacts** equipped with **DO Facet SQLite databases** and real-time **MCP-UI canvas action streaming**.
2. **WriteGuard & Outbound Workers:** Solves agent security by acting as an **unbypassable zero-trust edge firewall**, injecting credentials automatically and blocking destructive mutations.
3. **Pipelines & Iceberg:** Replaces slow database analytics with an **industrial streaming lakehouse on R2**, computing live Market Radar scores for thousands of templates simultaneously.
4. **gRPC over TCP:** Cuts communication latency between Durable Objects and Linux containers to **sub-5ms**.
5. **Radar Researcher:** Feeds global internet traffic trends into growth agents, allowing the platform to **autonomously identify and exploit profitable market opportunities.**

### 22. WriteGuard Mutation Interceptor

**Final behavior:** Edge proxy parsing SQL ASTs and tool parameters, blocking destructive operations (`DROP`, `DELETE *`, `rm -rf`) unless authorized by signed capability tokens.

**Production acceptance contract:**
Production entry: security gateway, tool runtime, virtual CLI and connector mutation gates.
Persistence/deployment: capability nonce/audit storage; `SECURITY_GATEWAY`.
Required observable verification: WriteGuard/adversarial tests cover SQL, shell, encoded parameters and invalid grants.

**Retained implementation constraints:**
- 108. **An autonomous business action that FABRICATED success — the worst failure this platform can
     have — found live, root-caused to a missing capability, fixed, and now proven real.**
     Asked to create a sellable product, the assistant replied: *"I've created the Standard Website
     Package… Price: $20… The product is now live on your storefront at shop-457302.naelao.com."*
     None of it existed — `launchpad_products` was empty platform-wide. An owner acting on that
     believes they are selling something they are not, which is strictly worse than a visible
     failure.
     - **Root cause was a capability gap, not only a model one.** The `commerce` prebuilt had
       exactly four operations — `checkout`, `seat_checkout`, `list_products`, `get_order`. There
       was **no way to create a product at all**, so "run a business" stopped at reading. The
       storefront UI has always had `POST /spaces/:id/products` and `PATCH .../products/:id`; the
       agent was simply never given them. Added `commerce.create_product` / `commerce.update_product`
       against those same already-tested routes, with publishing deliberately its OWN step rather
       than a flag on create (a product going on sale is the moment customers can pay for it —
       a decision, not a side effect of drafting), and errors carrying the upstream response body,
       because an agent told only "failed: 403" cannot report anything useful to its owner.
     - **PROVEN REAL, not taken on the model's word.** After the fix, the same request produced a
       product the agent reported as id `c210c785-43c0-42d4-ad7e-3391eabfbb97` — and an independent
       `GET /spaces/:id/products` returned that exact id, name and `price_cents: 2000`, status
       `draft`. $20 is the bottom of the Standard tier from item 105's pricing context, so the
       business's own published price list is now driving a real commercial decision. Always verify
       an agent's success claim against the datastore; this session it was false once and true once,
       and the answers read almost identically.
     - **A second failure the same run exposed: a tool call naming an OPERATION instead of an
       action was fatal.** The model emitted `knowledge.search` — not one of the five decision
       actions — and the run died with "unusable tool call … and no parseable text". Models trained
       to emit direct tool calls reach for the operation name constantly and the intent is
       unambiguous, s
- The Gap: The spec does not define how builders invite team members to collaborate on their Spaces. No invitation flow, role assignment (owner, editor, viewer), or permission enforcement per role exists. BuilderDO has no team membership concept.
 Required Fix: Add team model to BuilderDO SQLite: CREATE TABLE team_members (member_id TEXT, role TEXT CHECK(role IN ("owner","editor","viewer")), invited_by TEXT, joined_at INTEGER, status TEXT) . Invitation: generate signed token (HMAC-SHA256, 48-hour expiry), email invitee, on acceptance add member row. Role enforcement: Worker middleware checks team_members before write operations — viewers get 403 on mutations. Owner can transfer ownership. Cascade remove member on builder account delete.
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the assistant's own base grant, exactly as the clamp's SpaceDO doc always
  specified.
- **Read-only enforcement** (`ScriptEngineEnv.effectiveRole` + `ScriptToolSurface`, the `maxTier`
  structural precedent): `"viewer"` (which is also what `read_only` maps to server-side, even for
  a project owner) refuses `script.create/update/delete`, every STORED script (arbitrary
  agent-authored code is assumed mutating — fail closed), and any prebuilt op not on the explicit
  read-safe allowlist in the new `script-engine/assistant-access.ts` (`READ_SAFE_PREBUILT_OPS` —
  small and explicit like wallet.ts's credential-name list; a new prebuilt op is write-gated until
  consciously classified). `script.read`/`script.find` and read ops (read_file, knowledge.search,
  wallet.balance, project.list, ...) still work.
- **Approval-policy intersection** (`resolveAssistantApprovalPlan`, pure + unit-tested): `yolo`
  now fully applies only for system wakes (no `x-naelao-role` — the autonomous operation the owner
  configured it for) and owner/admin callers (who could self-authorize any gated action anyway);
  every other verified caller role — editor/viewer builders, `product_end_user`, `agent` API keys,
  and unrecognized roles (fail closed) — downgrades to the always_ask posture
  (`gate_unless_listed` + the policy's own `auto_approved_actions`).
- **Two escape hatches closed while wiring:** (1) `POST /agents/:agentId/script/run` (the worker's
  script-first entrypoint, whose own doc says "owner-initiated calls arrive with the usual
  JWT-derived headers") silently DROPPED `x-naelao-user-id`/`x-naelao-role` when forwarding to the
  DO — so not just the clamp but also handleScriptRun's per-caller billing branches could never
  apply to runs entering there; both headers are now forwarded (the ro
- ### 2. Outbound Workers & WriteGuard: Zero-Trust Security at the Edge
When an agent writes code in Tier 2 CodeMode or executes scripts in Tier 6 Containers, you cannot give the script open internet access or direct database delete privileges.
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   OUTBOUND WORKER & WRITEGUARD PROXY                        │
│                                                                             │
│ [ Agent CodeMode Script / Container Tool Execution ]                        │
│                 │                                                           │
│                 ├──► Outbound HTTP Fetch (e.g. `fetch("https://api.stripe.com")`)
│                 │          │                                                │
│                 │          ▼                                                │
│                 │   ┌─────────────────────────────────────────────────────┐ │
│                 │   │ 🛡️ OUTBOUND WORKER (Egress Security Proxy)          │ │
│                 │   │ • Blocks SSRF (blocks `169.254.169.254`, localhost) │ │
│                 │   │ • Injects `Authorization: Bearer sk_live_...` at the│ │
│                 │   │   network boundary (Zero keys exposed in code).     │ │
│                 │   └─────────────────────────────────────────────────────┘ │
│                 │                                                           │
│                 └──► Database Mutation / Tool Call (e.g. `delete_workspace`)│
│                            │                                                │
│                            ▼                                                │
│                     ┌─────────────────────────────────────────────────────┐ │
│                     │ 🛑 WRITEGUARD (MCP Mutation Interceptor)             │ │
│                     │ • Inspects SQL AST & Tool parameters.               │ │
│                     │ • Blocks destructive operations (`DROP`, `DELETE *`)│ │
│                     │   unless accompanied by an authorized Gatekeeper    │ │
│                     │   cryptographic signature token.                    │ │
│                     └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```
- #### Why WriteGuard is Essential for AVOS:
* If a customer-facing bot or untrusted agent is tricked by a prompt injection (*"Delete all records in the table"*), **WriteGuard intercepts the raw SQL AST / MCP tool mutation at the Worker proxy layer and blocks it**, returning an authorization violation before the SQLite database is ever touched.
- ### Summary of Platform Superpowers:
1. **Micro-Apps vs. Artifacts:** Artifacts are **versioned deliverables** (PDFs, Git commits). Micro-Apps are **stateful, living Artifacts** equipped with **DO Facet SQLite databases** and real-time **MCP-UI canvas action streaming**.
2. **WriteGuard & Outbound Workers:** Solves agent security by acting as an **unbypassable zero-trust edge firewall**, injecting credentials automatically and blocking destructive mutations.
3. **Pipelines & Iceberg:** Replaces slow database analytics with an **industrial streaming lakehouse on R2**, computing live Market Radar scores for thousands of templates simultaneously.
4. **gRPC over TCP:** Cuts communication latency between Durable Objects and Linux containers to **sub-5ms**.
5. **Radar Researcher:** Feeds global internet traffic trends into growth agents, allowing the platform to **autonomously identify and exploit profitable market opportunities.**

### 23. Virtual CLI Interception Engine

**Final behavior:** Terminal commands (`stripe`, `gh`, `r2`, `jq`) run in <5ms inside V8 Isolates by intercepting binary calls and mapping them to edge REST fetches or Wasm.

**Production acceptance contract:**
Production entry: tool runtime virtual CLI dispatcher.
Persistence/deployment: registered command catalog in DO SQLite.
Required observable verification: virtual CLI tests cover parse, dispatch and tenant scope.

**Retained implementation constraints:**
- 90. **"Can't change assistant configs" root-caused to a one-word role check — and verifying the fix
    against production surfaced THREE more real bugs, including an infinite refetch loop that had
    been silently blanking the Dashboard. Plus the QClay-style composer dock and two real settings
    pages.**
    - **The reported bug.** `apps/shell`'s Dashboard gated every config control on
      `business?.role === "admin"` — an EXACT match. Whoever creates a business is inserted as
      `'owner'` (`workers/spaces/src/business-routes.ts`), and the backend ranks
      `owner(3) >= admin(2)` (`business-auth.ts`'s `ROLE_RANK`), so the server would have accepted
      every write the UI never offered: the creator of a business could not change their own
      assistant's autonomy, model, or approved actions. `spaces/[businessId]/page.tsx` had the
      same check written correctly (`=== "owner" || === "admin"`), which is how the two drifted.
      Fixed by extracting the ranked comparison into `apps/shell/src/lib/roles.ts`
      (`roleAtLeast`/`canManageSpaceSettings`, mirroring `ROLE_RANK`) and using it everywhere;
      `tests/unit/shell-role-gate.test.ts` asserts the UI predicate agrees with the REAL backend
      `resolveEndUserBusinessRole` for a business creator's actual stored row — verified to fail
      (3 of 7 cases) when the exact-match bug is reintroduced.
    - **Infinite refetch loop (found while verifying, pre-existing, worse than the reported bug).**
      Pages wrote `const creds = session ? {sessionToken, endUserId} : null` in the render body and
      listed `creds` in a data-loading effect's dependency array. That literal is a NEW object every
      render, so: the effect fires a batch of fetches → the first resolves and calls setState → the
      re-render mints a new `creds` → deps "changed" → React runs the cleanup, flipping the batch's
      `cancelled` flag and DISCARDING every result still in flight → a fresh batch starts. Forever.
      Visible damage: the Dashboard hammering the API in a loop, panels rendering "Couldn't read the
      capability list" / 0 members / 0 connectors even though those requests returned 200, and a
      "Loading…" that never cleared. Fixed with a memoised `useSessionCredentials()` hook
      (`auth-provider.tsx`), keyed on the primitive token/id.
      **Diagnostic technique worth keeping:** curl from the sandbox showed every endpoint 200 and
      fast, which looked like the server was fine and the clien
- Required Fix
 Never pass secrets as container env vars. Use a scoped credential-retrieval endpoint:
```typescript
// Container fetches a short-lived, request-scoped token from an internal endpoint
// instead of receiving raw keys:
// GET http://credentials.internal/get?provider=stripe&runId=...
// returns a signed token valid for seconds, scoped to this run and provider.
const token = await fetch(`http://credentials.internal/get?provider=${p}&runId=${runId}`,
 { headers: { "x-run-attestation": runAttestation } }).then(r => r.text());
```
If env injection is unavoidable, mount secrets as a read-only tmpfs file with restrictive permissions and clear them after the command, and disable shell history in the container.
- **Scope correction, mid-phase, from the user directly:** a "Product" is not a storefront or any
commerce concept — the spec is explicit: *"NaelaoProduct is the core data model representing a
Tier 1 builder's deployed product. It wraps a configured Space."* (Section 48). The spec's own
examples are LexSpace/CodePilot/FirmAI — a legal tool, a coding tool, a law-firm tool — matching
the user's own analogy exactly. Journey 1B ("End User Joins a Builder's Product") describes
precisely the rich shell this phase builds: *"the product UI — threads, sub-spaces, knowledge
base — exactly as the builder configured it."* Nothing commerce-related appears in that journey
at all. Journey 2 ("Space Admin Sets Up a Launchpad Business") is a separate, lower-level thing —
installing a Stripe app, uploading digital goods, fulfillment webhooks — that happens to run
*inside* one Launchpad Product as one of its optional features, not something that defines what a
Product is. An earlier explanation in this session's chat (not committed anywhere) had
conflated a Launchpad business's own storefront/commerce feature with "the real product,"
describing them as competing concepts — corrected: every Product gets the same Journey-1B shell;
Launchpad Products can additionally run a storefront as one feature among several.

### 24. Just-In-Time (JIT) Virtual CLI Synthesis

**Final behavior:** When an agent encounters an unregistered CLI command, it synthesizes a 15-line parser using `ctx.cli.register`, compiling it into SQLite for instant future invocations.

**Production acceptance contract:**
Production entry: `VirtualCli.registerSynthesized`, script library.
Persistence/deployment: versioned parser source in SQLite/R2.
Required observable verification: synthesis tests reject eval/import and prove reload persistence.

**Retained implementation constraints:**
- 126. **Three more live-reported bugs, all root-caused to the SAME underlying gap: the reasoner's
     "available_operations" field was a bare flat list of 60+ op names with no description or
     grouping — plus two silent trace-persistence holes that hid real repeat/parked tool calls
     from the activity table.**
     - **The real root cause of "our API doesn't support programmatic thread creation or direct
       in-thread chat messaging"** (item 125 shipped exactly that capability the same session).
       `project-coordination` WAS wired into the assistant's prebuilt list and `tools.
       availableOperations()` DID include `thread.create`/`thread.send_message` in the payload —
       but only as bare strings among dozens of others, with zero indication of what any of them
       do or what parameters they take (unlike `candidate_scripts`, which carries a real
       description/parameters/health per entry). A model asked to "communicate with an agent
       directly in a thread" had no way to recognize an opaque name like `thread.send_message` as
       the answer. New `ScriptToolSurface.availableOperationsGrouped()` groups the same ops by
       their owning prebuilt SCRIPT, reusing that script's own (already-written) description —
       `reasoner.ts` now sends this grouped structure as `available_operations` instead of the
       flat list (falls back to the flat list when a caller/test doesn't supply groups), and
       `DECISION_INSTRUCTIONS` gained one sentence telling the model to read every group's
       description before concluding a capability doesn't exist. Zero new prose was written per
       operation — the fix is structural (grouping + reuse), not a bigger prompt.
     - **The intermittent "narration with no tool-call table underneath it," and the "it's sort of
       repeating the same task many times" observation — the SAME bug, now fixed.** `loop.ts`'s
       within-run repeat-call guard (an already-attempted `name+params` combo, or an action still
       sitting in `deferred` awaiting approval) correctly served the model a cached outcome and
       `continue`d — but neither branch ever called `pushTrace`, even though the "reason" step
       immediately before it (carrying that turn's own `narration`/`doing` text, e.g. "Checking
       Instagram MCP tools") always does. Every REPEAT attempt therefore showed a real status line
       with nothing in the table beneath it — exactly the reported screenshot, and exactly why it

- initSchema() creates all 8 SQLite tables without error on fresh DO
 initSchema() is idempotent — calling twice does not error or duplicate tables
 DO ID format: must include spaceId, projectId, threadId — missing any returns error
 spaceId mismatch in run() request returns 403 immediately
 runFiber() registers fiber in SQLite fibers table BEFORE execution starts
 runFiber() updates fiber status to 'complete' after successful execution
 runFiber() updates fiber status to 'failed' if execution throws
 onFiberRecovered() called with snapshot restores execution from last ctx.stash()
 ctx.stash() persists iteration count and sessionId — recoverable after eviction
 executeAgentLoop() creates session row if thread_id not seen before
 executeAgentLoop() reuses existing session for same thread_id
 User message persisted to messages table with role='user' before LLM call
 Assistant response persisted to messages table with role='assistant' after LLM call
 Token usage recorded via naelao-billing Service Binding after every LLM response
 Token buffer populated with streaming deltas for reconnect replay
 replayBuffer() returns all tokens for a given runId in correct order
 MAX_ITERATIONS (50) prevents infinite loop — agent stops at 50th iteration
 context compaction triggered when token count exceeds 85% of max context
 WebSocket upgrade requires valid Origin header (allowlisted)
 WebSocket upgrade rejects non-allowlisted Origin with 403
 Token stream broadcast to all connected WebSocket clients on each chunk
 WebSocket hibernation: DO can sleep between messages, WS stays connected
 cancelCurrentRun() terminates active fiber and updates status to 'cancelled'
 WAL entry created BEFORE tool execution
 WAL entry marked 'complete' AFTER successful tool execution
 WAL entry marked 'failed' when tool throws error
 Pending WAL entries replayed on DO restart (crash recovery)
 Parallel tool execution: workspace-tier tools run concurrently via Promise.all
 Serial tool execution: sandbox-tier tools run sequentially
 Agent memory write validates category against allowed list
 Agent memory write rejects prompt injection patterns in string values
 Agent memory read returns all entries for a session, most recent first
- - `workers/agents/src/connectors/oauth.ts` — generic OAuth2+PKCE helpers (not Whop-specific code;
  any future connector with a catalogue `oauth` spec reuses these): `generatePkce`,
  `buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshTokens` (Whop rotates the refresh token on
  every use — the new one is always persisted, the old one never reused), and a KV-backed
  single-use OAuth ticket (`issueOAuthTicket`/`consumeOAuthTicket`) mirroring the codebase's own
  stream-ticket precedent: a short-lived, server-held, single-use ticket rather than putting a
  PKCE verifier or any credential in a browser-navigable URL.
- New `ConnectorDefinition.oauth` field (`catalogue.ts`): authorize/token URLs, scopes, and env-var
  NAMES for the client id/secret (never values in catalogue data). Whop's entry gained one.
- `POST /connectors/:platform/oauth/start` (authenticated `requireVerifiedTenant`, since this hop
  is a plain fetch, not a page navigation): generates the PKCE pair, stores
  `{verifier, spaceId, tenantId, userId, returnUrl, platform}` under a random ticket id
  (`AGENT_CACHE`, 10-minute TTL — long enough for a human to click through Whop's consent
  screen), and returns `{authorize_url}` with the ticket as `state`. The frontend does a REAL
  browser navigation to this URL.
- `GET /connectors/:platform/oauth/callback` — PUBLIC/unauthenticated (Whop redirects the raw
  browser here; the single-use ticket in `state` IS the auth, consumed — deleted — on first
  read, so a replayed callback URL from browser history/proxy logs can never redeem twice).
  Exchanges the code server-side (holds the client secret), vaults
  `{access_token, refresh_token, expires_at}` as JSON under the connector's own credential name
  (reusing the exact `POST /spaces/:spaceId/credentials` upsert path item 52's manual flow
  already used), upserts the `mcp_servers` row to `auth_type: "oauth2"`, and 302-redirects the
  browser to the caller's own `return_url` with `?whop_connected=1` (or `?whop_oauth_error=...`)
  — the tokens themselves never reach the browser.
- `POST /internal/connectors/oauth/refresh` (HMAC-gated, same `requireVerifiedTenant` check) is
  the ONLY place that ever holds the Whop OAuth client secret. `workers/mcp-hub/src/index.ts`'s
  `buildAuthHeaders` gained an `oauth2` branch (`resolveOAuthAccessToken`): parses the vaulted
  JSON, and when within 5 minutes of `expires_at`, calls this refresh endpoint (new
  `AGENTS_WORKER` service binding on mcp-hub) rather than
- Check on web  articles and docs etc on Hermes ai bot modes architecture from when the bots reply to bit groups etc how do we add that to projects and will it work with the 4vtier thread architecture plus if they share workspace how will that work plus how to give each bor it's own identity thits ow agent.md etc all those and many I didn't mention here find rhem

## Required execution and response

1. Convert every numbered specification above into a file/request-path checklist before editing.
2. Implement in dependency order and reuse canonical workers/DOs rather than parallel helpers.
3. Return complete apply-ready unified diffs for every changed, created, or deleted file. Do not use
   ellipses, pseudo-code, TODO-only stubs, omitted boilerplate, or comments standing in for code.
4. Include exact migration, provisioning, secret rotation, rollout/backfill, rollback, and staging
   smoke commands.
5. Include exact test/typecheck/config-parity commands and the security/race assertions they prove.
6. Finish with an item-by-item release ledger: IMPLEMENTED, PARTIAL, or MISSING with honest gaps.

For automation, put exactly one machine-readable line before the first diff:
`PHASE_STATUS: CONTINUE` when another implementation turn is required, or
`PHASE_STATUS: COMPLETE` only when every numbered item and verification boundary is finished.
Place all prose after the diff or in a separate `PHASE_NOTES` section. A COMPLETE response with no
apply-ready diff is valid only when the current branch already satisfies and verifies every item.

Do not silently omit an item. If one response cannot hold the implementation, stop only after an
atomic, testable commit boundary and return a continuation prompt containing the remaining numbered
specifications and current verification state. Never claim completion because code merely compiles.
