# AI Studio implementation prompt — batch 03, plan items 25–38

## Manual AI Studio hand-off contract

Implement this batch against the repository snapshot embedded after this instruction. Return the
implementation as **one complete unified Git diff** beginning with `diff --git`. Do not return a
shell script, prose before the diff, a partial snippet, or Markdown fences. The downloaded response
must be saved as `repomix/patches/batch-03.patch` and committed to
the accumulator branch. That path triggers the repository's batch-application workflow, which
validates and applies the patch, rebuilds the prompts, verifies the Repomix configuration, commits
the resulting code, and publishes the next batch XML plus its prompt as a workflow artifact.

The patch must not edit generated `repomix/outputs/` files, `.repomix-cache/`, or the downloaded
patch itself. Include tests and configuration changes in the same diff. If the entire batch cannot
fit, still return one apply-ready diff at an atomic verified boundary; the next downloaded patch
for the same batch continues from the newly generated repository snapshot.

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Connectors, capabilities, delegation, skills, and DLP**. This prompt is self-contained: the feature definitions and retained implementation
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

### 25. Decoupled Logical Connector Binding Matrix

**Final behavior:** Application code never hardcodes account handles (e.g. `leads@company.com`). Scripts reference abstract aliases (`primary_inbox`) mapped dynamically in SQLite.

**Production acceptance contract:**
Production entry: connector resolver/MCP hub.
Persistence/deployment: alias + scope rows in D1; `MCP_HUB`.
Required observable verification: connector scope tests prove user > project > space resolution without cross-tenant fallback.

**Retained implementation constraints:**
- 95. **Channel setup is now scan-to-connect: one Naelao app per channel + a pairing QR, replacing
    BYO-app-per-space.** Prompted by the OpenClaw comparison — their Web Gateway shows a QR you
    scan and you're done in 60 seconds, while ours asked a non-technical owner to open a developer
    console, create an app, find a signing secret, paste it, then copy a webhook URL back into the
    provider. Every step is somewhere they stop, and none of it was work they should ever have
    done: it existed only because the platform had no app of its own.
    - **`launchpad/channel-pairing.ts`**: a short-lived (15 min) single-use `cp_`+32-hex token
      (sized to fit Telegram's 64-char `start` payload, the tightest constraint any channel
      imposes) + per-channel URL builders. Telegram is a deep link whose start payload IS the
      token; Slack/Discord are ordinary OAuth install flows with the token as `state`; WhatsApp
      prefills a message the OWNER sends — that direction is load-bearing, since a person starting
      the conversation is what Meta's policy treats as opt-in, so it needs no application. Email
      is explicitly not pairable (AgentMail provisions it automatically) and says so rather than
      failing obscurely. Every channel degrades honestly to "isn't set up on this platform yet"
      and points at the BYO path.
    - **New `channel_pairings` table** (migration 0070). `channel_links` answers "does this space
      have Slack?", keyed by space; platform-app pairing needs the reverse — a message arrives at
      Naelao's OWN bot carrying only a Telegram chat id or Slack team id, with no space in the URL
      to look it up with. New `POST /channels/platform-inbound/:channel` (one per channel for the
      whole platform, not one per business) verifies against the PLATFORM secret, recognises a
      pairing message BEFORE treating it as conversation (otherwise the assistant would answer a
      raw token as though it were a customer's question), and resolves the business from the
      binding. `GET /channels/pair-callback/:channel` handles the Slack/Discord return, recording
      nothing unless the code exchange actually confirms a workspace/guild — Slack answers 200
      with `ok:false` on failure, so trusting the status alone would record an install that never
      happened. Both public at the router, same posture as the connector callback (the single-use
      token IS the auth).
    - **Outbound needed a matching fix**: a paired
- The Gap Product slug generation derives a slug from the product name (e.g., "My Product" → "my-product") in application code and inserts it into SpaceDO SQLite without a UNIQUE constraint on the slug column or an atomic reservation step. Two concurrent POST /products requests with the same product name will both compute "my-product", both check for availability (both see it as available), and both attempt INSERT — whichever finishes last wins but the first has already returned a 201 with the slug to the client. The client now has a slug that leads to the wrong product.
- 3. **Fix B (same audit, same root cause family): the three Launchpad system prompts referenced
   tools that don't exist in the script-native surface** — `"the Stripe tool"`, `"the email
   tool"`, `"the CRM tool"` (`launchpad/spacetype.ts`, written verbatim into `system-prompt.md`
   by `launchpadAgentToProfile`). Payment is Lemon Squeezy via the reserved `commerce` prebuilt
   (the established specification / the established architecture #9), never a builder's own Stripe key. Rewrote all three
   (`launchpad-fulfillment-v1`, `launchpad-support-v1`, `launchpad-content-v1`) to reference
   `script.find`/`script.create` + distillation, the `commerce` prebuilt for money-in,
   `notifications` for customer/owner messages, `mcp-connector` for external platforms
   (Whop/CRM), and `knowledge-base`/`web-search`/`r2-workspace` where relevant — no hardcoded
   tool-name language. Also swapped the stale `"stripe-app"` literal for `"commerce"` in
   `allowed_skills` and `trigger.source` (both already mapped to the same prebuilt via
   `skillToPrebuilt`'s backward-compat case, so this is a wording fix with no behavior change).

### 26. Pre-Flight Scope Verification & Incremental Re-Auth

**Final behavior:** SDK validates granted OAuth scopes before execution. If write permissions are missing on a read-only token, it halts and surfaces an incremental scope upgrade card.

**Production acceptance contract:**
Production entry: connector connect/execute routes and scope verifier.
Persistence/deployment: granted scopes + OAuth state in D1/credentials.
Required observable verification: Composio/Pipedream tests cover missing-scope card then successful retry.

**Retained implementation constraints:**
- 58. **Whop added as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), replacing Lemon
    Squeezy as the FIRST-TRIED provider for builder platform plans and end-user subscriptions/
    credit-packs — LS stays as the fallback, item 45 is not reverted.** Trigger: the operator
    couldn't activate a Lemon Squeezy store because LS's own onboarding requires a Stripe-linked
    payout path unavailable in their country. Two genuinely different Whop relationships were
    built, neither the same as the invite-gated Platforms API (items 50-51, business-wallet
    sub-merchants) or the read-only "Connect with Whop" OAuth connector (item 53):
    - **Platform-plan checkout** (`packages/billing-core/src/providers/whop-platform-plan.ts`):
      Naelao's OWN normal Whop seller/company account (`WHOP_API_KEY` — no invite needed, the
      same relationship any Whop creator has) sells the builder Growth/Business plans directly.
      `/billing/checkout` tries Whop first, falls back to LS, then the dev placeholder;
      `/billing/portal` returns Whop's fixed self-serve orders page (`whop.com/orders/` — Whop
      has no API-mintable per-customer portal session the way Stripe/LS do) when the org's
      subscription is Whop-backed. New `POST /webhooks/whop-platform-plan` (Naelao's OWN
      company's webhook, a DIFFERENT secret than the sub-merchant wallet's `WHOP_WEBHOOK_SECRET`)
      parses `membership.went_valid`/`went_invalid`/`payment.succeeded` into the SAME
      `NormalizedBillingEvent` shape LS already produces — `NormalizedBillingEvent.provider`
      widened to `"lemon_squeezy" | "whop"` and `recordPlatformPlanSubscription` (unchanged
      logic) now branches only on which id-columns to write (migration 0067 adds
      `subscriptions.whop_customer_id`/`whop_subscription_id`, `ls_*` columns untouched — same
      "no cheap DROP COLUMN" precedent 0062 set for Stripe→LS).
    - **End-user OAuth-delegated checkout** (`whop-oauth-checkout.ts` + `workers/billing/src/
      whop-oauth-billing.ts`): `/internal/business-subscriptions/checkout` and `/internal/
      credit-packs/checkout` now try the BUSINESS's own connected Whop company first (via the
      existing "Connect with Whop" OAuth token, vaulted under `WHOP_OAUTH_TOKENS`) before falling
      back to LS. Settles 100% into that business's own Whop balance — there's no payment-split
      primitive on a normal OAuth token, so Naelao's cut is NOT auto-split at checkout; it
      reaches the ledger via t
- Default: 1 assistant per user per Space — second creation attempt returns error
 Admin raises limit to 3 — third assistant creation succeeds
 Heartbeat reads cron-jobs.json from R2 and dispatches overdue jobs
 Heartbeat skips jobs where nextRun > now (no premature execution)
 Heartbeat updates lastRun and nextRun after job dispatch
 Channel message routes to correct channel session (Slack → slack session)
 Channel message processed as runFiber so heartbeat is not blocked
 Slack webhook Origin validation fails with fake Origin header
 Slack webhook URL verification challenge returned correctly
 Permission manifest stored in DO SQLite, not R2
 Skill code cannot modify permissions table (only admin fetch() call can)
 Admin grants permission: permission.granted = 1 in SQLite
 Admin revokes permission: permission.granted = 0 in SQLite
 Restricted action (manage_members) with permission denied returns 403
 Restricted action with permission granted executes successfully
 addSkill() validates skill name against /^[a-z0-9-]+$/ regex
 addSkill() runs 27-pattern scanner before writing to R2
 addSkill() blocked skill does not write to R2 or modification_log
 addSkill() valid skill writes SKILL.md to R2 and logs to modification_log
 spawnSubAgent() creates thread in project and records in sub_agents table
 checkSubAgentStatus() updates sub_agents table when agent completes
 Memory write validates category against schema
 Memory write rejects values with prompt injection patterns
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

### 27. Gatekeeper Capability-Based Cross-Subspace Delegation

