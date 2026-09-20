# AI Studio implementation prompt — batch 09, plan items 76–87

## Manual AI Studio hand-off contract

Implement this batch against the repository snapshot embedded after this instruction. Return the
implementation as **one complete unified Git diff** beginning with `diff --git`. Do not return a
shell script, prose before the diff, a partial snippet, or Markdown fences. The downloaded response
must be saved as `repomix/patches/batch-09.patch` and committed to
the accumulator branch. That path triggers the repository's batch-application workflow, which
validates and applies the patch, rebuilds the prompts, verifies the Repomix configuration, commits
the resulting code, and publishes the next batch XML plus its prompt as a workflow artifact.

The patch must not edit generated `repomix/outputs/` files, `.repomix-cache/`, or the downloaded
patch itself. Include tests and configuration changes in the same diff. If the entire batch cannot
fit, still return one apply-ready diff at an atomic verified boundary; the next downloaded patch
for the same batch continues from the newly generated repository snapshot.

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Progressive canvas, project kinds, extensions, daemons, widgets, and workflows**. This prompt is self-contained: the feature definitions and retained implementation
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

### 76. Progressive Disclosure Interface ("Apple Surface, Linux Edge")

**Final behavior:** Defaults to clean Business Mode (plain English cards, previews). Power users opt into Developer Mode (commit trees, raw logs).

**Production acceptance contract:**
Production entry: shell layout/project pages.
Persistence/deployment: user preference required.
Required observable verification: component tests are not a dual-mode journey.

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
- // Step 2 — Space Type Selection
// Builder sees a card for each space type. Selecting a type auto-configures sensible defaults.
// IMPORTANT: End users NEVER choose or see space types. The builder selects once here.
// All end users of this product experience the space type as the product's inherent structure.
// Space type cards shown:
// Team → "Chat interface, knowledge base, team collaboration. Best for: builders shipping consumer AI products or internal tools"
// Developer → "Code editing, terminal, containers. Best for: coding assistants, dev tools"
// Verticals → "Supervised execution, compliance logging. Best for: legal, medical, finance"
// Launchpad → "Your customers never log in. Agent serves fulfillment requests."
// Enterprise → "Multi-org, SSO, audit trail. Best for: large organization internal tools"
// Mini-AGI → "Full autonomy, self-modifying agents. For advanced use cases."
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
- 319 - 320
What about the project threads tiers and Collab etc all that with selecting bot to talk to in a thread etc wouldn't that confuse non technical users like how Hermes ai has most things grokbot has but grokbot is like apple Hermes like Linux.
This is a critical product insight. **Hermes AI is built like Linux** (ultra-powerful, but exposes all the terminal knobs and raw function schemas), while **Grok Bot is packaged like Apple** (opinionated, polished, and dead simple) [1.1.2, 1.2.1].
If a non-technical dentist or lawyer sees *"Tier 4 Private Scratchpad"*, *"OCC Hash Checkpoint"*, or has to figure out which of 5 bots to `@mention`, they will close the tab.
To win, your platform must follow the **"Apple on the Surface, Linux at the Edge"** philosophy: **under the hood, you have the full power of Cloudflare Artifacts and multi-agent execution, but the non-technical user only ever sees a clean, human experience [1.2.2, 1.2.5].**
- ### 3. Progressive Disclosure (Business Mode vs. Developer Mode)
To make sure both non-technical business owners and advanced developers love the platform, use **Progressive Disclosure**:
```
                                  ┌──────────────────────────────────────────────┐
                                  │         USER INTERFACE DISPLAY MODES         │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 🍎 DEFAULT: "BUSINESS MODE" (Clean & Human)                 │   │ ⚙️ OPT-IN: "DEVELOPER MODE" (Full Observability)            │
├─────────────────────────────────────────────────────────────┤   ├─────────────────────────────────────────────────────────────┤
│ • Looks like a sleek iMessage / Slack interface.            │   │ • Unlocks Git commit graphs & branch visualizers.           │
│ • Sidebar tabs: **Chat**, **Tasks**, **Files**, **Preview**.│   │ • Unlocks raw terminal compiler logs & isolate traces.      │
│ • Actions are plain English: `[Approve]`, `[Deploy]`.       │   │ • Unlocks per-turn token spend meters and model selectors.  │
│ • Git branches, isolates, and DO memory are 100% invisible. │   │ • Unlocks AST search-and-replace inspectors.                │
└─────────────────────────────────────────────────────────────┘   └─────────────────────────────────────────────────────────────┘
```
- ### Summary
| Feature | The Risk (Linux Trap) | The AVOS Solution (Apple Simplicity) |
| :--- | :--- | :--- |
| **Selecting Bots** | Forcing users to pick bots from a dropdown. | **Auto-Routing:** User talks to the project; the lead bot delegates behind the scenes [1.3.17]. |
| **Git & Versioning** | Showing complex Git trees, rebases, and merge conflicts. | **Plain English Cards:** *"AI drafted a change. [Preview & Approve]"*. |
| **Tiers & Permissions** | Exposing technical numbers ("Tier 1", "Tier 4"). | **Clean Labels:** "Project Chat", "Tasks", "My Private Drafts". |
| **Edge Compute** | Showing V8 isolate cold-starts and container logs. | **Sub-Second Speed:** 2-second edge previews with zero visible infrastructure. |
This gives you **Grok Bot's simple, elegant Apple-like interface on the surface**, powered by **Cloudflare's serverless edge engine underneath** [1.2.2, 1.2.5].

### 77. Dual-Mode Operating System

**Final behavior:** Declarative switch via `template_mode`: toggles between autonomous operator pipelines and collaborative cowork studios.

**Production acceptance contract:**
Production entry: no authoritative mode dispatcher.
Persistence/deployment: no validated manifest field.
Required observable verification: no mode-isolation test.

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
- The Gap There is an emergency agent kill switch, but no platform-wide maintenance mode: a controlled way to put the platform (or a single space, or a subsystem) into read-only/maintenance state during migrations, incidents, or upstream outages, with a user-facing message instead of raw errors. Operators have no graceful big-red-button between "fully up" and "hard down."
- User direction: a COMPLETE restructuring of the payment model. Every business created on Naelao
(Launchpad or otherwise) should get its own isolated wallet automatically — no builder enrollment,
no OAuth consent screen, no personal bank/card details entered up front. The wallet is a REAL bank
account for that business: revenue in from Whop's own storefront/checkout and any connected
third-party platform (Stripe for physical goods, Shopify, Gumroad, a freelance marketplace,
Amazon, eBay, and more), expenses out for the business's own operating costs, owner payouts on
request. The explicit product goal: an autonomous assistant can take a business from $0 to real
revenue without the owner ever putting in a cent of their own money — while Naelao still collects
its own cut, on top of Whop's own ~6-7% all-in processing fee (verified via web research before
building: 2.7%+$0.30 card processing, +3% platform fee, +1-2% payout fees).

### 78. Canvas-First / Domain Viewport Architecture

**Final behavior:** The workspace canvas is the primary product; chat is secondary. Center canvas mounts live code editors, redliners, or financial grids.

**Production acceptance contract:**
Production entry: shell project page and `PROJECT_KIND_MANIFESTS`.
Persistence/deployment: project config/workspace.
Required observable verification: canvas security tests cover contracts, not layout E2E.

**Retained implementation constraints:**
- 129. **Investigated the reported "no credits dialog with 5000 credits" bug thoroughly — all four
     distinct billing gates were confirmed HEALTHY for the account at investigation time; most
     likely a timing issue, not a live code bug. Plus three real, independently-reported UI/UX
     gaps, all fixed: mobile sidebars unreachable, the Message/text-tab button missing from the
     composer dock, and the verification email carrying no usable link.**
     - **Credits-dialog investigation.** Read-only (zero LLM cost, via a temporary service-bound
       worker mirroring items 128/62's own established technique) checks against all FOUR
       distinct `insufficient_credits`/`quota_exceeded` sources in `NaelaoAgentDO.enforceRunGates`
       + the org-level pre-dispatch quota check in `index.ts`: the granted personal balance
       (`5000` credits, intact), Test 1's project wallet (`balance_cents: 996`, `credited_cents:
       1000` — funded, not empty), and the org's monthly `llm_tokens` quota (`enterprise` tier,
       200,000,000 limit, `166,745` used this month) — all healthy, none would trigger the
       dialog. Also audited every code path for a Gemini/Groq/CF PROVIDER-level failure (a 429/
       rate-limit/quota-exhaustion from the LLM itself, mid-run) ever being mislabeled with one
       of the four billing `error_code`s — found none: those already route through the SEPARATE
       `classifyFailure`/`FailureKind` system (`quota_exhausted`/`rate_limited`/
       `model_unavailable`) into `InterruptedRunCard`'s self-heal flow, never `UpgradeDialog`.
       Confirmed the live shell IS running the exact deploy carrying the error_code fix
       (`e089dbaf`, `environment:"production"`). Conclusion: if the dialog is seen again, it is
       very likely a real gate genuinely firing at that moment (the account has real, separate
       state per gate) rather than a mislabeling bug — capturing the EXACT message text next time
       narrows it immediately, since each of the four has distinct wording. Temporary read-only
       worker deleted immediately after use, same discipline as item 128.
     - **Mobile sidebars were completely unreachable — root cause: the CSS was already ported
       from the mockup but nothing in React ever wired it up.** `packages/ui/src/styles.css`
       already carried `#sidebar.mobile-open`/`.mobile-topbar`/`.mobile-backdrop` (ported earlier
       from `apps/launchpad/src/index.html`'s own off-canvas-drawer pattern) — but no
- The Gap: When Stripe or an LLM provider updates their API (new required fields, changed response schemas), the platform's Worker code breaks silently. No contract tests exist to catch provider API changes before they reach production.
 Required Fix: Implement consumer-driven contract tests (Pact.js): Workers define expected request/response contracts for each external API call (Stripe PaymentIntent create, OpenAI chat completion, CF AI inference). Contract stubs run in CI instead of live APIs. On provider API change: contract test fails, alerting to necessary code update. Publish contracts to Pact Broker (self-hosted on CF Workers). Run contract verification weekly against provider sandbox environments.
- First concrete step of the full-vision plan (Naelao → Builder → End User, end user gets the
launchpad-6-mockup agentic workspace; see the established architecture item 30 for the complete phased plan A-E).
Phase A had two deliverables: a shared design system, and a running end-user shell app that can
resolve a product, sign an end user up or in, and render the manifest-driven chrome — no chat yet
(that's Phase B).

### 79. The 7 Foundational Project Kinds

**Final behavior:** Standardized project archetypes: `product_dev`, `doc_studio`, `voice_agent`, `customer_bot`, `model_studio`, `growth_engine`, `app_studio`.

**Production acceptance contract:**
Production entry: `PROJECT_KIND_MANIFESTS`.
Persistence/deployment: project kind config rather than tenant schemas.
Required observable verification: `canvas-extension-security.test.ts` asserts the exact seven.

**Retained implementation constraints:**
- **Fix — invert the default to fail closed.** A missing `created_by` now DENIES creation of any
`BUSINESS_FEATURE_KIND` project outright (403 `forbidden`) unless the request also carries
`system_caller: true` — a new field on the `createProject` body, checked ONLY when `created_by` is
absent; once `created_by` IS present, the ordinary space-member role lookup runs exactly as before
and `system_caller` has no effect (verified by a dedicated test — it must never become a blanket
override). Structural kinds (`workspace`, `customer_bot`) are untouched; they never entered this
role-gated branch in the first place.
- 193 - 195
No in the venture templates channels are  for the owner is to access their assistant on WhatsApp telegram etc just like in vertical cowork but for connecting whatapp bots discord bots telegram bits etc like those customer service automations let's keep them under projects of kind=customer bots users can configure such projects to do customer service automations and even the execution ladder for these projects is lower to avoid security threats.
With this I realize there should be more project kinds besides customer bots and using plugins each will have different UI plus there should be project templates for each kind
- 196 - 198
what if we add a project kind (finetuning/ training on company data) given huge chunk of docs it can use a small model to convert all that unstructured data to llm traing data and the agent is like autoresearcher agent it will finetune a model for the company then they can use it in the company s llm so after training and tests by the autoresearcher the model shows up in other models list and company members can use it. And since we use cloudflare we can leverage cloudflare s tech for all this like finetune,  infrarence hosting etc.
Adding a **`kind: "model_studio"` (Enterprise Fine-Tuning & Auto-Researcher)** project kind is a high-value enterprise capability.
It transforms your platform from simply *prompting* models to allowing companies to **train, evaluate, and deploy their own proprietary AI models on their private company data**—all hosted serverlessly on Cloudflare using **Workers AI LoRA (Low-Rank Adaptation)**.
- ### 3. The `kind: "model_studio"` Specification
Add this to `packages/events/src/business-feature-kinds.ts`:
```typescript
export const MODEL_STUDIO_KIND: BusinessFeatureKind = {
  kind: "model_studio",
  label: "Model Training & Auto-Researcher Studio",
  description: "Convert company documentation into synthetic training data, fine-tune custom LoRA models, and deploy to your team's model picker.",
  singleton: false,
  minCreationRole: "admin",
  autoProvisionable: false,
  viewportComponent: "ModelStudioCanvas", // Dedicated UI for dataset & loss curves
  allowedLadderTiers: [1, 2, 5],           // Isolate data prep -> Container/GPU training
  domainSystemPrompt: `You are an Auto-Researcher ML Engineer.
Your goal is to parse company documentation, synthesize clean training/eval pairs,
evaluate model accuracy, and register fine-tuned models for the company.`,
  linterRules: ["jsonl-format-check", "dataset-leakage-guard", "pii-scrubber"]
};
```
- ### 4. The UI Canvas Viewport (`ModelStudioCanvas`)
Inside `apps/shell/src/components/ProjectKindPanel.tsx`, projects of `kind: "model_studio"` render a dedicated **ML Research & Training Viewport**:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🧠 MODEL STUDIO: "Acme Customer Support Llama-8B (v1.2)"                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📊 Training Status: [ COMPLETED & DEPLOYED ]       🎯 Eval Accuracy: 96.4% │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📁 Dataset Pipeline:                                                        │
│ • Raw Ingested Documents: 142 files (PDFs, Markdown, Zendesk CSVs)          │
│ • Synthesized Training Pairs: 8,420 JSONL prompt-completion pairs           │
│ • Validation Split: 1,000 test cases (Zero contamination)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📈 Training Loss Curve:                                                     │
│   Loss: 2.4 ──► 1.8 ──► 1.1 ──► 0.42 (Converged at Epoch 3)                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🧪 Side-by-Side Verification Playground:                                    │
│ ┌──────────────────────────────────┬──────────────────────────────────────┐ │
│ │ Base Llama 3.1 8B (Default)      │ Your Custom Fine-Tuned Model (v1.2)  │ │
│ ├──────────────────────────────────┼──────────────────────────────────────┤ │
│ │ "Our refund policy is generally  │ "Per Acme Policy #402, enterprise    │ │
│ │  30 days depending on terms..."  │  subscriptions have a 14-day SLA..." │ │
│ └──────────────────────────────────┴──────────────────────────────────────┘ │
│                                                                             │
│ [x] Published to Company Model Picker (Available across all team threads)   │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### 5. Adding `kind: "app_studio"` to the Project Kinds
Add this to `packages/events/src/business-feature-kinds.ts`:
```typescript
export const APP_STUDIO_KIND: BusinessFeatureKind = {
  kind: "app_studio",
  label: "Micro-App & Tool Studio",
  description: "Prompt-to-application engine: generates sandboxed full-stack apps with private SQLite databases and Gatekeeper security.",
  singleton: false,
  minCreationRole: "editor",
  autoProvisionable: false,
  viewportComponent: "AppStudioCanvas", // Live app runner + SQLite table viewer
  allowedLadderTiers: [1, 2],           // Isolate execution only
  domainSystemPrompt: `You are a Micro-App Synthesis Specialist.
Generate clean HTML/Preact frontends and Hono backend routes using private in-DO SQLite tables.
Always declare explicit Gatekeeper permission grants for required resources.`,
  linterRules: ["sql-injection-check", "gatekeeper-schema-validator"]
};
```
- # 1. Shared Cross-Project State (The Space-Wide Calendar & Ledger)
While project files are isolated (`spaces/{spaceId}/projects/{projectId}/...`), business facts like **Customer Bookings, Appointments, and Client CRM Records** must be visible across **all projects and agents simultaneously**.
Since **`SpaceDO`** is already the single authoritative state actor for the entire business space, we host the **Universal Shared State Plane** directly inside `SpaceDO`'s SQLite database.
```
                                  ┌──────────────────────────────────────────────┐
                                  │       SPACE-WIDE SHARED STATE (SpaceDO)      │
                                  │      `space_calendar` & `shared_crm_state`   │
                                  └──────────────────────┬───────────────────────┘
                                                         │
         ┌───────────────────────────────────────────────┼───────────────────────────────────────────────┐
         ▼ (Book 3:00 PM Slot)                           ▼ (Read Schedule)                               ▼ (Notify Client)
┌─────────────────────────────────┐             ┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ 📞 Voice Call / WhatsApp Bot    │             │ ⚖️ Legal / Dev Workstation      │             │ 🏛️ Space Assistant (CEO)       │
│ Project: `customer_bot`         │             │ Project: `doc_studio`           │             │ (Space-Wide Oversight)          │
├─────────────────────────────────┤             ├─────────────────────────────────┤             ├─────────────────────────────────┤
│ Customer calls or texts:        │             │ Lawyer drafts contract:         │             │ Morning Digest via Telegram:    │
│ "Book consultation for Friday." │             │ Sees Alice booked for Friday;   │             │ "You have 3 consultations       │
│ Writes atomic slot to SpaceDO.  │             │ links client file to calendar.  │             │  booked for today on calendar." │
└─────────────────────────────────┘             └─────────────────────────────────┘             └─────────────────────────────────┘
```
- ### Database Schema in `SpaceDO.ts`:
```sql
-- SpaceDO.ts SQLite Migration
CREATE TABLE IF NOT EXISTS space_calendar_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  created_by_project_id TEXT, -- e.g. "customer_bot" or "voice_agent"
  client_name TEXT NOT NULL,
  client_contact TEXT NOT NULL, -- phone/email
  event_type TEXT NOT NULL,     -- "consultation", "inspection", "support_call"
  start_time TEXT NOT NULL,     -- ISO-8601 UTC
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED', 'RESCHEDULED')),
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
- # 4. How the Entire Flow Works Together
Here is a real-world scenario demonstrating how these three features connect across the platform:
1. **Customer Inbound Voice Call (`kind: "voice_agent"`):**
   A client calls the clinic's phone number. The Cloudflare Calls edge agent answers, checks doctor availability, and books a 3:00 PM appointment for *"John Doe"*.
2. **Atomic Shared State Write (`SpaceDO`):**
   The voice agent writes to `space_calendar_events`. Instantly, `WsHubDO` broadcasts the event.
3. **Cross-Project Awareness (`doc_studio` & `ops_dispatcher`):**
   The clinic's doctor opens their **Document Studio (`doc_studio`)** workstation on desktop. The 3:00 PM appointment is already populated in their patient schedule panel.
4. **Voice-to-Text Dictation (`ComposerDock`):**
   The doctor clicks the 🎙️ **Voice Button** in chat and says:
   > *"Draft John Doe's clinical pre-assessment chart for his 3:00 PM appointment."*
   Workers AI Whisper transcribes it in 300ms, and the AI medical agent begins co-drafting the file immediately.

### 80. Cloudflare OS Stateful Gadgets

**Final behavior:** Living micro-applications built from prompts in 30 seconds, running inside Dynamic Worker isolates with private DO Facet SQLite DBs.

**Production acceptance contract:**
Production entry: `gadgetStorageKey` namespacing helper.
Persistence/deployment: tenant/space/project/gadget R2/DO prefix contract.
Required observable verification: canvas security test covers traversal/isolation key shape only.

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
- Required Fix: Add optional COMPOSIO_API_KEY and PIPEDREAM_API_KEY Workers Secrets to mcp-hub. Key resolution per provider-routed server: (1) if the server row carries auth_secret_name , the builder's own vault credential wins (a builder running their own Composio project keeps full control and their own billing); (2) otherwise the PLATFORM key for that provider is injected server-side — the builder and end user never see it, never enter it; (3) if neither exists, fail with a clear "provider not configured on this platform" error. The platform key lives only inside mcp-hub (already the case for vault credentials — isolates receive only 60-second internal tokens). The reserved money-in tool-name guard is unchanged and applies to platform-keyed calls identically. Naelao's Composio spend becomes a platform cost recovered through credits, exactly like LLM tokens.
- - **F10 (Tier-2/3 isolates get raw, unguarded `fetch`, spec G-AF20)** — **already fixed**, in
  the same pass that closed F13 for the browser worker (see A1.16 Track B/F10+F13 above,
  commit tagged `9a541e1`-equivalent). `workers/agents/src/script-engine/code-runner.ts`'s
  `SSRF_GUARD_PRELUDE` overrides `globalThis.fetch` inside the isolate module text itself
  (`__ssrfGuardedFetch`), and the injected `ctx.fetch` calls that same guarded function — not
  the bare `fetch`. Confirmed by reading the current file (not assuming from memory): lines
  ~87-114 show the guard, line ~124 shows `ctx.fetch: (...a) => __ssrfGuardedFetch(...a)`.
- **F13 (SSRF guard is hostname-literal only, no DNS resolution, spec G-AF20 second half)** —
  **already fixed** in the same pass. The isolate's `SSRF_GUARD_PRELUDE` includes
  `__resolveIps(hostname)` (Cloudflare DoH query for A + AAAA records) and
  `__ssrfGuardedFetch` blocks if ANY resolved IP matches the deny list, in addition to the
  literal-hostname check — closing exactly the DNS-rebinding bypass the spec's clause exists
  for. `@naelao/security`'s `checkSsrf`/`resolveHostnameIps` (used by the browser worker) has
  the equivalent resolution step.
- **F11 (CORS is `*` platform-wide, spec G-AF14)** — **already fixed**, in the first audit
  batch (Track D). `workers/router/src/index.ts`'s CORS middleware (~line 104) is not
  `cors(["*"])` from `packages/http/src/cors.ts` at all — it's a custom, env-driven
  (`CORS_ALLOWLIST`) allowlist middleware that never echoes `*`, reads the allowlist per-request
  (`c.env`, not baked in at module load), and returns an empty `Access-Control-Allow-Origin` for
  a non-allowlisted origin. Regression coverage already exists in
  `tests/unit/router-cors-allowlist.test.ts`.
- 250 - 252
What about allowing user to build micro apps t Small, user-generated full-stack applications built by AI from natural language prompts, running in isolated V8 isolates with private SQLite databases
Utilizes a capability-based security model called Gatekeepers instead of raw API keys, enforcing granular, resource-level permissions so an agent's access never exceeds a human user's limits.
Allowing users to generate **Micro-Apps** on demand from natural language prompts—powered by private SQLite databases running in V8 isolates and protected by the **Gatekeepers capability-based security model**—is the holy grail of enterprise software.
Instead of paying $50/user/month for rigid SaaS tools (Jira, expensify, bespoke form builders), a user simply types:
> *"Build an internal Equipment Checkout app for our warehouse team with QR scanning and a private approval ledger."*
The AI generates the frontend, backend routes, and database schema in **under 30 seconds**, deploying it inside a dedicated **`MicroAppDO` (Durable Object)** at Cloudflare’s edge.
- ### 4. Implementation: The `MicroAppDO` Runtime
Every micro-app runs inside a dedicated Durable Object with **native SQLite storage**:
```typescript
// workers/spaces/src/do/MicroAppDO.ts
import { DurableObject } from "cloudflare:workers";
export class MicroAppDO extends DurableObject {
  private isInitialized = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 1. Serve Edge SSR Frontend (HTML/JS/Tailwind)
    if (url.pathname === "/" || url.pathname === "/app") {
      const appHtml = await this.ctx.storage.get<string>("app_bundle_html");
      return new Response(appHtml || "<h1>Micro-App Initializing...</h1>", {
        headers: { "content-type": "text/html" }
      });
    }
    // 2. Execute Private SQLite API Routes
    if (url.pathname.startsWith("/api/data")) {
      // Validate Gatekeeper capability token
      const token = request.headers.get("x-gatekeeper-token");
      await this.verifyGatekeeperAccess(token, request.method);
      if (request.method === "GET") {
        const rows = this.ctx.storage.sql.exec(`SELECT * FROM app_records ORDER BY created_at DESC`).toArray();
        return Response.json({ ok: true, data: rows });
      }
      if (request.method === "POST") {
        const body = await request.json() as any;
        this.ctx.storage.sql.exec(
          `INSERT INTO app_records (id, data_json, created_at) VALUES (?, ?, datetime('now'))`,
          `rec_${Date.now()}`, JSON.stringify(body)
        );
        return Response.json({ ok: true, message: "Record saved to private SQLite." });
      }
    }
    return new Response("Not Found", { status: 404 });
  }
  private async verifyGatekeeperAccess(token: string | null, method: string) {
    // Cryptographically checks that caller holds valid capability for this specific MicroAppDO
  }
}
```
- ### Summary of What This Adds:
1. **Zero-Code Full-Stack Software on Demand:** Users aren't just getting text answers; they get **real, working web applications with dedicated databases** built in seconds.
2. **No Data Leakage Between Apps:** Every micro-app has its own **isolated SQLite database inside its own Durable Object**—no shared tables, no risk of data contamination.
3. **The Gatekeeper Security Standard:** Capability-based attenuation ensures user-generated apps can **never exceed the creator’s permission ceiling** or access unapproved company resources.

### 81. Plandex-Style Wasm Tree-Sitter Code Indexer Daemon

**Final behavior:** Navigates massive 20M+ token codebases by running `web-tree-sitter` in WebAssembly inside a Dynamic Worker, storing AST symbol graphs in SQLite.

**Production acceptance contract:**
Production entry: no production daemon.
Persistence/deployment: no AST graph SQLite schema/alarm.
Required observable verification: comments or file-search tests are not indexer evidence.

**Retained implementation constraints:**
- 103. **Self-directed loop stopping (real-time progress visibility), a real project-thread/session
     conflation bug fixed, and automatic request-retry-with-visible-feedback — three
     user-reported items, all BUILT.**
     - **The loop previously told the model it was almost out of budget only via `final_step`, on
       the very last possible turn — it had NO visibility into its own progress before that.** A
       model that kept failing had no way to notice and stop itself; the only way a run ever ended
       early was being cut off externally with a generic, unhelpful message. New
       `Reasoner.decide()` `progress` field (`script-engine/loop.ts`) — step / max_steps (the
       runaway ceiling, explicitly NOT a target), successful_actions, failed_actions, stall_steps /
       max_stall_steps, tokens_used / max_tokens — computed fresh and passed on EVERY L3/L4 turn,
       not just the final one. `DECISION_INSTRUCTIONS` (`reasoner.ts`) now tells the model
       explicitly: use this to judge whether you're converging; if failed actions are climbing or
       the stall streak is closing in on its limit with nothing to show, `give_up` on your OWN
       initiative, right now, with a SPECIFIC explanation of what you tried and why it didn't work
       — don't wait to be cut off. This is additive to the existing `final_step` mechanism (item 91
       in the the established specification / the established architecture's own step-budget work), not a replacement — an
       externally-forced stop still happens if the model doesn't act on the signal itself. 2 new
       tests in `agent-loop-unbounded.test.ts`: progress is reported correctly turn-by-turn (not
       just once), and a model that sees 2 failed attempts stops itself after 3 turns total with a
       real reason — nowhere near the 50-step ceiling, proving the stop was self-directed, not
       externally forced.
     - **Reported live: a thread created and chatted in inside a project also appeared in the flat
       Sessions sidebar, as if it were a separate, unrelated conversation — and the thread then
       seemed to "disappear" from the project.** Root cause, confirmed by reading the code rather
       than guessed: `Chat.tsx`'s lazy session creation (`ensureSessionId`) called `startSession()`
       with NO link back to the thread it belonged to, so the resulting session was
       indistinguishable from an ordinary Home/assistant conversation — and SpaceDO's
       `listSessions()` had no way to exclude it, since `t
- The Gap
 Developer Space — The Agent Has wrangler CLI in the Container The Developer Space Code Agent deploys Naelao Apps using wrangler CLI inside the CF Container. Journey step 6 states: "Deploy Agent publishes: deploys MCP Worker via wrangler." This means the container running the code agent has access to a CLOUDFLARE_API_TOKEN that can deploy Workers to Cloudflare. This is one of the most privileged operations possible on the platform — a leaked or misused token can deploy arbitrary code to CF infrastructure. The spec treats this as a capability without specifying the security boundary. There are three critical unresolved questions: Which CF account does wrangler deploy to? If it deploys to…
- **Sub-agents — real spawn/receive/terminate.** `NaelaoAgentDO.buildOrchestrationHooks()`
implements the `OrchestrationHooks` the `sub-agent` prebuilt already called (previously always
"unavailable" — no host had wired them). `agent.spawn` accepts a **batch** of tasks
(`{ tasks: [{goal, budget_tokens?, model?}, ...] }`) and spawns them **concurrently** via
`Promise.all` against sibling `NaelaoAgentDO` instances (`idFromName(`sub:{spaceId}:{subId}`)`)
— see A1.12 for why batching is the chosen shape for parallelism here. Each child gets its own
budget (`budget_tokens` → real per-token enforcement in the loop itself as of A1.14, backstopped
by a coarse step ceiling via `budgetToMaxSteps`; never inherited from the parent — fixes
"Sub-Agent Token Budget Not Isolated From Parent"); spawning is `await`ed
synchronously inside the parent's own request, so a child can never be orphaned by the parent's
response completing first (fixes "Sub-agents have no parent-liveness link" structurally, not by
polling); a fleet-wide batch cap (`MAX_SUB_AGENTS_PER_SPAWN = 16`, deliberately the same order
of magnitude as Claude Code's own subagent fan-out) bounds the blast radius (fixes "No
Account-Level Parallelism Ceiling"); every child's output is wrapped in
`<untrusted_subagent_result>` and moderation-scanned before the parent ever sees it (fixes
"Sub-Agent Output Schema Enforcement" — output is data, never instructions). `agent.receive`
polls the new `sub_agents` table; `agent.terminate` marks a row terminated; `agent.send` is
intentionally a no-op explainer (children run to completion synchronously in this build —
fan out another batch instead of messaging a "running" one).

### 82. Domain-Specific Durable Daemons (Active Services)

**Final behavior:** Background data engines combining stateful SQLite memory with autonomous workflow loops (e.g. Ledger Reconciler, Citation Grapher, Customs Matrix).

**Production acceptance contract:**
Production entry: `validateExtensionManifest`.
Persistence/deployment: declared permissions and bounded lifecycle contract.
Required observable verification: extension test checks retry/alarm bounds; worker journey required.

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
- The Gap
 CF Durable Objects SQLite storage has a 1 GB limit per Cloudflare account, not per DO instance. The spec treats SpaceDO as if each space gets an unlimited personal SQLite database and stores threads, messages, memories, knowledge chunks, workflow definitions, and file metadata all in SpaceDO SQLite. With 100 active spaces the average per-space budget is 10 MB. A single space with a large knowledge base (5,000 chunks × 2 KB each = 10 MB) consumes the entire per-space budget. When the account-wide 1 GB limit is reached, all writes to all SpaceDOs fail simultaneously with no warning to the user.
- **Session token-budget guard — the actual differentiator vs. OpenClaw's "$300-500/mo, no
warning" complaints.** New `SpaceTypeProductConfig.limits.sessionCreditCeiling` (config_json
override, same convention as `modelConfig`/`pricingConfig` — never a manifest fork), resolved
once in `index.ts` next to `modelConfig` (this DO has no `PLATFORM_DB` binding) and threaded
through all three dispatch paths that reach `handleScriptRun` (the sync `/script/run` call, the
async `AgentTaskWorkflow` params, and `/internal/tasks/:taskId/run`) so the guard applies
identically to interactive and durable runs. New `session_spend` table (SpaceDO migration v31,
same one as the signals table) holds only the running tally — the ceiling itself is never stored
there, avoiding a split-brain against the config_json copy.

### 83. Modular Extensions Architecture

**Final behavior:** Clean naming taxonomy: whole-space blueprints are **Templates**; atomic modular add-ons (daemons, viewports, tools) are **Extensions**.

**Production acceptance contract:**
Production entry: extension runtime helpers and template catalogue.
Persistence/deployment: versioned immutable extension manifests.
Required observable verification: extension security test covers declaration/enforcement.

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
- Required Fix: Enforce at every path where template ids enter provisioning: business creation for end users ( createBusinessForEndUser , covering both the product-scoped route and reseller spaces) and builder product creation. Resolve the OWNING org's plan tier ( EntitlementsChecker.getTenantTier — end-user claims already carry the owning tenant); on the free tier, any requested template with free_tier_eligible !== true is rejected 403 plan_upgrade_required naming the offending templates. Empty template list ("Custom, build with the assistant") stays allowed — usage caps bound it. Unknown/missing tier resolves to free (fail closed). The shell's template catalogue projection carries free_tier_eligible so the create dialog greys ineligible templates instead of letting the request fail.
- Tests: 5 new in `tests/unit/whop-wallet.test.ts` — onboarding-link capture + best-effort owner
notification, an owner with an existing Whop account provisioning straight to `active` (no link
needed), `GET balance` surfacing `onboarding_url` only while `awaiting_kyc`, a payout rejection
naming verification explicitly, and a live sync deriving `awaiting_kyc` from
`payouts_enabled: false` independent of Whop's own status string. 1823/1823 suite green,
`pnpm turbo run typecheck` clean (75 tasks), dashboard + shell both verified via `next build`.
**Not done:** the exact onboarding-link field name and full connected-account response shape
remain unverified against live Whop docs — confirm once Platforms API access is actually granted
(apply via `sales@whop.com`) and narrow the defensive multi-field check accordingly.

### 84. Auto-Generated Stateless MCP v2 Endpoints for Daemons & Gadgets

**Final behavior:** Automatically exposes `/mcp` endpoints wrapping internal SQLite schemas using Cloudflare MCP SDK v2.

**Production acceptance contract:**
Production entry: connector MCP is not gadget MCP.
Persistence/deployment: project-scoped tool schema/transport absent.
Required observable verification: requires standard MCP contract tests.

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

- The Gap: When a builder exposes their Space as an API (via G-AQ32 OAuth or API keys), external developers integrating with the Space have no documentation. No auto-generated OpenAPI docs exist for a Space's public API. Builders must manually document their API, which is tedious and often not done.
 Required Fix: Auto-generate Space API documentation: GET /spaces/{id}/openapi.json returns OpenAPI 3.0 spec for the Space's public endpoints (agent run, conversation history, KB search, analytics read). Generated from SpaceConfig: agent definitions become endpoints; tool definitions become request schemas. Hosted docs: GET /spaces/{id}/docs renders Swagger UI. Builder can customize: description, examples, authentication instructions. Docs linked from developer portal (G-AP16). Updated automatically on SpaceConfig change. Include code examples in Python, JavaScript, and cURL.
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
- ### 2. Micro-Apps with DO Facet SQLite + Auto-Generated MCP v2 Servers
This is the real architectural breakthrough: **every AI-generated Micro-App becomes a living, queryable MCP v2 service.**
When a user asks the AI to build a full-stack micro-app (e.g. an *Employee Equipment Checkout App* or a *Custom Client Feedback Tracker*):
```
[ User: "Build a warehouse equipment checkout app with barcode ID & return dates" ]
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. DURABLE OBJECT FACET (On-the-Fly Isolated SQLite Database)               │
│    Spins up an isolated SQLite database inside DO memory in 5ms:            │
│    `CREATE TABLE equipment (id, name, status, assigned_user, return_date)` │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. DYNAMIC WORKER RUNTIME (Interactive Frontend UI)                         │
│    Renders a clean Tailwind/Preact web application deployed to edge.        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. ⚡ AUTO-GENERATED STATELESS MCP v2 SERVER (`createMcpHandler`)           │
│    The runtime AUTOMATICALLY generates an MCP server for that specific app! │
│    Exposes tools at: `/spaces/{spaceId}/apps/equipment/mcp`:                │
│    • `app_equipment_list(filter)`                                           │
│    • `app_equipment_checkout(itemId, userId, returnDate)`                   │
│    • `app_equipment_checkin(itemId)`                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### 3. The Superpower: Universal Agent-to-App Interoperability
Because every micro-app automatically generates its own **stateless MCP v2 server** [1.2.2, 1.2.6], **every other agent and external tool on the platform can now read and automate that micro-app natively!**
```
                                  ┌──────────────────────────────────────────────┐
                                  │      MICRO-APP: "Warehouse Equipment Desk"   │
                                  │   (DO Facet SQLite + Auto-Generated MCP v2)  │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┼───────────────────────────────┐
                         ▼                               ▼                               ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ 👩‍💻 Human Teammate on Web       │             │ 📞 Voice Phone Agent            │             │ 🏛️ Space Assistant (CEO)       │
│ Interacts with visual UI buttons│             │ Customer calls inbound on phone:│             │ Nightly autonomous cron review: │
│ and checks out items on canvas. │             │ "Do you have a 4K camera open?" │             │ Scans overdue items and drafts  │
│                                 │             │ Queries `app_equipment_list()`. │             │ Slack reminder notifications.   │
└─────────────────────────────────┘             └─────────────────────────────────┘             └─────────────────────────────────┘
```
- ### 4. Implementation: The Auto-MCP v2 Factory for Micro-Apps
Using Cloudflare's `@cloudflare/mcp` and `createMcpHandler`, the runtime wraps any DO Facet SQLite table into an MCP server automatically [1.2.2, 1.2.6]:
```typescript
// workers/spaces/src/engine/AutoMcpFactory.ts
import { createMcpHandler } from "@cloudflare/mcp";
export function generateMcpServerForMicroApp(
  appId: string,
  doStorage: DurableObjectStorage,
  tableSchema: Record<string, string> // e.g. { name: "string", status: "string", returnDate: "string" }
) {
  return createMcpHandler({
    tools: {
      // 1. Auto-generated List/Query Tool
      [`app_${appId}_list`]: {
        description: `Query and filter records in the ${appId} micro-app database.`,
        parameters: {
          filter: { type: "string", description: "Optional SQL WHERE clause" },
          limit: { type: "number", description: "Max records to return" }
        },
        execute: async ({ filter, limit }) => {
          const sql = `SELECT * FROM app_records ${filter ? `WHERE ${filter}` : ""} ORDER BY created_at DESC LIMIT ?`;
          return doStorage.sql.exec(sql, limit || 50).toArray();
        }
      },
      // 2. Auto-generated Insert/Create Tool
      [`app_${appId}_insert`]: {
        description: `Insert a new record into the ${appId} micro-app.`,
        parameters: {
          data: { type: "object", description: "JSON data matching app schema" }
        },
        execute: async ({ data }) => {
          const id = `rec_${Date.now()}`;
          doStorage.sql.exec(
            `INSERT INTO app_records (id, data_json, created_at) VALUES (?, ?, datetime('now'))`,
            id, JSON.stringify(data)
          );
          return { ok: true, id, message: `Record created in ${appId}` };
        }
      }
    }
  });
}
```

### 85. Bidirectional MCP-UI Real-Time Canvas Streaming

**Final behavior:** Canvas iframe actions (clicks, form submits, table edits) stream into the agent's observation loop over WebSockets in real time.

**Production acceptance contract:**
Production entry: `acceptCanvasEvent`; ws-gateway.
Persistence/deployment: authenticated WS session state.
Required observable verification: canvas security test rejects hostile origins/payloads.

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

- The Gap naelao-together-ai settles the WalletDO credit reservation via ctx.waitUntil(walletDO.settle(reservationId, actualCredits)) after returning the streaming response. CF Workers guarantee that waitUntil() extends the worker lifetime, but this is not absolute: platform incidents, aggressive eviction, or timeout overruns can terminate the worker before the settlement resolves. If settlement never completes, the 300-second reservation sweep in WalletDO refunds the credits. The user received LLM inference for free. Under high-volume concurrent streaming this is an exploitable revenue leak: a client that opens thousands of simultaneous streams and aborts them immediately forces reservations that never settle, each refunding after 5 minutes.
- 1. **Execution ceiling** (`projects.execution_ceiling`, 1-5) — caps which execution-ladder
   tier the bound agent may use. Enforced in `ScriptToolSurface` (`code-runner.ts`'s
   sibling, not it) at `script.create`, `script.update` (including retroactively, if an
   admin lowers the ceiling after scripts already exist), *and* `script.run` — for both
   prebuilt ops and stored scripts. A ceiling of 2 means "talk and look things up, never
   touch a container or browser." `ScriptEngineEnv.maxTier` is the plumbing; it's set per
   message in the heartbeat, not once per agent, since one heartbeat sweep can touch several
   projects with different ceilings.
2. **Daily spend cap** (`projects.daily_spend_cap_credits`) — a project-scoped running total
   (`NaelaoAgentDO.project_spend`, `tokens_used` as an honest proxy for "credits," not a real
   billing conversion) that the heartbeat checks before each reasoning-loop call; once hit,
   remaining messages for that project are marked `spend_capped` (visible, not silently
   dropped) until the next UTC day.
3. **No-code rules** (`project_rules` table) — "after the customer says X, this happens,"
   admin-authored via form fields, checked **before** the reasoning loop even runs (zero
   token cost, deterministic). Three actions: `reply` (canned text), `run_script` (a named
   library script, still ceiling-checked), `human_takeover` (silences the bot for that one
   thread — `channel_sessions.human_takeover` — until an admin calls `.../resume`). Every
   template seeds STOP/UNSUBSCRIBE (WhatsApp Business Platform compliance, not optional) and
   a "talk to a human" escape hatch at the highest priority, so a customer can always reach a
   person and opt out, regardless of what the builder configures on top.
- ### The MCP-UI Protocol: Making Canvas Actions Observable to Agents
Normally, if a user interacts with an app inside an iframe (e.g. clicks a checkbox, submits a form, or drags a Kanban card), **the AI agent is completely blind to it**.
With **MCP-UI**, the Micro-App / Canvas iframe emits structured **UI Action Events** back to the agent's Durable Object over WebSockets in real time:
```
[ User interacts with Micro-App on Canvas (e.g. Clicks "Reject Invoice #42") ]
                                    │
                                    ▼ (MCP-UI JSON-RPC Stream)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. MCP-UI EMISSION:                                                         │
│    `window.postMessage({ type: "mcp.ui_action", action: "INVOICE_REJECTED",│
│                          payload: { invoiceId: "42", reason: "Over budget" }│
│                        })`                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. AGENT OBSERVATION INJECTION:                                             │
│    The agent's active reasoning loop receives this as an instant turn:      │
│    `<ui_action_event user="bob" action="INVOICE_REJECTED" id="42" />`       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. AUTONOMOUS AGENT REACTION:                                               │
│    Agent automatically logs the rejection to the Project Journal, updates   │
│    the DO Facet SQLite database, and drafts an email to the supplier!       │
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

### 86. Generative In-Chat Dynamic UI Widgets

**Final behavior:** The model streams interactive UI components (date pickers, sliders, approval cards) directly into the message feed.

**Production acceptance contract:**
Production entry: `validateGeneratedWidget`.
Persistence/deployment: message event JSON only, never executable source.
Required observable verification: canvas security test rejects script/html/srcdoc fields.

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
- Required Fix Implement in-chat approval using the SDK hook. In the operator shell: const {messages, addToolApprovalResponse} = useAgentChat({agent: "AssistantDO", name: spaceId}). Render approval cards inline in the message list: {messages.map(m => m.parts?.filter(p => p.type === "tool-approval").map(p => (<ApprovalCard key={p.id} toolName={p.toolName} args={p.args} onApprove={() => addToolApprovalResponse({id: p.id, approved: true})} onReject={() => addToolApprovalResponse({id: p.id, approved: false, data: {reason: "User rejected"}})} />)))}. Retain the email/push fallback for approvals where the user is not actively in the chat (implement the REST POST endpoint for those), but make in-chat the primary path.
- **G4 — autonomy toggle reuses the ALREADY-BUILT `assistant_policy` gate (SpaceDO migration v14) —
no new gate engine.** Two things had to be gotten right that weren't obvious from the plan: (1) for
the Space Assistant specifically (no `projectId`), `AgentConfig.requiresApprovalFor` is completely
ignored by `NaelaoAgentDO.handleScriptRun` — the assistant's gate list comes exclusively from the
space's `assistant_policy` row, fetched fresh per run, so G1's profile does NOT set that field; (2)
`assistant_policy` has no provisioning-time seed anywhere in the codebase (the row is created
lazily via PATCH), so a fresh Launchpad space's assistant would default to `always_ask` with an
EMPTY `auto_approved_actions` — gating even harmless reads like listing projects. New
`seedLaunchpadAssistantPolicy` (provisioner) PATCHes a "guided" default (`always_ask` +
`LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED`: `project.list`, `agent.list`,
`commerce.list_products`, `commerce.get_order`, `mcp.list_servers`, `mcp.list_tools`,
`memory.recall`) at install time, best-effort/non-fatal like `seedOwnerMember`. The builder-facing
toggle is a new "Naelao Agent — Space Assistant" card at the top of the dashboard's existing Agents
tab (`apps/dashboard/.../products/[productId]/agents/page.tsx`) with Guided/Autonomous buttons that
PATCH `approval_mode` between `always_ask` and `yolo` via two new thin API functions
(`getAssistantPolicy`/`updateAssistantPolicy` in `apps/dashboard/src/lib/api.ts`) calling the
already-HMAC-gated `/spaces/:spaceId/assistant-policy` route directly (the product root space IS
the product, so no new builder-scoped endpoint was needed) — deliberately NOT exposed in
`apps/shell` yet, since that route only checks tenant-match, not per-business ownership, and
allowlisting it for `product_end_user` callers would need a `requireBusinessMembership`-style
owner/admin floor first (the same "identity, not authorization" gap every prior router-allowlist
addition has had to close) — a real, scoped follow-up rather than rushed in.
- ### 1. The Dynamic In-Chat Generative UI (Google Search AI Mode Style)
Instead of dumping a wall of markdown text or forcing users to fill out complex forms, the AI dynamically streams **interactive UI widgets directly inside the chat stream** whenever it needs structured input or wants to present decision-grade data:
```
                                  ┌──────────────────────────────────────────────┐
                                  │      DYNAMIC STREAMING IN-CHAT GENERATIVE UI │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┼───────────────────────────────┐
                         ▼                               ▼                               ▼
┌─────────────────────────────────┐             ┌─────────────────────────────────┐             ┌─────────────────────────────────┐
│ 🎛️ 1. Structured Input Widgets  │             │ 📊 2. Dynamic Decision Tables   │             │ ⚡ 3. Real-Time Action Cards     │
├─────────────────────────────────┤             ├─────────────────────────────────┤             ├─────────────────────────────────┤
│ • Interactive Date/Time Pickers │             │ • Interactive filterable tables │             │ • Live Approval & Rollback      │
│ • Range sliders (budget, price) │             │ • Sortable competitor comps     │             │ • Instant 1-click execution     │
│ • Multi-select tag chips        │             │ • Clickable metric breakdowns   │             │ • Live progress meters          │
└─────────────────────────────────┘             └─────────────────────────────────┘             └─────────────────────────────────┘
```
- ### 2. Micro-Apps with DO Facet SQLite + Auto-Generated MCP v2 Servers
This is the real architectural breakthrough: **every AI-generated Micro-App becomes a living, queryable MCP v2 service.**
When a user asks the AI to build a full-stack micro-app (e.g. an *Employee Equipment Checkout App* or a *Custom Client Feedback Tracker*):
```
[ User: "Build a warehouse equipment checkout app with barcode ID & return dates" ]
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. DURABLE OBJECT FACET (On-the-Fly Isolated SQLite Database)               │
│    Spins up an isolated SQLite database inside DO memory in 5ms:            │
│    `CREATE TABLE equipment (id, name, status, assigned_user, return_date)` │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. DYNAMIC WORKER RUNTIME (Interactive Frontend UI)                         │
│    Renders a clean Tailwind/Preact web application deployed to edge.        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. ⚡ AUTO-GENERATED STATELESS MCP v2 SERVER (`createMcpHandler`)           │
│    The runtime AUTOMATICALLY generates an MCP server for that specific app! │
│    Exposes tools at: `/spaces/{spaceId}/apps/equipment/mcp`:                │
│    • `app_equipment_list(filter)`                                           │
│    • `app_equipment_checkout(itemId, userId, returnDate)`                   │
│    • `app_equipment_checkin(itemId)`                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### Summary of What This Creates
| Feature | How It Transforms the Platform |
| :--- | :--- |
| **Generative In-Chat UI** | Replaces static markdown with **live, interactive widgets** (Google Search AI mode style) that users click and tweak inside the chat bubble. |
| **DO Facet SQLite Databases** | Gives every user-generated micro-app its own **isolated, sub-millisecond database** running inside Cloudflare Durable Objects [1.2.1]. |
| **On-Demand MCP v2 Servers** | Automatically turns every micro-app into an **external MCP server**, allowing Voice Agents, Space Assistants, and external Cursor/Claude tools to automate the app programmatically [1.2.2, 1.2.7]. |
| **Unified State Mesh** | Humans use the visual UI on screen; AI agents interact via MCP v2 in the background; data stays synchronized in real time. |

### 87. 3-Class Workflow Taxonomy

**Final behavior:** Classifies workflows as: Class 1 (Company Automations), Class 2 (Vertical Extensions), or Class 3 (Ephemeral Tasks), establishing distinct escalation paths.

**Production acceptance contract:**
Production entry: `WORKFLOW_CLASS_POLICIES`.
Persistence/deployment: workflow records and billing attribution required.
Required observable verification: canvas/extension test validates every policy dimension.

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
- - `NaelaoAgentDO.settleRunBilling`: a new `NaelaoAgentDO.infraResourceTypeForTier(tier)` maps
  `ExecutionTier` 2-4 → `"isolate"`, 5 → `"container"` (Tier 1, in-process R2, is excluded — not a
  distinct CF resource, and `duration_ms` is always 0 there anyway). The infra-credit computation
  and recording now happens **before** the function's pre-existing `if (!tokensUsed) return;`
  early-out, not after — a pure script execution with zero LLM tokens (e.g. a scheduled
  `workflow.run` with no reasoning step) still consumes real isolate/container time and must not
  silently go unmetered just because it made no LLM call. Recorded via the same `/billing/usage`
  POST mechanism (`event_type: "infra_credits"`) the existing `llm_tokens` recording already uses,
  for **every** run with a measurable tier+duration regardless of caller role (pure observability
  — this is deliberately broader than the enforcement gate below). Also emits a new Analytics
  Engine data point (`infra.execution.completed`, `packages/analytics-schema`'s versioned slot
  layout, `tenant_id` in `indexes[0]`, best-effort try/catch matching every existing call site).
- `ScriptRunWorkflow`'s `execute-script` step and `AgentTaskWorkflow`'s `run-agent` step (the two
  steps that dispatch real work — not the trivial DO status-update steps in either workflow,
  which aren't metered) gained real `Date.now()` wall-clock bracketing where **none existed
  before** (confirmed during the earlier exploration pass: zero `Date.now()` calls in either
  file). A new shared `reportWorkflowStepInfraUsage()` (`workers/agents/src/workflows/
  report-infra-usage.ts`) posts `resourceType: "workflow_step"` usage — Workflow classes share the
  agents worker's plain `Env` (`workers/agents/src/env.ts`), not `NaelaoAgentDO`'s own
  `internalHeaders()`/`BILLING_WORKER` wiring, so this needed a small standalone equivalent rather
  than a DO method; `Env` gained `BILLING_WORKER?: Fetcher` (the binding already exists in
  `wrangler.toml` under the `naelao-billing` service — it was just missing from this particular
  shared TypeScript interface, a real but narrow gap).

## Final reconciled architectural changes (newest authority)

These are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.

#### 9. The Immutable AI Loop vs. Userspace Extensions
* **This updates/replaces:** The idea that extensions or plugins can rewrite or replace the core agent REPL loop.
* **The New Architecture & Mental Model:** The AI reasoning loop is the **sovereign kernel of AVOS (`NaelaoAgentDO`)** and is strictly immutable. Extensions run in **userspace** and are strictly additive. They provide background reference manuals (daemons), tools in `$PATH` (virtual CLIs), and UI monitors (viewports), but never hijack how the agent loops, reasons, or verifies.
* **Key Invariant:** Extensions cannot bypass Gatekeepers, disable WriteGuard, or commit unreviewed code to `main`.

#### 10. Durable Daemons (Fusing Micro-Apps with Dynamic Workflows)
* **This updates/replaces:** Treating Micro-Apps (static UI/DB) and Dynamic Workflows (ephemeral cron/pipelines) as disconnected features.
* **The New Architecture & Mental Model:** Combines a stateful DO Facet SQLite database with a continuous Cloudflare Workflow into a **Durable Daemon (or Active Service)**. Runs autonomously in the background across domains:
  * *Code:* Plandex-style Wasm Tree-Sitter AST Symbol Indexer (`ext_tree_sitter_indexer`).
  * *Finance:* General Ledger Double-Entry Reconciler (`gadget_ledger_reconciler`).
  * *Legal:* Delaware Case Law & Statute Citation Grapher (`gadget_citation_matrix`).
* **Key Invariant:** Daemons operate continuously in the background with zero CPU or token drag on active user chat sessions, auto-exposing `/mcp` endpoints to agents.

#### 17. Generalization of `/workspace/` (Deliverable Canvas, Not Just Code)
* **This updates/replaces:** The developer bias that Git and `/workspace/` are strictly for programming source code.
* **The New Architecture & Mental Model:** `/workspace/` is the **Project Deliverable Canvas** regardless of file format. In legal projects, it holds contract suites (`.docx`, `.md`); in finance, it holds Excel models (`.xlsx`, `.csv`); in coding, it holds source code (`src/`). All executable agent machinery (skills, workflows, daemons) lives strictly in `/.avos/`.
* **Key Invariant:** Cloudflare Artifacts (Git for Agents) versions any file type; Pull Request cards adapt to show spreadsheet cell deltas or document redlines.

#### 18. Strict UI Bifurcation: Client Workspace ("Apple Clean") vs. Developer Foundry
* **This updates/replaces:** Exposing technical knobs, model selectors, and tier sliders to non-technical business clients.
* **The New Architecture & Mental Model:**
  * **Client Workspace (`apps/shell`):** 85% of screen is the Work Viewport Canvas + clean command bar + 1-click action buttons. Zero technical knobs.
  * **Developer Portal (`apps/partner-studio`):** The full engineering workbench where FDEs and template authors configure 6-tier ladder ceilings, tune Tree-Sitter daemons, wire workflows, and package blueprints.
* **Key Invariant (Zero-Exposed-Machinery Rule):** Business clients never see model names, compute tiers, or raw Git merge markers.

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