**Final behavior:** Cross-department tool access is governed by cryptographically signed, attenuated tokens specifying allowed resource IDs and expiration timestamps.

**Production acceptance contract:**
Production entry: Gatekeeper/capability verifier and SpaceDO check.
Persistence/deployment: grants + revocation/nonce data; platform signing secret.
Required observable verification: tamper, expiry, wrong-resource and sibling isolation tests.

**Retained implementation constraints:**
- 94. **Skill self-improvement (the last open gap from the OpenClaw/Hermes analysis) and a real
    connector directory are now BUILT.** Two independent pieces, both live-verified.
    - **The skill gap as previously written was slightly wrong, and the correction matters.**
      Outcomes WERE recorded and `script.find` WAS sorted by them. The real problem: `stability_score`
      is a LIFETIME ratio, which cannot express recency — 20 successes and 4 failures scores 0.83
      whether those failures are spread over a year or are the last four runs in a row. A skill that
      broke yesterday kept being offered as proven, kept being picked, and kept failing. New
      `script-engine/skill-health.ts` adds the recency layer: `ScriptMetadata.recent_outcomes`, a
      bounded (10) window carrying the ERROR of each failure, and `assessSkillHealth` →
      `unproven | proven | degrading | broken`. Three consumers: `script.find` demotes a failing
      skill (never hides it — an agent cannot repair what it can't see); the GATE refuses to
      auto-run one at L1 and routes it to L2/L3 repair carrying its own `last_error` as the
      `repairTarget.failureReason`; and the reasoner's candidate projection now includes the health
      record, with a `DECISION_INSTRUCTIONS` paragraph telling it to patch rather than re-run.
      **A real design bug caught by writing the test:** demoting a broken skill pushed it under
      `FIND_CONFIDENCE_FLOOR`, so the loop read "nothing relevant found" and went to L4 (write a
      NEW skill) instead of repairing the one it had. Fixed by splitting the score into
      `FindCandidate.relevance` (stability × similarity — what the GATE's floor tests, "is there a
      skill about this at all") and `confidence` (relevance × health — the sort key, "and can I
      trust it as it stands"). Health must never affect relevance.
    - **New `skill-manager` prebuilt** gives the agent agency over its own library, since the
      automatic half can't decide to fix a skill nobody is currently reaching for:
      `skill.health` (assessment naming what's broken/degrading/promotable), `skill.inspect`
      (real errors + patch history), `skill.rollback`, `skill.retire` (deletes the Vectorize
      embedding too — otherwise it stays findable-but-unresolvable), `skill.promote` (delegates to
      the already-existing `/skills/promote` route, which owns the template lookup + threshold —
      one gate, not two that drift). Reads auto-approved in guided
- The Gap: CF Zero Trust is referenced for admin tool protection but no spec exists for: device posture checks (is the admin's device up-to-date?), service token rotation for machine-to-machine admin calls, or audit logging of all admin tool access. SOC 2 CC6.3 (multi-factor authentication) and CC6.6 (threat detection) require these controls.
 Required Fix: Configure CF Zero Trust policies for admin tools: (1) Device posture: require CF WARP client installed + OS version check + no malware detection — enforced via Zero Trust device policy; (2) Service tokens: machine-to-machine calls to admin Workers use CF Service Tokens with 90-day rotation schedule (automated via CF API in a Workflow); (3) Admin access logging: Zero Trust Access logs to Logpush, streamed to Security SIEM (Elastic/Splunk). Each admin action logged with actor, target resource, action type, duration. Quarterly access review (G-AQ25) covers admin access.
- `NaelaoAgentDO.enforceRunGates`'s existing `BUILDER_CALLER_ROLES` branch (the builder-chatting-
with-their-own-Space-Assistant scope — P0-3's exact scoping, re-used verbatim) now ALSO checks the
new infra-credits quota alongside the pre-existing llm-tokens one, same fail-open-on-transient-
error / 402-`error_code: "infra_quota_exceeded"`-on-confirmed-over-cap posture. **Deliberately NOT
extended to project-scoped or signed-in-product-end-user runs** — those already have their own
separate wallet/project-spend-cap/credit-balance gates (project_spend, ProductUserDO credits),
which are a fundamentally different metering axis (currency-like spend) from this one (a resource-
consumption ceiling); folding infra credits into those existing gates is a real, separate design
question left for its own pass, not silently done here. **Also deliberately NOT extended:**
`handleChannelHeartbeat`'s separate per-message customer-bot debit loop (still token-credits only,
unchanged).
- 250 - 252
What about allowing user to build micro apps t Small, user-generated full-stack applications built by AI from natural language prompts, running in isolated V8 isolates with private SQLite databases
Utilizes a capability-based security model called Gatekeepers instead of raw API keys, enforcing granular, resource-level permissions so an agent's access never exceeds a human user's limits.
Allowing users to generate **Micro-Apps** on demand from natural language prompts—powered by private SQLite databases running in V8 isolates and protected by the **Gatekeepers capability-based security model**—is the holy grail of enterprise software.
Instead of paying $50/user/month for rigid SaaS tools (Jira, expensify, bespoke form builders), a user simply types:
> *"Build an internal Equipment Checkout app for our warehouse team with QR scanning and a private approval ledger."*
The AI generates the frontend, backend routes, and database schema in **under 30 seconds**, deploying it inside a dedicated **`MicroAppDO` (Durable Object)** at Cloudflare’s edge.
- ### 2. The "Gatekeepers" Capability-Based Security Model
The fatal flaw of traditional plugins and AI-generated apps is **Raw API Keys**:
* If an AI micro-app is given a master API key, a malicious prompt or buggy script can query other departments, read executive emails, or drain company funds.
**Gatekeepers replaces API keys with Unforgeable, Attenuated Capability Tokens.**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THE GATEKEEPER SECURITY PROTOCOL                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. THE HUMAN PERMISSION CEILING (Invariant #1)                              │
│    An agent or micro-app can NEVER hold more power than the human who       │
│    created it. If Alice is a "Member" (no refund authority), any micro-app  │
│    Alice builds is physically incapable of minting refund capabilities.     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. RESOURCE-LEVEL ATTENUATION (Invariant #2)                                │
│    The micro-app is issued a cryptographically signed Gatekeeper Token:     │
│    • `db:access` ──► Restricted strictly to its own SQLite table.          │
│    • `slack:post` ──► Restricted to `#warehouse-alerts` (Max 10 msgs/day).  │
│    • `stripe:charge` ──► BLOCKED.                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. ZERO-LEAK RUNTIME PROXY (Invariant #3)                                   │
│    The micro-app code NEVER holds secrets. Outbound requests pass through   │
│    the Gatekeeper Proxy, which verifies the token before injecting secrets  │
│    at the edge network boundary.                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### Summary of What This Adds:
1. **Zero-Code Full-Stack Software on Demand:** Users aren't just getting text answers; they get **real, working web applications with dedicated databases** built in seconds.
2. **No Data Leakage Between Apps:** Every micro-app has its own **isolated SQLite database inside its own Durable Object**—no shared tables, no risk of data contamination.
3. **The Gatekeeper Security Standard:** Capability-based attenuation ensures user-generated apps can **never exceed the creator’s permission ceiling** or access unapproved company resources.

### 28. 3-Tier Connector Scoping

**Final behavior:** Integrations are partitioned into `Space-Shared` (company Stripe), `Project-Bound` (support WhatsApp), and `User-Personal` (Alice's private Gmail).

**Production acceptance contract:**
Production entry: connector directory/resolver.
Persistence/deployment: scoped credential and connector rows; credentials/MCP bindings.
Required observable verification: connector hierarchy tests prevent broader fallback from shadowing a narrower binding.

**Retained implementation constraints:**
- 71. **Project Journal, conversation memory + compaction, and the assistant/shell UI split are
    BUILT — and building them surfaced that the agent had NO conversation memory at all.**
    - **Project Journal** (`script-engine/project-journal.ts` + `prebuilt/project-journal.ts`).
      One `PROJECT.md` per project (`spaces/{id}/projects/{id}/PROJECT.md`, a SIBLING of
      `workspace/` so an ordinary file write can't spoof it): goal, standing instructions, status,
      todos, and a bounded log of what every agent did. Memory OS already shared L3/L4/L6 across a
      project and kept L5 private, but project STATE ("invoice.csv exists", "the payout task is
      done") was homeless, so two threads would each redo the other's work. Read ON DEMAND via
      `project_journal.read` — never injected per call, which is what lets it hold real detail.
      Bounded by entry count AND rendered bytes; overflow folds into a dense archive
      (Mastra Observational Memory's shape) rather than truncating. Summarisation is optional:
      LLM when wired, deterministic rollup when not — losing a completed action to a summariser
      outage would defeat the point. Scoping is structural (project comes from the run, never an
      argument). Both assistant profiles instruct: read before working, log after acting.
    - **The agent had no conversation memory.** Confirmed by reading `GatewayReasoner.decide()`:
      the payload carried goal + snapshot + candidates + this run's own steps, and NOTHING else.
      No history at all — so it could not resolve "do that again", could not answer "what did we
      decide", and re-asked what the user had just said. The context-usage meter (§A1.27) was
      measuring a transcript the model never received. New
      `script-engine/conversation-context.ts` carries recent history bounded by tokens and message
      count, walking backwards so the newest message can never be the one evicted; a single huge
      message is truncated (and says so) rather than evicting everything else.
    - **Compaction is explicit, never silent.** Claude Code's own has the documented failure mode
      the user described: after a compact the assistant treats anything absent from the summary as
      never having happened. So the payload itself carries a `notice` (not just the system prompt)
      saying the history is compacted, how many messages are missing, and to run
      `conversation.search` rather than guess. `DECISION_INSTRUCTIONS` says the same.

- Required Fix: Three feedback channels, each reusing existing infrastructure rather than inventing new ingress: (1) the existing multi-channel gateway (Slack/Discord/email/WhatsApp, item 11 of the established architecture) already lets a customer-bot project ingest a support channel — an operator project subscribes its PM agent to the SAME channel catalogue, tagged feedback_source instead of support_source ; (2) a new product-analytics prebuilt script reads the operator's OWN deployed product's event stream (via a builder-supplied read-only analytics connector — PostHog/Amplitude/Mixpanel MCP servers already fit the existing mcp-connector pattern, BYO-key per the universal-tools doctrine's own carve-out for a builder's own accounts, G-BF01); (3) a periodic pm.mine_feedback skill runs on a scheduled job (the existing scheduled_jobs primitive, item 20) that clusters raw feedback text by embedding similarity (Vectorize, the same primitive KB search and script.find already use) into named PATTERNS before it ever reaches the reasoning loop — "47 raw complaints" becomes "1 pattern: dashboard load time" as a distilled input, not a wall of text the model has to notice a pattern in itself.
- Why Whop, not Stripe/Lemon Squeezy (researched before building, not assumed): Whop is a
registered payment facilitator that supports programmatic SUB-MERCHANT enrollment (create an
isolated company per business via API, no per-business OAuth flow) and a programmatic WITHDRAWAL
API (241+ territories, bank/crypto/Venmo/CashApp) — the same custody shape Stripe Connect's
Express accounts have (Whop, like Stripe, holds the money and runs payout compliance; Naelao's
integration surface is provisioning, balance/status reads, and withdrawal requests only), but
`createSubMerchant` doesn't require the builder to click through a hosted onboarding page first —
it can be called automatically the instant a business is created, which is what makes this
genuinely autonomous rather than "opt-in, one extra click."
- ### 1. The 3-Tier Connector Scope Taxonomy
```
                                  ┌──────────────────────────────────────────────┐
                                  │           MCP CONNECTOR SCOPE MODEL          │
                                  └──────────────────────┬───────────────────────┘
                                                         │
         ┌───────────────────────────────────────────────┼───────────────────────────────────────────────┐
         ▼                                               ▼                                               ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ 🏢 1. SPACE-SHARED CONNECTOR    │             │ 👤 2. USER-PERSONAL CONNECTOR   │             │ 📁 3. PROJECT-SPECIFIC CONNECTOR│
│ `scope: "space_shared"`         │             │ `scope: "user_personal"`        │             │ `scope: "project_bound"`        │
├─────────────────────────────────┤             ├─────────────────────────────────┤             ├─────────────────────────────────┤
│ • **Owner:** Company / Business │             │ • **Owner:** Individual Member  │             │ • **Owner:** Specific Project   │
│   (Connected once by Admin).    │             │   (Connected by Alice/Bob).     │             │   (e.g., Customer Bot project). │
│ • **Examples:**                 │             │ • **Examples:**                 │             │ • **Examples:**                 │
│   - Official Company Calendar   │             │   - Alice's Private Calendar    │             │   - Clinic WhatsApp Phone Number│
│   - Corporate Stripe Treasury   │             │   - Bob's Personal GitHub Token │   - Discord Support Channel Bot │
│   - Company-wide Slack Hub      │             │   - Sarah's Personal Gmail      │   - Specific Client Data Room   │
│ • **Access:** Open to all       │             │ • **Access:** STRICTLY locked   │ • **Access:** Restricted ONLY   │
│   company projects and agents.  │             │   to runs on that user's behalf.│   to threads inside this project│
└─────────────────────────────────┘             └─────────────────────────────────┘             └─────────────────────────────────┘
```
- ### 2. How the Agent Distinguishes Scopes in its Tool Schema
Instead of giving the model an ambiguous tool like `create_calendar_event` with no provenance, the **Tool Surface (`tool-surface.ts`)** injects **explicit scope prefixes and descriptions**:
```typescript
// How tools are formatted in the Reasoner Prompt
{
  // 🏢 1. Space-Shared Tool (Default Company State)
  "mcp.company_calendar.create_event": {
    "scope": "BUSINESS_SHARED",
    "description": "[Company Shared] Book event on the official company-wide schedule. Visible to all team members.",
    "parameters": { "title": "string", "startTime": "string", "clientEmail": "string" }
  },
  // 👤 2. User-Personal Tool (Active only when acting for Alice)
  "mcp.alice_calendar.create_event": {
    "scope": "PERSONAL_USER",
    "description": "[Personal: Alice] Book event directly on Alice's private calendar. Private to Alice.",
    "parameters": { "title": "string", "startTime": "string" }
  },
  // 📁 3. Project-Specific Tool (Active only in Project: Customer Support Bot)
  "mcp.inbound_support_bot.send_whatsapp": {
    "scope": "PROJECT_BOUND",
    "description": "[Project: Customer Bot] Send official WhatsApp message from the +1-800 clinic business number.",
    "parameters": { "recipientPhone": "string", "message": "string" }
  }
}
```
- ### Summary of What This Solves:
1. **No Shared-Calendar Confusion:** The agent knows that `mcp.company_calendar` updates the **SpaceDO global calendar table** visible to all projects, while `mcp.personal_calendar` only touches the user's private schedule.
2. **Prevents Autonomous Identity Hijacking:** An unattended 2:00 AM background cron cannot accidentally use Alice’s personal Gmail account to email a client, because personal credentials are cryptographically inaccessible without an active `actingUserId` session.
3. **Clean Project Sandboxing:** Customer-facing WhatsApp numbers and Discord bots are bounded to their specific `customer_bot` projects, keeping company-wide and personal communication channels completely separated.

### 29. Public Channel Tool Stripping & MCP-UI Privacy Bridge

**Final behavior:** Personal tools are physically stripped from the LLM prompt in public channels. If a personal task is requested, the agent emits an interactive card to fork to a private scratchpad.

**Production acceptance contract:**
Production entry: prompt tool filter/channel orchestration.
Persistence/deployment: channel session scope in SpaceDO.
Required observable verification: tool-filter tests inspect the actual serialized schema; card is observable.

**Retained implementation constraints:**
- 141. **The six items item 140 explicitly left open are now BUILT — Phase 1 of the 62-item batch is
     complete.** `thread.create` (the assistant's own `project-coordination` prebuilt) minted a
     `threads` row with no `session_id` — the exact bug behind "Session not found" on any
     assistant-created thread. It now also mints and links a real session (generating the thread's
     own id client-side so the link can point at it, then `POST /sessions {thread_id}`), matching
     the shape a human's own "New thread" already produces; degrades to returning the bare thread
     (still real, still usable via a later open) rather than throwing if the session-link call
     itself fails. The SAME gap existed on the flat `/threads` browse page's own "New Session"
     button and its `/threads/:id` chat route — fixed identically, and that route now waits for the
     thread to load (mirroring the project-scoped page) instead of always taking Chat's client-only
     fallback.
     - **Memory was never written automatically — confirmed, and closed.** Layer 4 (Fabric,
       project-shared consolidation) already had a post-run write; Layer 5 (episodic, the layer
       `memory.recall` actually searches) did not — nothing besides the model's own occasional
       `memory.remember` tool call ever populated it, which is the real root cause of "the AI isn't
       recording anything." `NaelaoAgentDO.handleScriptRun` now also writes a low-importance (0.3,
       below the auto-promotion threshold — a background trail to recall on demand, not something
       that forces itself into every future prompt) episodic note alongside the existing Fabric
       write, same best-effort posture. `memory.remember` added to
       `LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED` (`memory.recall` was already there) — it's a
       write, but a purely internal one (lands only in the agent's own private recall store,
       invisible to anyone unless recalled again), unlike `write_file` or a commerce write, which
       stay gated.
     - **Context meter now reflects the real selected model.** `ContextUsageMeter` hardcoded
       `claude-haiku-4-5-20251001`; `Chat.tsx` had `selectedModel` in scope the whole time and
       simply never passed it to the Stats-tab instance — fixed. Also gained a manual **Compact**
       button (next to the percentage, calling the existing `/compact` route on demand rather than
       only auto-firing at 85%) and a `compact` single-line rendering mode mounte
- # naelao-workspace R2 bucket — agent filesystem and skills
spaces/
 {spaceId}/
 .skills/ # Space-level skills (Tier 2)
 {skill-name}/
 SKILL.md
 scripts/
 workflows/
 assistants/
 {userId}/ # Space Assistant filesystem
 cron-jobs.json
 skills/ # Assistant personal skills
 dynamic-tools/ # Self-authored Dynamic Worker tools
 channels/ # Channel configs (Slack, Discord, etc.)
 projects/
 {projectId}/
 workspace/ # Shared project workspace (ProjectDO manages locks)
 todo.md
 output/
 data/
 .versions/ # Version history (every file write)
 knowledge/ # Project knowledge docs
 workflows/ # Agent-authored Dynamic Workflows
 agents/
 {agentId}/
 workspace/ # Agent-specific workspace
 skills/ # Agent-specific skills (Tier 3)
 mini-agi/
 {miniAgiId}/
 data/ # Company data domains (sub-folders per domain)
 hr-data/
 sales-data/
 public-docs/
 bootstrap/
 {vertical}/ # Bootstrap Mode data
 annotation-queue/ # Tasks awaiting annotation
 in-progress/ # Locked tasks
 labeled-dataset/ # Completed annotations
 training-runs/ # Fine-tuning training files
 workflows/
 {name}.ts # Agent-authored Dynamic Workflow TypeScript
- **J5 — new binding, new Workflow class, both narrowly scoped.** `wrangler.toml` gained a second
`[[workflows]]` entry (`ScriptRunWorkflow` / binding `AGENT_SCRIPT_WORKFLOW`), separate from
`AgentTaskWorkflow`'s `AGENT_TASK_WORKFLOW` — different payload shape (`scriptName`+`params` vs. a
full agent turn's goal/systemPrompt/tools), different purpose, so two classes rather than
overloading one. `NaelaoAgentDO.buildScriptEngineEnv` wires `env.workflowRunner` from
`this.env.AGENT_SCRIPT_WORKFLOW` when present, mirroring `codeRunner`'s wiring exactly (optional,
degrades honestly). `buildOrchestrationHooks` was restructured (it previously `return {}`ed
entirely when `NAELAO_AGENT_DO` was absent, which would have also silently dropped the workflow
hooks even though they don't need that binding) so sub-agent hooks and workflow hooks are gated
independently, and the hook set now takes the already-constructed `ScriptToolSurface` — moved one
call site later in `handleScriptRun` (from before `config`/`tools` existed to right after `tools`
is constructed; nothing in between reads `engineEnv.orchestration`, and every consumer reads it
lazily at call time inside the reasoning loop, so the reorder is behavior-preserving).
- ### 3. "Harvey for Healthcare" — Clinical Chart & Pre-Auth Desk
* **Target Buyer:** Private medical clinics, dental practices, physical therapy networks.
* **When & Where It’s Used:** During new patient onboarding, insurance pre-authorizations, and prior medical history review.
* **What It Parses:**
  * Faxed medical records from other hospitals, printed lab diagnostics tables, and patient intake questionnaires.
* **How It Works with Parse 5 & AVOS:**
  1. Clinic staff drag incoming faxes into the patient’s confidential private project.
  2. Parse 5 parses complex lab tables (blood panels, vitals, historical medications).
  3. The Medical Agent formats the data into standard **SOAP notes** and verifies that diagnostic test justifications match insurance CPT guidelines.
* **The Pitch & Pricing:**
  * **Price:** **$249 / month** (Air-Gapped / HIPAA Compliant Mode).
  * **Pitch to Clinics:** *"Eliminate 15 hours a week of staff manual data entry from incoming hospital faxes. Automatically generate clean clinical charts ready for your EHR."*
- ### 5. "Harvey for Real Estate" — Commercial Mortgage & Rent Roll Studio
* **Target Buyer:** Commercial real estate brokers, private equity real estate funds, mortgage underwriters.
* **When & Where It’s Used:** When analyzing potential property acquisitions or underwriting multi-family mortgage loans.
* **What It Parses:**
  * Trailing 12-Month Operating Statements (T-12s), commercial rent rolls, property tax appraisal assessments.
* **How It Works with Parse 5 & AVOS:**
  1. Underwriter uploads scanned Excel printouts of building rent rolls.
  2. Parse 5 reconstructs messy tenant tables (square footage, lease expiration dates, base rent vs CAM charges).
  3. The Real Estate Agent dumps the data into the **`finance_grid`** viewport, running automated Net Operating Income (NOI) and cap-rate sensitivity models.
* **The Pitch & Pricing:**
  * **Price:** **$299 / month**.
  * **Pitch to Real Estate Investors:** *"Underwrite deals in 2 minutes instead of 4 hours. Drop in scanned rent rolls and T-12s to get instant financial models and lease risk analyses."*
- ### 8. "Harvey for GovCon" — Federal RFP & Grant Bidding Desk
* **Target Buyer:** Defense contractors, IT staffing vendors, non-profit grant writers.
* **When & Where It’s Used:** When evaluating and assembling multi-million dollar government solicitation bids (SAM.gov).
* **What It Parses:**
  * 150-page Federal Acquisition Regulation (FAR) compliance matrices, RFP solicitations, and past proposal win archives.
* **How It Works with Parse 5 & AVOS:**
  1. Proposal writer uploads government RFP solicitation PDFs.
  2. Parse 5 converts evaluation criteria, CLIN pricing tables, and mandatory clauses into structured Markdown.
  3. The GovCon Agent automatically builds a **Compliance Matrix Task DAG** in the Project Journal, assigning each section to specialized writer subagents.
* **The Pitch & Pricing:**
  * **Price:** **$499 / month**.
  * **Pitch to Gov Contractors:** *"Win more federal bids with less overhead. Turn 150-page SAM.gov solicitations into structured compliance matrices and proposal drafts automatically."*

### 30. Single-Use Ephemeral Action Grants

**Final behavior:** Quick one-off personal actions in public rooms are authorized via MCP v2 Elicitation cards, minting a 15-second single-use token that executes without revealing credentials.

**Production acceptance contract:**
Production entry: elicitation grant mint/consume.
Persistence/deployment: nonce consumption ledger in DO SQLite.
Required observable verification: replay, expiry, identity and 15-second boundary tests.

**Retained implementation constraints:**
- 84. **Projects sidebar (mockup port), in-chat approval + connector cards, a Connectors browser
    (Composio default / Pipedream filter), and input-bar Connectors/Upload buttons — a large,
    user-directed batch, explicitly scoped down in two places (documented below, not silently
    dropped).**
    - **Projects page sidebar.** `apps/launchpad/src/index.html`'s `#projects-view` has a 220px
      left rail (project tree + "Agents in Space" shortcuts) the shell's `/projects/[projectId]`
      page never ported (item 81 only matched the RIGHT pane). Added, reusing the Discover page's
      existing `.spaces-layout`/`.spaces-sidebar`/`.spaces-content` classes rather than inventing
      new ones (packages/ui/styles.css already has this exact two-pane shape). Thread counts are
      shown only for the currently-open project (already fetched) — every OTHER project's count
      would be an N+1 fetch for a cosmetic number, so it's left off rather than faked.
    - **In-chat approval cards.** A run stopping at a HITL gate had a real, previously-undetected
      gap: the DEFAULT async (Workflow/TaskDO) dispatch path stored only the friendly placeholder
      text in TaskDO, never the `approval_id`/`action_name`/`params` `normalizeScriptRunResult`
      already computes — so a polling client could see `status:"awaiting_approval"` but nothing
      to act on. Fixed end-to-end: `AgentTaskWorkflow`'s run-agent step captures
      `pending_approval` (pre-JSON-stringified to satisfy CF Workflow's `Serializable<T>` step
      -return constraint, which chokes on a bare `Record<string,unknown>` — re-parsed only inside
      the plain, non-step `update-result` callback where that constraint doesn't apply) and
      stores it in TaskDO's `result`; `fetchRunOrTaskStatus` (shared by the plain GET-run route
      AND the SSE `/stream` poller) now surfaces it. **A second real gap found in the same
      code path:** the SSE stream's poll loop never treated `awaiting_approval` as
      stream-terminal — it just kept polling silently for up to 2 minutes (the client's
      `onmessage` only ever acted on `"done"`), so a chat message hitting an approval gate via the
      SSE path (the common case) showed a stuck typing indicator with zero feedback until
      timeout. Fixed by sending `type:"done"` (carrying `pending_approval`) for
      `awaiting_approval` too, same as completed/failed/cancelled. `apps/shell`'s new
      `InlineApprovalCard.tsx` renders Approve/Decline at the exa
- Required Fix: Add optional COMPOSIO_API_KEY and PIPEDREAM_API_KEY Workers Secrets to mcp-hub. Key resolution per provider-routed server: (1) if the server row carries auth_secret_name , the builder's own vault credential wins (a builder running their own Composio project keeps full control and their own billing); (2) otherwise the PLATFORM key for that provider is injected server-side — the builder and end user never see it, never enter it; (3) if neither exists, fail with a clear "provider not configured on this platform" error. The platform key lives only inside mcp-hub (already the case for vault credentials — isolates receive only 60-second internal tokens). The reserved money-in tool-name guard is unchanged and applies to platform-keyed calls identically. Naelao's Composio spend becomes a platform cost recovered through credits, exactly like LLM tokens.
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
- ### 6. "Harvey for CPAs" — Forensic Audit & Tax Schedule Desk
* **Target Buyer:** CPA accounting firms, fractional CFOs, bookkeepers.
* **When & Where It’s Used:** During annual tax season, IRS audits, and corporate financial reconciliations.
* **What It Parses:**
  * Schedule K-1 forms, 1099 statements, foreign tax credit receipts, and handwritten expense logs.
* **How It Works with Parse 5 & AVOS:**
  1. Accountant drops 100 client receipts, K-1s, and bank statements into the project.
  2. Parse 5 parses non-standard table formats and matches partner distribution percentages.
  3. The CPA Agent cross-references reported distributions against general ledger journal entries.
* **The Pitch & Pricing:**
  * **Price:** **$199 / month** (or $399/mo during tax season).
  * **Pitch to Accounting Firms:** *"Eliminate manual K-1 and receipt data entry during tax season. Turn paper document chaos into clean, audit-ready financial summaries in seconds."*

### 31. Turn-Holder vs. Referent Mention Router

**Final behavior:** When multiple bots are mentioned (e.g. `@ReviewBot audit @DevBot's patch`), the leading mention gets the turn lock; subsequent mentions become context references and do not wake up.

**Production acceptance contract:**
Production entry: mention router/channel inbound handler.
Persistence/deployment: channel event dedupe + turn lock.
Required observable verification: multi-mention tests prove only first bot wakes.

**Retained implementation constraints:**
- 151. **A new 28-step goal batch (Google Drive `new/goal 1.txt`) is IN PROGRESS — the first
     tranche (steps 2, 3, 8, 9, 10, 12, 13a, 14, 19, 24) is BUILT, tested, and deployed.** The
     authoritative list is the user's Drive file (28 steps, item 1 = a Claude-Code-style
     context-window breakdown UI for the Stats tab; the finale = 6 business templates + business-
     wide BYOK). Shipped so far:
     - **Step 10 (spawn/consult model+agent validation):** `agent.spawn` validates each task's
       model against `ALLOWED_MODELS` before delegating — a wrong id gets a real "did you mean"
       (new `billing-core` `suggestModels`) instead of a silent escalation-clamp (which read as a
       misleading "too expensive") or a bare provider 404. `thread.consult`/`thread.send_message`
       validate `agent_id` (and model) up front with did-you-mean over the project's agents.
     - **Step 8 (project model/agent listing):** new `thread.list_project_models` +
       `thread.list_project_agents` on the `project-coordination` prebuilt; the agent listing
       ALWAYS includes the general Space Assistant (`naelao-agent`) so a brand-new project still
       shows a real, addressable target. Both auto-approved reads.
     - **Step 9 (tool-result pagination):** generic size-guard in `ScriptToolSurface.run()` —
       `applyToolResultLimit` (exported, tested) pages the primary list of an oversized (or
       explicitly `limit`/`offset`-ed) result in place with a `_pagination` note carrying the true
       total + next-page instruction, or truncates a non-list blob with guidance. Small results
       stay byte-identical.
     - **Step 3 (chunked file read/search):** `read_file` gains `offset`/`length` ranged reads
       (`has_more`/`next_offset` paging) so a file over the single-read cap is read a slice at a
       time; new `search_file` returns matching lines with line numbers + optional context without
       pulling the whole file. paramHints added for every `r2-workspace` op.
     - **Step 12 (self-scheduling / background-task wake):** new `schedule` prebuilt
       (`schedule.wake_me`/`list`/`cancel`) lets an agent wake ITSELF later with a follow-up goal
       — the "set a cron trigger to check back on a background task" pattern. Built on the existing
       goal-based `scheduled_jobs` dispatcher; a delay-based wake is one-shot (`params._one_shot`,
       which the dispatcher now disables after firing), a `cron` wake recurs. Granularity is the
       hourly he
- The Gap
 Partial Stream on Disconnect — Half-Written Assistant Messages Persist as Complete When an agent streams a response token-by-token and the connection drops mid-stream — or the DO is evicted, or the LLM call errors halfway — the spec does not define what happens to the partial message. The risk: a half-generated assistant message gets written to the thread as if it were complete. On the next turn, the agent reads its own truncated message as context and continues from a sentence that was cut off mid-word. The conversation becomes incoherent and there is no marker that the message was incomplete. The Missing Message Lifecycle States The spec stores messages with no explicit completion state.…
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

### 32. Sequential Turn Delegation

**Final behavior:** Orderly handoffs between agents via `ctx.agent.delegate()`, transferring the active execution turn lock cleanly and preventing multi-agent race conditions.

**Production acceptance contract:**
Production entry: `ctx.agent.delegate`/NaelaoAgentDO delegation handler.
Persistence/deployment: turn-holder lock and task rows in DO SQLite.
Required observable verification: delegation grouping/race tests; old holder cannot continue after transfer.

**Retained implementation constraints:**
- 73. **"Long-running background agent" was capped at 29 seconds — now genuinely unbounded — plus a
    replay-safety ledger, an honest `awaiting_approval` status, and an unauthenticated approvals
    surface closed. Driven by reading CF's own docs rather than this file's stale invariant.**
    - **The 29s cap.** `AgentTaskWorkflow` set `timeout: 29_000` on `run-agent`, the step that does
      all the work. **A CF Workflow step has NO wall-time limit** — only a CPU-time limit, which
      excludes time spent waiting on an LLM/tool/any I/O (`/workflows/reference/limits/`, verified
      2026-07). The ceiling was self-imposed and traceable to this file's own Key CF Invariants line
      claiming "30s per step" — now corrected there too, along with the real step counts (1,024
      Free / 10,000 default Paid / 25,000 configurable; `step.sleep` up to 365 days, not counted)
      and a pointer to `step.waitForEvent`/`instance.sendEvent`. Any real multi-step task blew
      through 29s and was reported as a failure. Dispatch was already durable-by-default (item 38
      Phase Q); this is what made it not actually long-running.
    - **Retries removed from that step + a ledger check added.** `retries: {limit: 3}` on a
      NON-idempotent step meant a slow run re-executed every tool call already made — the same
      email sent up to three times. New `recordedResult()` reads the TaskDO row (already written,
      so no second store — the Orchestrator ledger pattern) and short-circuits when the task
      already reached a terminal state, making a Workflow REPLAY safe. Best-effort on purpose: a
      failed ledger read must not strand a task that genuinely never ran.
    - **`awaiting_approval` is now a real status end-to-end.** Item 72's suspend path landed with a
      hole: a run stopped at a gate has no `result` and no `error`, which `normalizeScriptRunResult`
      read as ok-with-empty-output → `status: "completed"` with a blank answer. Worse,
      `apps/shell`'s `Chat.tsx` matches on status, so an unrecognised one hit no branch and the
      reply silently vanished — the exact case the feature exists for looked like the agent gave up.
      Threaded through the normalizer, `TaskDO`'s `TaskStatus` (explicitly non-terminal, so the
      completion callback doesn't fire), `TASK_STATUS_TO_RUN_STATUS`, `AgentRun` in the shell
      client, and Chat's poll loop.
    - **The four approvals routes had NO auth of any kind — FIXED.** `GET/PUT
      /spaces/:spaceId/s
- The Gap CF Durable Objects' input gate only protects storage operations (this.ctx.storage.*). Calls to fetch(), env.R2.put(), env.QUEUE.send(), and similar non-storage I/O do NOT block incoming requests during their execution. If AssistantDO issues a fetch() to an external LLM API (which may take 5-30 seconds), concurrent WebSocket messages or heartbeat requests can arrive and interleave — reading stale in-memory state (this.activeRuns, this.lastHeartbeat, etc.) while the first request awaits the network call. This causes: lost increments to in-memory counters, race conditions in the agentic loop state machine, and double-processing of scheduled jobs.
- Two things the initial framing got wrong, checked before fixing anything (worth recording so a
future pass doesn't inherit the same overstatement):
1. **This is not the enforcement path.** `checkQuota`'s `allowed` boolean (the thing this KV
   counter feeds) is computed in `workers/billing/src/index.ts`'s quota-summary handler but
   never read to block anything — it's returned in a `GET .../quota`-style response body for a
   dashboard usage meter. The actual quota/entitlement enforcement used platform-wide (spaces
   worker, agents worker, knowledge worker's KB-document-count gate) goes through
   `@naelao/entitlements`'s `EntitlementsChecker`, which runs a live `COUNT(*)` D1 query
   directly with no KV cache and no race window. So the bug is a dashboard-accuracy issue, not
   an active quota-evasion or revenue-leak vector — billing/metering itself (the actual revenue
   path) runs through `usage_events` (idempotent `INSERT OR IGNORE` on `event_hash`) and an
   async Stripe-metering queue, both untouched by this KV counter.
2. **The literal spec fix (a new `usage_metrics` D1 table with `UPDATE ... SET value = value +
   ?`) would introduce a second source of truth**, not fix the one that exists. This codebase's
   `getCurrentUsage` D1 fallback doesn't maintain an incrementable counter column at all — it
   recomputes a live aggregate (`COUNT(*)` over `spaces`/`kb_documents`, `SUM(quantity)` over
   `usage_events`) directly from the authoritative rows every cache-miss. That aggregate is
   already correct and atomic in the way that matters (it's a read of real committed rows, not
   an accumulator that can itself drift). Standing up a parallel `usage_metrics` counter table
   that must somehow stay in sync with that aggregate would trade one race for a
   two-sources-of-truth reconciliation problem — worse, not better.

### 33. Cryptographic Delegation Chaining

**Final behavior:** Delegated tasks carry an HMAC-signed token with the initiating human user's ID and role rank, preventing low-privilege users from bypassing RBAC via agent delegation.

**Production acceptance contract:**
Production entry: delegation token mint/verify.
Persistence/deployment: signed claims + nonce/expiry; platform secret.
Required observable verification: tamper, privilege amplification, wrong-user and expiry tests.

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
- The Gap When a space member's role is downgraded (e.g., from admin to viewer) or when a member is removed, the handler updates the space_members SQLite row but does not invalidate active WebSocket sessions or cached JWT tokens that still carry the old role claim. If the member has an active browser session with a JWT that expires in 24 hours, they retain admin privileges for the full 24 hours after being downgraded. During a security incident (compromised employee account), revoking access takes effect only after the attacker's session expires naturally. This is unacceptable for a platform handling user data and AI agent execution.
- 1781/1781 tests pass (12 new: `infra-usage-metering.test.ts` proving the conversion function's
invariants and `reportWorkflowStepInfraUsage`'s real-and-degrades-honestly behavior;
`infra-usage-quota-gate.test.ts` proving the pre-run gate's fail-closed/fail-open cases and its
narrow BUILDER_CALLER_ROLES-only scoping via the same `NaelaoAgentDO` `/run` fixture pattern
`interactive-run-end-user-credit-gate.test.ts` established), `pnpm turbo run typecheck` clean (75
tasks). Next: Phase 4 (real token streaming + context-window usage UI + pre-send
auto-compaction), Phase 5 (model switcher).

### 34. Demonstration-to-Skill Distillation Engine

**Final behavior:** Compiles raw execution traces into reusable, parameterized TypeScript modules stored in `/.avos/shared/skills/` that execute in 5ms for $0.0001.

**Production acceptance contract:**
Production entry: loop DISTILL and skill library.
Persistence/deployment: R2 control prefix + Vectorize index.
Required observable verification: skill library/health tests; next lookup returns latest immutable version.

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

- The Gap: The platform already has per-run technical traces ( run_traces , HX1, item 59) and a cross-thread activity mirror ( agent_activity_log , item 40) — but both are technical/operational logs, not a product-decision audit trail. The single highest-severity failure mode of an autonomous SaaS operator is not a crash (that shows up in existing monitoring) — it is a technically flawless execution of the WRONG feature: correct code, wrong problem solved, and nothing today lets a human owner cheaply ask "why did it build this?" without re-reading raw agent transcripts.
- **Execution ladder Tiers 2-5 — `script-engine/code-runner.ts`.** Implements `TieredCodeRunner`
for real:
- **Tier 2/3** — a CF Worker Loader (`[[worker_loaders]]` binding `LOADER`) spins up a fresh V8
  isolate per `script.run` call. Stored code is a single module exporting `run(args, ctx)`; the
  runner appends a small `fetch` harness around it. Tier 3 best-effort resolves bare-specifier
  imports from `esm.sh` as extra virtual modules (there is no real "npm install" inside an
  isolate — documented as a real limitation, not papered over).
- **Tier 4** — the same isolate, with `ctx.browser.navigate(...)` injected, proxied to the
  pre-existing `naelao-browser` Worker (CF Browser Rendering + SSRF guard) via a new
  `BROWSER_WORKER` service binding. Agents still never get raw CDP.
- **Tier 5** — `ToolSandboxDO`'s container harness (`container/server.mjs`) gained a generic
  `POST /exec { code, args }` route (esbuild-bundle → import → call `run(args,{})`), alongside
  its existing `/build` route for the legacy micro-tool gate.
- Wired into `NaelaoAgentDO.buildScriptEngineEnv` as `env.codeRunner`; degrades tier-by-tier,
  never crashes, when a binding is absent.
- New prebuilts **`browser-use`** (navigate/click/type/extract/screenshot, Tier 4) and
  **`code-exec`** (`execute_python`/`execute_bash` → Tier 5; `run_js` → Tier 2, codemode) ship
  in the Default Naelao Agent. `run_js` re-applies the reserved-capability guard at call time
  (ad hoc code bypasses `script.create`, so it must not bypass the money-in guard too).
- ### 1. The "Record-and-Learn" Demonstration-to-Skill Engine
You are describing **Demonstration-to-Skill Distillation** (the *"Watch Me Do It Once, Automate Forever"* paradigm).
Instead of prompting an LLM from scratch every single time, the user or AI records a task demonstration (a GitHub workflow trace, a recorded browser clickstream, or a terminal session). The **Distillation Engine** compiles that raw recording into a **permanent, parameterized, versioned TypeScript skill in your `SkillLibrary` (`SCRIPT.md` + `code.ts`)**.
```
[ User or Agent performs a task (e.g. Deploying to AWS, Scraping a Portal) ]
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. EXECUTION TRACE INGESTION                                                │
│    Captures the raw event log: [HTTP calls, DOM clicks, CLI arguments].     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. PARAMETERIZATION & CODE SYNTHESIS (Workers AI / Llama 3.3 70B)           │
│    • Identifies dynamic variables: `client_email`, `repo_url`, `selectors`. │
│    • Synthesizes clean TypeScript: `export async function run(args, ctx)`.  │
│    • Formulates `fingerprint_schema` (preconditions needed to run).         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. SANDBOX TEST & VERIFY                                                    │
│    Runs the synthesized skill in a V8 isolate to verify exit code 0.        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. COMMITTED TO R2 SKILL LIBRARY                                            │
│    Saved as `spaces/{spaceId}/scripts/{skillName}/v1.ts`.                   │
│    Future runs execute it deterministically in 100ms for $0.0001!           │
└─────────────────────────────────────────────────────────────────────────────┘
```
- #### How this is Exposed in the Agent Tools:
```typescript
// workers/agents/src/script-engine/prebuilt/skill-manager.ts
export const distillSkillFromDemonstration = async (
  trace: Array<{ op: string; input: any; output: any }>,
  skillName: string,
  ctx: PrebuiltOpContext
) => {
  // 1. Synthesize parameterized TypeScript module from raw trace
  const synthesizedCode = await generateSkillCodeFromTrace(trace);
  // 2. Persist to Authoritative Skill Library in R2
  const skill = await ctx.env.skillLibrary.create({
    name: skillName,
    code: synthesizedCode,
    metadata: {
      description: `Automated skill distilled from task demonstration: ${skillName}`,
      domain: "automation",
      requires_tier: 2, // Runs in cheap V8 isolate!
      origin: "distilled",
      stability_score: 1.0,
      parameters: extractParametersFromTrace(trace)
    }
  });
  return { ok: true, skillName: skill.name, version: 1 };
};
```
- ### Summary of What This Adds
1. **Self-Improving Skill Accumulation:** Any complex CLI or browser task done once can be **distilled into a versioned skill** stored in R2, making future executions 100x faster and cheaper.
2. **Kitesurf as Tier 3:** Dramatically cuts compute costs for web scraping and form filling by using Cloudflare's lightweight **Kitesurf engine**, reserving full **Chromium (Tier 4)** strictly for visual QA and complex rendering.
3. **Frictionless Ladder Escalation:** Tiers promote smoothly: **Tier 1 (SQLite FS)** $\rightarrow$ **Tier 2 (Isolate)** $\rightarrow$ **Tier 3 (Kitesurf)** $\rightarrow$ **Tier 4 (Chromium)** $\rightarrow$ **Tier 5 (Container)** with zero crashed turns.

### 35. Multimodal Video-to-Skill Learning Engine

**Final behavior:** Transcribes screen recordings via Whisper; vision models extract clicks and typed inputs, compiling demonstrations into verified TypeScript skills.

**Production acceptance contract:**
Production entry: demonstration ingestion/vision delegate → distillation gate.
Persistence/deployment: media R2, trace and skill versions.
Required observable verification: multimodal contract tests require verification before activation.

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
- The Gap: The spec has no architecture for multimodal inputs — image uploads, audio recordings, or video frames. Builders creating vision agents (document analysis, image Q&A) or voice agents (beyond VAPI) have no platform support for routing multimodal inputs to appropriate models.
 Required Fix: Add multimodal content types to conversation messages: {role: "user", content: [{type: "text", text: "..."}, {type: "image_url", image_url: {url: "r2://..."}}, {type: "audio", audio: {data: "base64...", format: "wav"}}]} . Router selects model with required capabilities from agent's required_capabilities: ["vision", "audio"] . Image upload: store in R2, generate signed URL, pass to model. Audio: transcribe via CF AI Whisper-equivalent, pass transcript + audio if model supports both. Enforce max file sizes (image: 20MB, audio: 25MB).
- **Frontend.** Dashboard gained a 9th product tab, **Pricing** — plan/pack editors with a live
"Provisioned"/"Not provisioned" badge per item (from `lsVariantId` presence), round-tripping through
`PATCH /builder/products/:id/pricing`; hidden behind an explanatory empty state for `team`-mode
products (pricing only makes sense once a product allows businesses at all). Shell's business detail
page (`spaces/[businessId]/page.tsx`, already the Members-management surface from Phase C) gained
Subscription Plans (owner/admin can Subscribe — redirects to the LS checkout URL) and Credit Packs
sections (any member can Buy, explicitly labeled as topping up the BUYER'S OWN balance, not the
business's, to avoid the natural confusion of a per-individual purchase appearing on a
business-scoped page). Both verified end-to-end: the dashboard's Pricing tab via the established CDP
Fetch-mock screenshot technique (a provisioned "Pro" plan correctly shows "Provisioned", an
unprovisioned "Basic" plan shows "Not provisioned"); the backend via 23 new tests across two files
(`pricing-catalog.test.ts` — parent-walk resolution, the cross-business isolation assertion every
`requireBusinessMembership` route gets, builder pricing PATCH provisioning idempotency, credit-pack
grant idempotency; `business-subscriptions-billing.test.ts` — checkout route construction against a
mocked Lemon Squeezy API, webhook status-mapping, the seat/product/business-subscription/credit-pack
`kind` discriminator never cross-firing).
- ### 2. The "Video-to-Skill" Engine (Learning from Video Demonstrations)
Similar to open-source demonstration agents (like OpenAdapt, Show-Me-How, and Video2Code), this engine allows a founder or operator to **upload a screen recording (Loom / MP4 / WebM) of themselves performing any complex workflow**.
The AI watches the video, tracks mouse clicks, keystrokes, and URL changes, transcribes audio commentary, and **synthesizes a permanent, parameterized TypeScript skill in your `SkillLibrary`**.
```
[ User uploads a 60-second screen recording (e.g., navigating an obscure vendor portal) ]
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. MULTIMODAL VIDEO INGESTION & DECOMPOSITION                               │
│    • Audio Track ──► Workers AI Whisper (Transcribes spoken explanation).   │
│    • Video Track ──► Keyframe sampling on scene changes & click events.     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. ACTION RECOGNITION & CORRELATION (Multimodal Vision LLM)                │
│    • Detects DOM bounding boxes, active input fields, and button clicks.    │
│    • Correlates voice instructions ("I'm pasting the invoice number here"). │
│    • Extracts structured event trace:                                       │
│      [Navigate -> Input(selector) -> Click(button) -> Extract(table)].      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. PARAMETERIZATION & CODE SYNTHESIS                                        │
│    • Replaces hardcoded values with dynamic arguments:                      │
│      `const { invoiceId, vendorEmail } = args;`                             │
│    • Generates clean TypeScript: `export async function run(args, ctx)`.    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. SANDBOX VERIFICATION & REGISTRATION                                      │
│    • Tests the synthesized code in Tier 4 Kitesurf sandbox.                 │
│    • Persists `SCRIPT.md` + `code.ts` into the space's R2 Skill Library.    │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### 3. Implementation: The Video Distillation Prebuilt Tool
Add the `skill.distill_from_video` operation to `workers/agents/src/script-engine/prebuilt/skill-manager.ts`:
```typescript
// workers/agents/src/script-engine/prebuilt/skill-manager.ts
import { generateObject, generateText } from "ai";
import { z } from "zod";
export async function distillSkillFromVideo(
  args: Record<string, unknown>,
  ctx: PrebuiltOpContext
) {
  const videoR2Key = args["videoPath"] as string;
  const skillName = args["skillName"] as string;
  const description = args["description"] as string || `Automated skill learned from video: ${skillName}`;
  // 1. Fetch video from R2 Workspace
  const bucket = ctx.env.workspaceBucket || ctx.env.scriptsBucket;
  const videoObj = await bucket.get(videoR2Key);
  if (!videoObj) throw new Error(`Video file not found in workspace: ${videoR2Key}`);
  // 2. Multimodal Action Extraction Pipeline
  // Extracts ordered action sequence: navigation targets, selectors, typed inputs, and assertions
  const { object: actionSequence } = await generateObject({
    model: ctx.env.AI_GATEWAY("claude-3-7-sonnet-20250219"),
    schema: z.object({
      parameters: z.array(z.object({
        name: z.string(),
        type: z.string(),
        description: z.string()
      })),
      steps: z.array(z.object({
        actionType: z.enum(["NAVIGATE", "CLICK", "TYPE", "EXTRACT", "ASSERT", "BASH"]),
        target: z.string().describe("URL, CSS selector, or command"),
        valueExpression: z.string().describe("Dynamic parameter or static value"),
        description: z.string()
      }))
    }),
    prompt: `Analyze this recorded demonstration of '${skillName}'.
Identify the parameterizable inputs, DOM interactions, and logic flow required to replicate this exact task programmatically.`
  });
  // 3. Synthesize clean, hardened TypeScript code using universal primitives
  const synthesizedTypeScript = `
/**
* Auto-Distilled Skill: ${skillName}
* ${description}
*/
export async function run(args: Record<string, any>, ctx: any) {
  ${actionSequence.parameters.map(p => `const ${p.name} = args["${p.name}"];`).join("\n  ")}
  // Replay synthesized action timeline
  ${actionSequence.steps.map(s => {
    if (s.actionType === "NAVIGATE") return `await ctx.run("browser.navigate", { url: "${s.target}" });`;
    if (s.actionType === "TYPE") return `await ctx.run("browser.type", { selector: "${s.target}", text: ${s.valueExpression} });`;
    if (s.actionType === "CLICK") return `await ctx.run("browser.click", { selector: "${s.target}" });`;
    if (s.actionType === "BASH") return `await ctx.run("Bash", { command: ${s.valueExpression} });`;
    return `// ${s.description}`;
  }).join("\n  ")}
  return { ok: true, message: "Successfully executed learned skill: ${skillName}" };
}
`;
  // 4. Save to Authoritative Skill Library in R2
  const skill = await ctx.env.skillLibrary.create({
    name: skillName,
    code: synthesizedTypeScript,
    metadata: {
      description,
      domain: "automation",
      requires_tier: 4, // Tier 4 (Kitesurf/Browser)
      origin: "distilled",
      stability_score: 1.0,
      parameters: actionSequence.parameters
    }
  });
  return {
    ok: true,
    skillName: skill.name,
    version: 1,
    parameters: actionSequence.parameters,
    message: `✔ Successfully learned and registered skill '${skillName}' from video demonstration.`
  };
}
```

### 36. Zero-Turn Tool Catalog in Prompt

**Final behavior:** Injects an active command index into the system prompt at turn start, eliminating discovery token burn (`ls /skills`) while loading full code only on demand.

**Production acceptance contract:**
Production entry: `script.find` catalog assembly/reasoner prompt.
Persistence/deployment: script metadata R2/Vectorize.
Required observable verification: progressive-disclosure tests assert code is absent until read/run.

**Retained implementation constraints:**
- 140. **A ~62-item batch of live-use asks was planned and phased; Phase 1 (bug sweep + chat
     fidelity) is BUILT and deployed. Three of the reported "missing features" turned out to be
     DEAD CSS waiting for a component, and writing the test for one bug exposed a second, worse
     one underneath it.** Full plan (all 6 phases, decisions, deferred items):
     `/root/.claude/plans/gleaming-scribbling-pelican.md`; the user's own answers set the
     sequencing (bug sweep first), the billing model (hybrid personal-plan + business-subscription),
     channel scoping (both scopes, kind-gated UI) and project automations (build on
     `scheduled_jobs`/`event_triggers`, don't fork a second engine).
     - **Markdown never existed anywhere in chat.** Every bubble rendered its content as a raw
       React text child, so an assistant reply arrived with its `**bold**`, `- bullets` and ```
       fences intact as literal characters — while `packages/ui/src/styles.css` had been carrying
       finished styles for `.bubble p/ul/strong/em/pre/code` the whole time with nothing ever
       emitting those elements. New `apps/shell/src/components/Markdown.tsx` uses `react-markdown`
       + `remark-gfm`, chosen over `marked`/`showdown` for one reason that matters here: it builds
       React elements and never touches `dangerouslySetInnerHTML`, and an agent in this product
       renders web-fetched pages, customer email and connector output into these bubbles.
       `rehype-raw` is deliberately NOT installed, so inline HTML in markdown stays inert text.
       Wired through `RevealText`'s revealed substring (new opt-in `markdown` prop) so the reveal
       animation is untouched; an unclosed construct mid-reveal reads as literal text for a frame.
       The USER's own message stays literal — they typed it — and `.bubble.user` gained
       `white-space:pre-wrap`, which it never had, so their line breaks survive at all.
     - **`.msg-actions`/`.msg-action`/`.msg-action .tooltip` + `.msg-row:hover` were ALSO already
       styled and used by no component.** The only affordance was a permanently-visible text
       "Edit" button on one message. New `MessageActions.tsx` wires the existing styles: copy on
       every bubble, edit only on the last user message, both icons. `:hover` never fires on a
       tap, so a `.revealed` class set on tap reveals the row on touch rather than making it
       always-visible there (which would put two buttons under every message in a
- Default count
 1 per user per Space. Space admin can raise this limit in Space Settings → Assistants → Max per
 user. Maximum 5 per user per Space.
 Container model
 On-demand CF Container (standard-1: ½ vCPU, 4 GiB RAM). Starts only when a task needs Linux
 execution. Default idle timeout: 30 minutes. Warm on wakeup from heartbeat: <3s.
 R2 filesystem path
 spaces/{spaceId}/assistants/{userId}/ mounted at /data/assistant when container starts. Contains: memory.json (deprecated, replaced by DO
 SQLite), skills/, cron-jobs.json, channel-configs/, dynamic-tools/
 Heartbeat frequency
 Every 5 minutes via naelao-sweeper cron trigger. Checks: cron-jobs.json, sub-agent status, pending
 channel messages, DO alarm wakeups.
 Memory storage
 Typed JSON in AssistantDO SQLite memory table. Key+category primary key. Schema-validated on
 write. Never flat Markdown. Injected into system prompt as structured XML on each turn.
 Permission manifest
 Stored in AssistantDO SQLite permissions table. NOT in R2 — prevents skill code from modifying its
 own permissions. Default: all permissions denied. Admin grants via Space Admin Dashboard.
 Self-modification scope
 Can write/update: skills in R2, cron-jobs.json, dynamic-tools (via Dynamic Worker Loader). Cannot
 modify: Worker source code, wrangler.jsonc, SpaceDO schema, other users' data, permission manifest.
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

### 37. Declarative Step Pipelines (Execution Hooks)

**Final behavior:** Pre-flight context hooks (querying background indexers) and post-turn verification gates (`npm test`) configured declaratively via JSON without dangerous custom scripts.

**Production acceptance contract:**
Production entry: step context/prebuilt plan and workflow verifier.
Persistence/deployment: JSON agent config in R2.
Required observable verification: hook schema tests reject executable strings and run configured test gates.

**Retained implementation constraints:**
- 112. **A repeatable capability benchmark — 6 test cases, trace-graded — is BUILT and validated
     against production; the model matrix itself is blocked on a Cloudflare quota window, not on
     code.** Grounded in published work rather than invented: `Claw-SWE-Bench` (arXiv 2606.12344)
     holds the model fixed and swings Pass@1 from **19.1% to 73.4% on adapter design alone**, and
     reports harness choice worth 27.4pp against model choice's 29.4pp; `WildClawBench` runs the
     same 60 tasks under OpenClaw / Claude Code / Codex CLI / Hermes and sees the same effect
     (GPT-5.4: 56.8% on Codex, 50.3% on OpenClaw). So a generic leaderboard measures the wrong
     quantity — what decides whether OUR assistant runs a business is THIS loop, which is what the
     matrix scores.
     - **`workers/eval/src/trace-checks.ts` grades from the HX1 run trace, not the prose.** The LLM
       judge reads what the agent WROTE — right for answer quality, wrong for "did it do this",
       since a model can describe work it never performed and score well because the paragraph is
       genuinely good (item 108 exactly). Ten check types (`called_tool`, `verified_after_write`,
       `no_fabricated_success`, `no_identical_retry`, `escalated`, `no_secret_leak`, …). `claweval`
       scores its own tool-calling category the same way ("deterministic — tool name + params
       match"). Composition with the judge is **MIN, not average** — the same rule `judgeAnswer`
       already applies between correctness and semantic_validity: a run the trace proves fabricated
       must not be rescued by writing well about it.
     - **New dataset `tests/eval-datasets/agent-capability-matrix.jsonl`** — 6 cases over 6 axes
       (agency, safety/credentials, fabrication, recovery, proactive escalation, multi-source
       synthesis). Each maps to a published benchmark category AND a real production failure of
       ours, so no axis exists just to be passed. `trace_only` on the runner skips the judge
       entirely — a real cost lever, since the configured judge is a premium model and judging 4
       cases costs several times the 6 runs being measured.
     - **Validated against production, and it immediately caught a real model weakness.** The trace
       endpoint returned 13 real steps; asked to create a project and read it back, llama-3.3-70b
       hit the approval gate on `project.create`, correctly ran `project.list`, then **re-chose the
       already-parked action five co
- Required Fix Implement beforeStep(stepIndex, context): StepOverride on AssistantDO. Track task phase in DO state (planning/implementing/verifying). For each phase narrow tools: planning→all tools; implementation→execution tools only (disable create_plan); verification→read/test tools only (disable write tools). Inject budget: const remaining = tokenBudget - context.usedTokens; if (remaining < 1000) add a system message warning. This prevents the agent from calling write tools when it should only be reading, reducing accidental overwrites in verification steps.
- **Tests:** extended `tests/unit/code-runner.test.ts` (4 new — single-call token verification, a
**two-different-servers-in-one-script** chain proving the core deterministic multi-MCP ask, list
ops, graceful absence without a binding); new `tests/unit/mcp-hub-hmac.test.ts` (5 — rejects
without/with-wrong-tenant token, accepts a valid one, blocks a reserved tool name server-side even
when called directly bypassing the prebuilt, allows an ordinary tool through); new
`tests/unit/mcp-connector-hmac.test.ts` (2 — the prebuilt's own calls now carry a verified token);
new `tests/unit/end-user-credit-debit.test.ts` (5 — token-gated, debits correctly, fails closed at
402 on insufficient balance without going negative, 404 for an unknown product, rejects non-
positive amounts). All existing `code-runner.test.ts` calls updated for the new required
`tenantId` field on `TieredCodeRunner.run()` (threaded through `execution-ladder.ts` and the two
other direct callers, `browser-use.ts` and `code-exec.ts`). 1003/1003 tests pass (16 new).
`pnpm turbo run typecheck` clean (75 tasks).

### 38. Egress Data Loss Prevention (PII Scrubber)

**Final behavior:** Outbound proxy scanning payloads sent to consumer connectors (Discord, X/Twitter, Instagram) for credit cards, SSNs, and private keys.

**Production acceptance contract:**
Production entry: security gateway outbound/connector send path.
Persistence/deployment: audit event only (no secret payload); gateway binding.
Required observable verification: DLP tests cover nested JSON, cards and private keys after serialization.

**Retained implementation constraints:**
- 149. **A post-shipping pass over the SAME source list the 62-item plan came from
     (`long running.txt`, Google Drive) — it had been updated with fresh reports from live use
     AFTER those phases landed, so several items marked done were reported still broken. Ten real
     defects found and fixed, most of them the "fixed on one path, missed the other" class this
     file has now documented repeatedly.** Binary downloads corrupted (the knowledge worker read
     every response as text, so a PDF landed as mojibake — now reads bytes once and returns
     `encoding: "text"|"base64"`, refusing an oversized binary with 413 rather than truncating,
     since half a PDF is corrupt rather than smaller); the Sub-agents panel queried the space-wide
     assistant DO while a spawn records into the session's own DO, so it was structurally always
     empty; `thread.create` still produced "Session not found" (the spaces-worker session proxy
     derived `end_user_id` for only one of the two caller shapes); the Compact button hit a route
     that ran space-wide maintenance and never touched the session it was invoked from; `effort`
     capped its own ladder at the model's native reasoning-level count, so `ultra` was rejected on
     models that could serve it; the personal-plan checkout still went LS-first after the Whop
     cutover; `thread.send_message` rendered as the assistant apparently answering its own
     question (now a collapsible on-behalf card, paired to the reply that follows it); the
     project-thread page was unusable on a phone; and the agent had no way to see which models or
     agent templates existed (`agent.list_models`, plus four free-tier Gemini models added to the
     catalogue).
     - **The two reported chat bugs were both about the SERVER transcript, and had separate root
       causes.** A reload discards every scrap of client state, so anything wrong after a reload is
       wrong in the database. *"I got a reply but when I reload it's gone"*: `NaelaoAgentDO` wrote
       the answer back with `void` — a promise still pending when a DO handler returns may never
       run, so the write raced the response (the same class as item 136's `recordWakeFailure`).
       Awaited now; safe because `writeAgentAnswerToSession` already swallows its own errors, so it
       still cannot turn a successful run into a failed one. *"the reload duplicate is still
       there"*: `POST /messages` was not idempotent and `apps/shell`'s `apiFetch` retri
- Required Fix Add egress DLP: scan outbound tool-call payloads for secret/PII patterns and block or require approval when sensitive data leaves the boundary, combined with the SSRF allowlist (G-AA27). Truncate and PII-redact tool results before logging (full bodies only in an encrypted audit store), and support a per-tool sensitive:true flag that suppresses body logging entirely.
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

## Final reconciled architectural changes (newest authority)

These are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.

#### 2. The Space Assistant "Executive Cabinet" Model
* **This updates/replaces:** Bloating the Space Assistant with 50+ space tools, project tools, wallet APIs, and ACL methods in one giant prompt schema.
* **The New Architecture & Mental Model:** The Space Assistant’s toolset is reduced to **one primary tool: `delegate_to_space_worker(worker_id, task)`**. It delegates specific administrative duties to specialized, internal space workers:
  * `project_manager_worker`: Holds `project.create`, `project.archive`, and template instantiation.
  * `treasury_worker`: Holds `wallet.get_balance`, `wallet.request_payout`, and billing audits.
  * `identity_worker`: Holds `member.invite`, `role.set_rank`, and Gatekeeper capability tokens.
  * `comms_worker`: Holds notifications and outbound alerts.
* **Key Invariant:** Strict capability isolation. The Project Manager Worker physically cannot touch treasury balances; the Treasury Worker physically cannot touch project files or ACLs.

#### 6. The Strict 3-Depth Delegation Ceiling
* **This updates/replaces:** Unbounded recursive agent delegation where agents spawn agents indefinitely.
* **The New Architecture & Mental Model:** Delegation depth is hard-capped at exactly 3:
  * **Depth 1 (Lead Orchestrator):** Space Assistant or Project Lead (`NaelaoAgentDO`).
  * **Depth 2 (Domain Sub-Planner):** Ephemeral workflow managing a major workstream (e.g. API refactor).
  * **Depth 3 (Leaf Execution Worker):** Single-task isolate performing AST patching or running a test.
* **Key Invariant:** Depth 3 leaf workers **physically lack the delegation tool** in their runtime SDK, making Depth 4 calls structurally impossible.

#### 13. Decoupled Logical Connector Aliasing
* **This updates/replaces:** Hardcoding physical account names (e.g. `leads@company.com`) inside automation scripts.
* **The New Architecture & Mental Model:** Code references abstract semantic aliases (e.g. `ctx.connectors.use("inbound_mail")`). A dynamic binding table in `SpaceDO` maps that alias to an active physical account (Company Gmail vs. Personal Gmail).
* **Key Invariant:** Switching connected accounts in the UI re-binds the alias instantly without modifying a single line of application source code.

#### 14. Pluggable Space-Shared Calendar Connector (`primary_calendar`)
* **This updates/replaces:** The isolated, hardcoded SQLite calendar table silo in `SpaceDO`.
* **The New Architecture & Mental Model:** The calendar is formalized as a standardized, pluggable **Space-Shared MCP Connector** (`ctx.connectors.use("primary_calendar")`). Spaces bind to Google Workspace, Microsoft 365, CalDAV, or an Edge SQLite Fallback.
* **Key Invariant (Edge Slot-Hold Mutex):** Voice agents acquire a 15-second reservation lock in `ConcurrencyDO` before calling external calendar APIs, eliminating double-booking race conditions during call spikes.

## Required execution and response

1. Convert every numbered specification above into a file/request-path checklist before editing.
2. Implement in dependency order and reuse canonical workers/DOs rather than parallel helpers.
3. Return one complete apply-ready unified diff for every changed, created, or deleted file. Do not use
   ellipses, pseudo-code, TODO-only stubs, omitted boilerplate, or comments standing in for code.
4. Include exact migration, provisioning, secret rotation, rollout/backfill, rollback, and staging
   smoke commands.
5. Include exact test/typecheck/config-parity commands and the security/race assertions they prove.
6. Finish with an item-by-item release ledger: IMPLEMENTED, PARTIAL, or MISSING with honest gaps.

Do not silently omit an item. If one response cannot hold the implementation, stop only after an
atomic, testable commit boundary. Never claim completion because code merely compiles. The response
must start with `diff --git`; record verification notes in an added or updated repository file if
they are necessary to preserve them.
