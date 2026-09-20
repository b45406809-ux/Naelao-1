# AI Studio implementation prompt — batch 10, plan items 88–103

## Manual AI Studio hand-off contract

Implement this batch against the repository snapshot embedded after this instruction. Return the
implementation as **one complete unified Git diff** beginning with `diff --git`. Do not return a
shell script, prose before the diff, a partial snippet, or Markdown fences. The downloaded response
must be saved as `repomix/patches/batch-10.patch` and committed to
the accumulator branch. That path triggers the repository's batch-application workflow, which
validates and applies the patch, rebuilds the prompts, verifies the Repomix configuration, commits
the resulting code, and publishes the next batch XML plus its prompt as a workflow artifact.

The patch must not edit generated `repomix/outputs/` files, `.repomix-cache/`, or the downloaded
patch itself. Include tests and configuration changes in the same diff. If the entire batch cannot
fit, still return one apply-ready diff at an atomic verified boundary; the next downloaded patch
for the same batch continues from the newly generated repository snapshot.

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Subagent workflows, webhook reliability, queues, replay, scheduling, and calendars**. This prompt is self-contained: the feature definitions and retained implementation
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

### 88. Asymmetric Subagent Topology (Verbs vs. Nouns)

**Final behavior:** Subagents are ephemeral execution functions ("verbs") inside workflows; only Parent Agents are persistent entities ("nouns") managing threads and UI.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- // LaunchpadMiniAGIConfig — only activated in autonomous mode
interface LaunchpadMiniAGIConfig {
 enabled: boolean;
 goalStatement: string; // the high-level goal
 planningHorizon: &#x27;1d&#x27; | &#x27;7d&#x27; | &#x27;30d&#x27;; // how far ahead to plan
 maxSubAgents: number; // parallel execution limit
 autonomousSpend: number; // monthly budget agent can spend alone
 approvalThreshold: number; // single action approval threshold
 prohibitedActions: string[]; // e.g. [&#x27;delete_product&#x27;, &#x27;cancel_subscription&#x27;]
 // Actions the agent can NEVER take regardless of goal — hard-coded safety fence
}
- **Thread hierarchy — sub-agents and channel sessions are subthreads, not a new concept.**
SpaceDO's `threads` table (migration v8) existed but had no CRUD at all until this pass — it's
now real: `POST/GET /threads`, scoped by `space_id`/`project_id`. Migration v13 adds
`parent_thread_id`, `thread_kind` (`primary`/`sub_agent`/`channel`), and `channel`/
`channel_session_id` columns. A sub-agent spawn (`NaelaoAgentDO.spawnSubAgentBatch`) and a new
channel session (`handleChannelInbound`, first sight of a `(channel, channel_user_id)` pair
only) both call a new `mirrorThread()` helper that POSTs to SpaceDO — best-effort, the DO's own
`sub_agents`/`channel_sessions` tables remain the source of truth for actual bot logic; this is
purely so an admin can browse the tree from the ordinary thread list. **Default listing hides
`thread_kind != 'primary'`** (a 16-way sub-agent fan-out or a busy WhatsApp bot must not flood
a builder's thread list) — a project opts in via the new `projects.show_sub_threads` column
(`PATCH /projects/:id { show_sub_threads: true }`), or any caller passes
`?include_sub_threads=true` to see the full tree, nested via `parent_thread_id`, on demand.

### 89. Slimmed-Down `SubagentContext`

**Final behavior:** Strips thread creation, WebSocket handles, and session bloat, exposing only `ai`, `fs`, `cli`, `vault`, and `step` to guarantee step serialization.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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

- The Gap: FCM and APNs do not guarantee delivery order for rapid notification sequences. A "payment processing" notification may arrive after "payment confirmed", confusing users. Critical transactional sequences (payment status, Space status changes) require ordered delivery. No sequence number or ordering mechanism exists.
 Required Fix: Add sequence numbers to all notifications: NotificationDO maintains a per-builder monotonic sequence counter. Each notification includes seq: number . Client SDK buffers received notifications and reorders by seq before displaying. For critical transactional sequences: use email (SMTP guarantees ordering via message threading) instead of push. FCM/APNs push used for low-stakes alerts only. For urgent sequences: use WebSocket push (ordered delivery via TCP) with push as fallback if WebSocket not connected.
- **UI verification: found and worked around a real pre-existing dashboard-wide bug, not
introduced by this phase.** No browser-automation package (playwright/puppeteer) exists anywhere
in this repo, so verification used raw Chrome DevTools Protocol (Node's built-in `WebSocket`,
`/opt/pw-browsers`'s prebuilt Chromium) driven by hand. That process surfaced a real bug in
`apps/dashboard/src/lib/auth-provider.tsx`: on a hard reload of ANY nested `/dashboard/*` route
(not just this one — reproduced identically on the pre-existing `/dashboard/clients`), a race
between `DashboardLayout`'s auth-guard effect and `AuthProvider`'s own localStorage-hydration
effect bounces the user through `/login` and back to the generic `/dashboard`, silently dropping
the originally-requested path. This is a real, separate, dashboard-wide bug — flagged here, not
fixed (out of scope for a wizard feature; a future pass should fix `AuthProvider`'s hydration
ordering). Once reached via realistic client-side `<Link>` navigation (the way an actual user
gets there — click "Products" in the sidebar, then "+ New Product"), the wizard itself works
correctly end-to-end: all 7 steps render, the step indicator advances, Identity-step validation
blocks progression on a missing name, the Temple/SpaceType step's fetch-failure path degrades to
a clean "Failed to fetch" message (correct, since no backend worker was running in this
verification session) rather than crashing, and no console errors originated from any of this
phase's own components (the only warning present — `LoginPage`'s render-time `router.push` — is
that same pre-existing bug, not new code).

### 90. Repomix-Style Chunked Subagent Workflow with Branch Accumulator

**Final behavior:** Two-pass workflow: generates compressed repo map $\rightarrow$ selects files $\rightarrow$ implements atomic chunk $\rightarrow$ commits. Branch accumulator tracks new files automatically.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- The Gap: Space configurations (agents, tools, KB manifests, ThemeConfig) are managed only via the Naelao dashboard or API. No GitOps workflow exists to version Space config in git, review changes via PR, and automatically deploy on merge. Enterprise builders who manage infrastructure-as-code are blocked from adopting Naelao.
 Required Fix: Build Naelao GitHub App: installs on builder's GitHub org. Builder maps a repository to a Space: .naelao/space.config.json defines all Space configuration. On merge to main branch: GitHub App webhook triggers naelao deploy GitHub Action. Action calls POST /spaces/{id}/deploy with config JSON payload. Naelao applies config, runs smoke test (G-AQ06), returns deploy status. PR comments: Naelao bot previews config diff and validation results. Failure: deploy blocked, PR status check fails. Builder manages config in git; dashboard shows read-only view of deployed config.
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

### 91. Cloudflare Workflows Harness Pattern

**Final behavior:** The AI writes pure business logic (`execute(step, ctx)`); the platform compiler automatically wraps it in `WorkflowEntrypoint<Env>`.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 111. **The re-fire confirmed item 110's model fix AND exposed the next layer: a model mistyping a
     script name killed the entire run.** The 15:00 sweep ran the job at 15:02:24 UTC with no
     `Model not found` — the 404 is genuinely gone. It failed for a completely different reason:
     `{"error":"Invalid script name: \"notifications prebuilt\""}`, `consecutive_failures: 1`. The
     model chose to run the `notifications` prebuilt by its **descriptive phrase** instead of one
     of its real operation names, and `SkillLibrary.read()`/`exists()` asserted the name was a safe
     path segment and **threw**. That throw escaped `ScriptToolSurface.run()`'s per-step error
     handling entirely and killed the whole run — so a model typo was fatal rather than a step it
     could observe and correct. Worst precisely on the unattended proactive path, where nobody is
     watching to retry: the job records a failure and goes quiet.
     - **Fixed by splitting lookups from writes.** The two LOOKUPS (`read`, `exists`) now report
       "no such script" for an unusable name; all six WRITE paths (`create`/`update`/`patch`/
       `rollback`/`delete`/`import`) still call `assertName` and still throw, since there a bad name
       is a bug or an attack, not a typo. Path safety is unchanged either way — an unusable name
       never reaches the bucket, asserted directly by a test that counts bucket touches.
     - **The resulting failure now teaches the model** rather than leaving it to re-guess until the
       stall budget runs out: `Unknown script or operation: X` gained a "Did you mean…" naming the
       closest real operations. **That match considers the owning prebuilt's NAME as well as the op
       name**, which turned out to be load-bearing — `notifications` owns ops prefixed `notify.`
       (`notify.email`, `notify.slack`, …), so matching op names alone would have suggested
       *nothing* for this exact failure. The prebuilt name is what the model sees listed in its own
       profile, and that prefix mismatch is very likely why it reached for the wrong name at all.
       Prebuilt ops only — they're already in memory, so a miss costs nothing, whereas listing the
       R2 skill library would turn every mistyped name into a bucket listing.
     - **The new test was verified to catch the bug**, not merely to pass: reverting the one-line
       `read()` change fails 3 of its 5 cases, including the exact live-failure string.
     - **The actual root cause
- The Gap The naelao-workflows worker loads user workflow code from R2 (const code = await codeObj.text()) then calls env.DISPATCH_NAMESPACE.get(spaceId + '-' + workflowId) to dispatch it. dispatchNamespace.get(name) retrieves a pre-deployed script by its registered script name — it does not accept or execute code dynamically. The script named spaceId + '-' + workflowId does not exist in the dispatch namespace unless it was previously uploaded via the Cloudflare Workers for Platforms Upload API. The prompt acknowledges eval() and dynamic import() are prohibited but never includes the required upload step. Every workflow dispatch call throws "Worker not found" at runtime. The prompt stores code in R2 as the "source of truth" but CF Workers for Platforms requires the code to be uploaded to the namespace separately via the CF API before dispatch is possible.
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

### 92. Edge Ingress Webhook Router with HMAC Validation

**Final behavior:** Validates cryptographic HMAC signatures (Stripe, GitHub, Shopify) in sub-2ms before passing payloads to compute tiers.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 128. **"insufficient credits — top up or subscribe to keep chatting" is now a real upgrade dialog,
     not a bare error banner — and the underlying gap it exposed (a billing gate's machine-
     readable `error_code` was parsed and then silently discarded on the async dispatch path,
     every real chat message's path) is fixed at the root.** Traced the exact string to
     `NaelaoAgentDO.enforceRunGates`'s `product_end_user` own-balance credit check (a `402` with
     `error_code: "insufficient_credits"`) — one of several billing gates sharing this shape
     (`subscription_inactive`, `quota_exceeded`, `infra_quota_exceeded`, and a DIFFERENT
     `insufficient_credits` variant for an empty PROJECT wallet, distinguished by message text).
     `AgentTaskWorkflow`'s `run-agent` step (item 104's own failure-handling rewrite) already
     parsed `error_code` off a non-ok response and then dropped it on the floor before it ever
     reached step 3's TaskDO write — and even if it hadn't, step 3's `result` was hardcoded to
     `null` on any hard error with no deferred approvals, so there was nowhere for it to land.
     Fixed end to end: `AgentTaskWorkflow` now carries `error_code` through `runResult`, into
     TaskDO's stored `result` JSON (extending the existing "never let deferred_approvals vanish
     along with an error" precedent to `error_code` too), and through its own replay-safety ledger
     read; `fetchRunOrTaskStatus` (agents worker `index.ts`, shared by the plain GET-run route
     AND the SSE `/stream` endpoint) surfaces it; `apps/shell`'s `AgentRun`/`pollRun`/the SSE
     `onmessage` handler all carry it through. A real, separate bug fixed in passing:
     `apiFetch`'s generic error-message resolution read `body.message ?? body.error_code` — since
     these 402s send `{error, error_code}` with no `message` field, ANY caller hitting one of them
     via the synchronous dispatch path would have displayed the literal string
     `"insufficient_credits"` as the error text instead of the real sentence; now checks
     `body.error` first.
     - **New `UpgradeDialog` component** (`apps/shell/src/components/UpgradeDialog.tsx`), shown
       instead of the plain red banner for exactly the codes above. Honest about what's actually
       self-serve today: `insufficient_credits` (own balance) and `subscription_inactive` get real
       credit-pack/subscription purchase buttons via the ALREADY-BUILT `getPricing`/
       `checkoutCreditPack`/`checkoutBusi
- Required Fix Add source IP allowlisting as a defense-in-depth layer for webhook ingress: (1) Maintain an IP allowlist for each webhook source in KV (refreshed daily from official published lists: Stripe publishes its webhook IPs, GitHub publishes its hook IPs via the meta API). (2) The webhook handler checks CF-Connecting-IP against the allowlist BEFORE computing the HMAC (fail fast, reduce attack surface). (3) For sources without published IP ranges (custom MCP webhooks), require HMAC-SHA256 validation with a 300-second timestamp skew tolerance. (4) Log all webhook deliveries with source IP for anomaly detection.
- **Fixed:**
- `workers_dev = false` added to every `workers/*/wrangler.toml` except the workers that need
  genuine public ingress with their OWN independent verification: `naelao-router` and
  `naelao-portal-router` (the public API/portal surface itself), `naelao-agents` (the
  signature-verified multi-channel gateway, `adapter.verifySignature`), `naelao-billing`
  (Stripe/Lemon Squeezy webhook signature checks), and `naelao-ws-gateway` (WebSocket upgrades
  do their own origin + tenant check, can't be relayed through a service-binding fetch).
- `proxyTo` now unconditionally `headers.delete()`s all five identity/internal headers before
  the `if (claims)` block sets them from verified JWT claims — no code path can forward a
  client-supplied identity header through the router anymore.
- New `packages/http` primitives: `mintInternalToken(secret, tenantId)` (mints the same
  `t=<ts>,v1=<hmac>` token `proxyTo` always minted, for any worker-to-worker caller that talks
  to another worker's service binding DIRECTLY, bypassing the router) and
  `requireInternalHmac(getSecret)` (a Hono middleware verifying that token against the
  request's own `x-naelao-tenant-id`, using the pre-existing but previously-unused
  `verifyInternalToken`).
- **`workers/credentials`**: the three public CRUD routes (`POST/GET/DELETE
  /spaces/:spaceId/credentials[...]`) are now gated by `requireInternalHmac`. The internal
  plaintext-resolution route (`/v1/internal/.../plaintext`) is untouched — it already has its
  own independent, narrower-scoped HMAC (`generateCredentialToken`/`verifyCredentialToken`,
  bound to one `agentId`+`spaceId`). Fixed the one non-router caller (agents worker's
  connector-connect flow) to mint the token — and, in the same edit, a **pre-existing path
  bug**: it was calling `/v1/spaces/...` against a worker whose public routes are registered
  WITHOUT the `/v1` prefix, which would have 404'd on every real connector connect.
- **`/internal/triggers/fire`** (agents worker): replaced the static-string check with
  `verifyInternalToken` + an explicit `body.tenantId === header tenantId` cross-check (a valid
  token for tenant A must not be usable to fire a script against tenant B's space, even though
  the token itself verifies). `SpaceDO.fireMatchingTriggers` — the only caller — now mints the
  token via `mintInternalToken(this.env.PLATFORM_SECRET, tenantId)`.

### 93. Edge Tombstone Filter (410 Gone / 204 Drop)

**Final behavior:** KV registry returning `410 Gone` on deleted webhooks and `204 No Content` on paused webhooks, absorbing zombie webhook floods for $0 compute.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- The Gap A single logical entity (a knowledge document) spans three stores: a SQLite metadata row, R2 object(s) for content, and Vectorize vectors for embeddings. There is no foreign-key relationship across stores and no reconciliation job. Over time, partial failures cause drift: SQLite rows pointing to deleted R2 objects, R2 objects with no SQLite row (orphans consuming storage/cost), Vectorize vectors for documents that no longer exist (returning ghost results), and documents missing their vectors (silently absent from RAG). At scale this drift is continuous and invisible.
- The ENTIRE A1.29 Wallet Connect subsystem: `StripeProvider` (`packages/billing-core/src/
providers/stripe.ts`, deleted), migration 0063's application code (the migration file itself is
left in place, unused — D1 has no cheap drop-and-forget story and nothing writes to it anymore),
`workers/billing/src/{wallet-connections,wallet-checkout,wallet-webhooks}.ts` (deleted),
`/webhooks/stripe` + `/webhooks/lemon-squeezy/wallet/:connectionId`, the dashboard
`PaymentsAccountCard`'s Stripe/LS connect flow, the shell business-detail Payments Account card,
and every `BillingProvider`/`BillingProviderEnv` "stripe" type-union member (now `"lemon_squeezy"`
only — item 45's platform-billing-is-LS-only decision was always the real constraint; Stripe's
only remaining job was the removed per-space rail).

### 94. Cloudflare Queues Concurrency Buffering

**Final behavior:** Buffers incoming webhook bursts (e.g. 10,000 Shopify Black Friday orders) into Cloudflare Queues, pacing worker execution safely.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- ## Stack
- CF Workers (router, auth, spaces, agents, knowledge, billing, etc.)
- CF Durable Objects + DO SQLite (`SpaceDO` = structure/agent_definitions, `NaelaoAgentDO` = agent runtime, sessions, memory)
- CF R2 (KB documents, exports, backups, artifacts)
- CF Vectorize (KB semantic search — shared multi-tenant index with spaceId filter)
- CF KV (circuit breakers, config cache, session revocation, portal routes)
- CF Queues + DLQ (async events, webhook delivery, analytics, notifications)
- CF Workflows (provisioning, erasure, ingestion, billing, dunning)
- CF Analytics Engine (events, metrics — append-only, 25M rows/day limit)
- D1 (platform metadata, billing, users — single instance today; sharding a named future milestone)
- LLM: Cloudflare AI Gateway is the LLM path — the gateway HOLDS the Anthropic provider key
  (Authenticated Gateway / BYOK via `NAELAO_AIG_TOKEN`), so no `ANTHROPIC_API_KEY` lives on any
  worker (item 45). Claude is primary with a gateway-driven fallback chain.
- PLATFORM billing (Stripe removed — item 45): Naelao's own normal Whop seller account is tried
  FIRST for builder platform plans (item 58), Lemon Squeezy is the fallback. End-user
  subscriptions/credit-packs try the business's own connected Whop company (OAuth-delegated,
  item 58) first, then LS, then a dev placeholder.
- Whop is the business-bank-account rail (item 50, replacing item 49's Stripe/LS Wallet Connect):
  every business auto-provisions an isolated Whop sub-merchant wallet at creation — no builder
  action. This is BUSINESS revenue custody, a different thing from Naelao's own platform billing
  above.
- Next.js on CF Pages (builder dashboard)
- The Gap
 None of the wrangler.jsonc queue consumer definitions set `max_concurrency`. When a burst of messages arrives (e.g., 500 run-complete notifications from a parallel workflow), CF Queues spawns up to 250 concurrent Worker invocations by default. Each invocation makes calls to APNs, FCM, Slack webhooks, and Analytics Engine. APNs rate-limits at 300 requests/second per certificate. FCM limits at 500/second. The burst from unbounded queue consumers hits these limits immediately, triggering 429 errors, causing messages to be retried, causing more burst, in a cascading failure loop.
- - **Money-in is reserved.** `RESERVED_CAPABILITIES` (checkout, charge, payout, wallet, …) may
  only be provided by Naelao's **prebuilt `commerce` script**, which holds the Lemon Squeezy
  store credentials (Workers Secret) and bakes in the platform fee (`naelaoFeeBps`).
  `ScriptToolSurface.create/update` **fail closed**: a user/agent script that references an
  external payment host (Stripe/PayPal/… *and* `api.lemonsqueezy.com`), embeds a payment SDK,
  or declares a reserved capability/domain is rejected. Builders keep full freedom to author
  delivery, marketing, storefront-UI, and email scripts — just not the wallet. 9 unit tests.
- **Business services are Naelao-provided multitenant prebuilts** (so the assistant never has
  to shop third-party tools): `commerce`, `storefront`, `business-email`. All manifest-gated
  via `productConfig.commerce` / `productConfig.businessServices`; the provisioner merges them
  into installed agents (`businessServicePrebuilts`). A builder may still author their own
  scripts for anything except the income wallet, and may opt into a custom domain.
- **Storefront = one multitenant surface, not a Worker-per-tenant** (corrects the early
  "dynamic-worker" wording). Confirmed against Cloudflare for SaaS docs: a CF **Pages** static
  shell fronted by the portal **Worker as fallback origin**, routing by `Host` header.
  `storefront.provision` allocates `{slug}-{id}.naelao.com` (covered by the zone wildcard cert
  — no per-tenant cert) and registers a `portal-host:{host}→spaceId` KV route; custom domains
  use the CF for SaaS `custom_hostnames` API (DV cert, customer CNAMEs to the fallback origin).
- **Commerce data model** (`0035_commerce.sql`) is a generic, manifest-gated primitive:
  `launchpad_products`, `launchpad_orders` (idempotent on `provider_event_id`),
  `business_services`. Owner CRUD + revenue rollup in the spaces worker (gated on
  `commerce.enabled`); the LS webhook writes the order + platform fee and wakes the fulfilment
  agent with the `order_id`. Dashboard: `/dashboard/spaces/{id}/commerce` (products, orders,
  revenue).
- **Lemon Squeezy is the processor for all three payer classes** (all wired): customers
  buying products (checkout→order→fulfilment), Naelao builders' plans, and a builder's
  space-members/seats. Seat billing = `productConfig.memberBilling { enabled, seatPriceCents,
  lsVariantId, interval }`; the billing worker's `/internal/seats/checkout` runs the seat
  charge through Naelao's store (res

### 95. Time-Travel Webhook Event Replay Lake in R2

**Final behavior:** Archives raw webhook payloads to Cloudflare R2 with 14-day retention rules, enabling 1-click replaying of historical events against patched code.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 98. **The assistant had never once been told who it was, `/new` silently dropped the user's first
    message, and a completed run 404'd on its own status poll. All three reported by the user, all
    three root-caused against live behaviour rather than guessed at.**
    - **The agent's own system prompt reached the model in no run, ever.** `loadAgentConfig` read
      `system-prompt.md` from R2 on every call and used it only to parse approval gates;
      `GatewayReasoner` hardcoded `system: DECISION_INSTRUCTIONS`. Every word of
      `LAUNCHPAD_ASSISTANT_PROFILE` — the business-building methodology, the wallet rules, "read the
      project journal first" — written, stored, never delivered. Asked what business it ran, the
      assistant said "that information is not provided in the given context", which was true.
      New `ReasonerDeps.agentPrompt` + `composeSystemPrompt` (identity, protocol, then a one-line
      identity anchor — recency wins on small models), wired at both reasoner sites.
      **That alone was not enough, and the reason is worth keeping.** A direct gateway call proved
      llama-3.3 follows a plain system prompt correctly, yet the SAME identity inside the real
      request still produced "I am an AI assistant, and I am not running a business for you" — the
      real request also carries a 4.3k-char protocol and five tool schemas, and `tool_choice:
      "required"` pulls attention onto the machinery. Fixed by ALSO carrying a bounded
      `who_you_are` digest in the payload the model is answering about. Verified live: it now
      answers "I am the Naelao Agent, a business-builder Space Assistant for your Launchpad
      Space…". Diagnostic worth reusing: when a prompt "should" work, test the model in isolation
      first — it separates delivery from attention in one call.
    - **`/new` created a session and nothing happened.** Home passes the opening line as `?q=`; the
      session page stripped `q` from the URL on mount, Next syncs that `replaceState` back into
      `useSearchParams`, and Chat cannot send until its history has loaded a beat later — so the
      message was retracted before the surface was ready for it. Reproduced exactly in a real
      browser: `POST /sessions` 201, then **no `POST /agent/run` at all**, 0 messages. Fixed by
      latching `q` on first render (`useState` initialiser) plus a second latch inside Chat, so
      whoever hands the message over, the first non-empty value wins and cannot be withd
- The Gap: Builders want to automate actions within their Space based on events (e.g., "when end-user hasn't returned in 7 days, send a re-engagement email"; "when Space error rate exceeds 5%, send Slack alert"). No event-driven automation framework exists within Spaces. Builders must build this externally via webhooks (G-AR41) and their own infrastructure.
 Required Fix: Add Space Automation rules to SpaceConfig: automations: [{trigger: {event: "end_user_inactive", condition: {idle_days: 7}}, action: {type: "send_email", template_id: "...", to: "{{end_user.email}}"}}] . Trigger types: end_user_inactive, error_rate_exceeded, budget_threshold, new_end_user, conversation_completed . Action types: send_email, send_webhook, send_slack, create_kb_doc, tag_user . Automations evaluated by naelao-sweeper Workflow. Builder creates automations in a visual no-code rule builder in dashboard. Each automation logged to Analytics Engine.
- `GET .../agent/runs/:runId/stream` used named SSE events (`event: status`, `event: done`) with
payloads carrying no `type` field. A browser's native `EventSource.onmessage` only fires for
UNNAMED (default `message`) events — so it never fired for this endpoint's output at all. Read all
three known chat clients (`apps/shell/Chat.tsx`, `apps/widget/naelao-chat.ts`,
`apps/portal/.../page.tsx`) and confirmed they independently already expect an unnamed event
carrying `{type: "delta"|"done"|"error", ...}` — a systemic, shared assumption, not a typo in one
file. The only way any client ever progressed was `onerror` firing once the stream closed
(interpreted as a dropped connection), falling back to plain polling. **Fixed the server to match
what every client already expects** (one `sendEvent()` helper now emits `data: {...}\n\n` with no
`event:` line, `type` always present) rather than touching three separate client files — lower
blast radius, one source of truth. The poll loop (which re-reads `fetchRunOrTaskStatus` every
second, unchanged) now also diffs the run's `final_answer` against what it last sent and emits the
new substring as a real `type:"delta"` event — honest about its own limitation: since nothing
today writes `final_answer` incrementally mid-generation, this fires once with the whole answer in
practice, not truly token-by-token (see the deferred item below).

### 96. Leaky-Bucket Outbound Rate-Limiter Pacer

**Final behavior:** Paces outbound API requests through `ConcurrencyDO` (e.g. max 5 req/sec to HubSpot or Instagram), preventing external provider HTTP 429 bans.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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

- // Temple: DevPilot — configuration
const TEMPLE_DEVPILOT: Temple = {
 id: 'temple-devpilot-v1',
 name: 'DevPilot',
 tagline: 'AI coding assistant — your stack, your control',
 category: 'developer-tools',
 spaceType: 'developer',
 suggestedPricing: { type: 'seats', pricePerSeat: 2000, trialDays: 14 }, // $20/seat/month
 defaultAuthProvider: 'custom-oidc',
 productConfig: {
 allowPublicSignup: false,
 featureFlags: {
 'inline-autocomplete': true,
 'multi-file-context': true,
 'test-generation': true,
 'code-review-agent': true,
 'background-refactor': false, // Off by default — costs more credits, enable per team
 'terminal-access': false, // Disabled by default for security — builder can enable
 },
 userPermissions: {
 canCreateProjects: true, // Projects = repositories or feature branches
 canCreateSubSpaces: true, // Teams / squads = sub-spaces
 canInstallAgents: false,
 maxCreditsPerMonth: null,
 },
 subSpaceTerminology: 'teams',
 allowUserSubSpaces: true,
 maxSubSpaceDepth: 1,
 },
 agentBundle: [
 { agentId: 'code-assist-v1', required: true, configOverrides: { model: 'claude-sonnet-4-20250514' } },
 { agentId: 'test-writer-v1', required: false, configOverrides: {} },
 { agentId: 'code-reviewer-v1', required: false, configOverrides: { requiresApprovalFor: [] } }, // Review is informational, no approval gate
 ],
 knowledgeSchema: [
 { documentType: 'codebase_context', required: false, description: 'Upload a repo map or architecture doc so agents understand your project structure', exampleUrl: 'https://docs.naelao.app/templates/devpilot-repo-context' },
 { documentType: 'coding_standards', required: false, description: 'Coding standards, linting rules, commit message conventions', exampleUrl: null },
 { documentType: 'stack_reference', required: false, description: 'Framework docs, internal library references, API contracts', exampleUrl: null },
 ],
 estimatedSetupMinutes: 10,
 featured: true,
};
- - **Money-in is reserved.** `RESERVED_CAPABILITIES` (checkout, charge, payout, wallet, …) may
  only be provided by Naelao's **prebuilt `commerce` script**, which holds the Lemon Squeezy
  store credentials (Workers Secret) and bakes in the platform fee (`naelaoFeeBps`).
  `ScriptToolSurface.create/update` **fail closed**: a user/agent script that references an
  external payment host (Stripe/PayPal/… *and* `api.lemonsqueezy.com`), embeds a payment SDK,
  or declares a reserved capability/domain is rejected. Builders keep full freedom to author
  delivery, marketing, storefront-UI, and email scripts — just not the wallet. 9 unit tests.
- **Business services are Naelao-provided multitenant prebuilts** (so the assistant never has
  to shop third-party tools): `commerce`, `storefront`, `business-email`. All manifest-gated
  via `productConfig.commerce` / `productConfig.businessServices`; the provisioner merges them
  into installed agents (`businessServicePrebuilts`). A builder may still author their own
  scripts for anything except the income wallet, and may opt into a custom domain.
- **Storefront = one multitenant surface, not a Worker-per-tenant** (corrects the early
  "dynamic-worker" wording). Confirmed against Cloudflare for SaaS docs: a CF **Pages** static
  shell fronted by the portal **Worker as fallback origin**, routing by `Host` header.
  `storefront.provision` allocates `{slug}-{id}.naelao.com` (covered by the zone wildcard cert
  — no per-tenant cert) and registers a `portal-host:{host}→spaceId` KV route; custom domains
  use the CF for SaaS `custom_hostnames` API (DV cert, customer CNAMEs to the fallback origin).
- **Commerce data model** (`0035_commerce.sql`) is a generic, manifest-gated primitive:
  `launchpad_products`, `launchpad_orders` (idempotent on `provider_event_id`),
  `business_services`. Owner CRUD + revenue rollup in the spaces worker (gated on
  `commerce.enabled`); the LS webhook writes the order + platform fee and wakes the fulfilment
  agent with the `order_id`. Dashboard: `/dashboard/spaces/{id}/commerce` (products, orders,
  revenue).
- **Lemon Squeezy is the processor for all three payer classes** (all wired): customers
  buying products (checkout→order→fulfilment), Naelao builders' plans, and a builder's
  space-members/seats. Seat billing = `productConfig.memberBilling { enabled, seatPriceCents,
  lsVariantId, interval }`; the billing worker's `/internal/seats/checkout` runs the seat
  charge through Naelao's store (res

### 97. Payload Hash Idempotency Deduplication

**Final behavior:** Hashes provider event IDs and resource IDs in SQLite. Duplicate events received within 24 hours are acknowledged and discarded.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 74. **The four items item 73 left open are now BUILT — plus a real bug found while closing them:
    the script-native path never persisted the assistant's answer.** The client writes the USER
    message before dispatching, but nothing wrote the reply, so a reload showed questions with no
    answers, the agent's own conversation memory (item 71 — which reads that same SpaceDO
    transcript) only ever saw the user's half, and a resumed run had nowhere to put its result.
    `handleScriptRun` now writes the answer back via a new `writeAgentAnswerToSession` —
    deliberately NOT the legacy `writeConversationToSession` goal+answer pair, which would
    duplicate every question — attributed with `agent_id` so a bubble can say which agent spoke.
    - **Granularity / exactly-once (the Palantir Orchestrator gap item 73 named) is CLOSED at
      action level.** New `ActionLedger` (`script-engine/types.ts`, optional on `ScriptEngineEnv`
      like `hitlGateway`): an action is recorded when it runs, and the same action with the same
      arguments under the same key returns the recorded result instead of executing. Implemented
      in `NaelaoAgentDO`'s own SQLite (`action_ledger`, PK `(ledger_key, action_name,
      params_hash)`, `INSERT OR IGNORE` so the FIRST execution is the truth a later attempt can't
      overwrite). The key is what ties an original run to its own resumes: `handleResumeRun` mints
      a fresh `runId` (so the trace stays separately readable) but passes the ORIGINAL run's id as
      `ledgerKey` — without that, every already-executed action would look brand new to the ledger
      on a resume. A genuinely different run is never short-circuited. Only SUCCESSES are recorded
      (a failure must stay retryable). All FOUR execution sites go through it, including the two
      inside `applyTerminalDecision` (distill/patch author a script and then run it — that run has
      real side effects too), which needed the runner threaded in as a parameter. Degrades to the
      prior behaviour (model judgment + the within-run repeat guard) when unwired OR when the
      ledger throws — never to a blocked run. 6 new tests.
    - **The approvals inbox — durable approvals were unreachable from the product.** There was NO
      way for an end user to answer a request anywhere in the UI, so every parked action sat until
      it expired: the feature was real end to end except the one step that needs a person. New
      `apps/shell` `/approvals` page list
- Required Fix
 Required Fix Add an idempotency key to webhooks: store a hash of (spaceId, provider, event_type, event_id) and reject duplicate webhooks within a 24-hour window. Use a unique constraint on space_triggers to prevent duplicate registrations: no two triggers with the same (space_id, provider, event_type, target_type, target_id). Make workflow execution idempotent: if the same workflow is triggered twice with the same input, the second one is a no-op. Severity: Medium — Concurrent triggers cause duplicate workflow dispatches. No idempotency key or deduplication. Workflows execute multiple times for single webhooks. T-173 — naelao-notifications
- **Explicit signals — no new ingestion.** `agent_activity_log` (item 40) already carries
`event_type`/`tokens_used`/`cost_credits`/`created_at` for every run completion/failure and
approval request — exactly what error rate and avg/total cost need. New `GET /spaces/:spaceId/
agent-signals?project_id=&window_hours=` (SpaceDO's `computeAgentSignals`, builder-only, same
gate as `agent-activity`) rolls it up on read: `runs_total/completed/failed`, `error_rate`,
`avg_cost_credits`, `total_cost_credits`, `approvals_requested`. "Regenerations" (a proxy for the
user hitting retry) is computed in application code — 2+ run events on the SAME thread within 5
minutes — rather than a SQL window function, since the row counts here are always small and DO
SQLite window-function support isn't otherwise relied on anywhere in this codebase.

### 98. Ouroboros Loop Circuit Breaker

**Final behavior:** Injects `x-avos-hop-count` headers into automation payloads. If hops exceed 2 within an hour, execution halts, breaking recursive loops.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 137. **Follow-up to the stop-hook's exact objection: Groq's own 429 says precisely how long to
     wait, and the reasoner threw that away instead of waiting — closing the last blocker item 136
     left open.** Four spaced live attempts in item 136 all died on provider capacity; the honest
     conclusion was "capacity, not capability," but the hook was right that "check other models"
     was not a real test of anything. The actual fix is structural: Groq's rate-limit body reads
     *"Please try again in 27.715s"* and the reasoner discarded it, failing the whole run on the
     first transient hit — on a free tier whose 12k-tokens-per-minute ceiling sits below this
     agent's own ~9-11k-token payload, that made a multi-step autonomous run nearly impossible by
     construction, independent of model choice.
     - New `retryDelayMs(status, headers, body, attempt)` (`reasoner.ts`), narrow by design: only
       429/503, only a bounded wait. Prefers a real `Retry-After` header, falls back to parsing
       the provider's own stated seconds from the body (`"try again in 27.715s"`), and falls back
       further to a short exponential backoff (2s/4s/8s) when neither is present. A DAILY
       allowance (Gemini's free-tier daily cap, Workers AI's neuron allocation) does NOT come back
       inside a run, so those phrases are explicitly excluded from the wait — waiting for them
       would just burn the run's wall clock for nothing, unless the provider ALSO sent a real
       `Retry-After` (which wins regardless, since it's the provider speaking precisely). Capped
       at 35s total — a person may be waiting on this run, so a long wait fails honestly instead
       of stalling. `GatewayReasoner.decide()`'s gateway-error branch now loops up to
       `MAX_TRANSIENT_RETRIES` (2) before giving up, using the retry loop's own real fetch — not a
       new mechanism, the exact same call site.
     - **Live-verified against the exact goal that failed four times in item 136** (Groq,
       `llama-3.3-70b-versatile`, the "find Lead Tracking, open its thread, post a follow-up"
       goal): the run's trace shows a `reason` step at **28,020ms** — a normal reasoning call is a
       few hundred ms (the same trace's next `reason` step: 198ms) — direct evidence the retry
       waited out a real 429 and got a real decision back. The run then hit a SECOND 429 whose
       stated wait (41.7s) exceeded the 35s cap and gave up honestly rather than stalling further —

- Required Fix Implement poison message detection: after 3 consecutive failures of the same message type within 60 seconds, flag the message as a potential poison message. Store it in R2 for analysis. Send an alert. Use a `messageId` hash to identify the same message across retries. Add a per-consumer circuit breaker that stops processing if failure rate exceeds 50% for 5 minutes.
- **Tests:** `tests/unit/project-config-fail-closed.test.ts` (new, 6) — `handleScriptRun`: a
thrown network error and a `500` response from the project-config endpoint both reject the run
`429 spend_capped`; a clean `404` falls through past the gate exactly as before (never rejected
as `spend_capped`). `handleChannelHeartbeat`: a network error marks pending messages
`spend_capped` (not silently answered or dropped); a clean `404` leaves `spend_capped` at `0`;
and a matched no-code `run_script` rule under a project-config error is short-circuited to
`spend_capped` BEFORE the rule's script ever runs (`rule_handled: 0`), proving the fix covers
that execution path independently of the main reasoning-loop gate. Re-ran the pre-existing
`tests/unit/handlescriptrun-spend-cap.test.ts` (4) and
`tests/unit/naelaoagentdo-customer-bot-heartbeat.test.ts` (4) suites — both still pass unchanged,
confirming the clean-404/normal-config paths those suites cover were not affected.

### 99. Lenient Zod Adapters with Self-Healing Schema Repair

**Final behavior:** Wraps responses in lenient Zod schemas. If parsing fails due to third-party API changes, cheap edge models repair the field mapping dynamically.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- The Gap: When Stripe or an LLM provider updates their API (new required fields, changed response schemas), the platform's Worker code breaks silently. No contract tests exist to catch provider API changes before they reach production.
 Required Fix: Implement consumer-driven contract tests (Pact.js): Workers define expected request/response contracts for each external API call (Stripe PaymentIntent create, OpenAI chat completion, CF AI inference). Contract stubs run in CI instead of live APIs. On provider API change: contract test fails, alerting to necessary code update. Publish contracts to Pact Broker (self-hosted on CF Workers). Run contract verification weekly against provider sandbox environments.
- - `workers/spaces/src/do/SpaceTypeRegistryDO.ts` — `SpaceTypeProductConfig` gains
  `modelConfig?: { model?: string }`, with an explicit comment distinguishing this from the dead
  `spacetypes.model_config` D1 column so a future session doesn't conflate the two or try to
  "restore" the column.
- `workers/spaces/src/builder-routes.ts` — new `ALLOWED_MODELS` curated allowlist
  (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-8`) — deliberately not
  arbitrary free text, for cost predictability and to keep the platform's own AI-Gateway routing
  table meaningful. The generic `PATCH /builder/products/:id` handler already shallow-merges any
  `product_config` object into `config.productConfig` — the only change needed is a validation
  branch: if `body.product_config?.modelConfig?.model` is present and not on the allowlist, `400
  bad_request`. No new route.
- `workers/spaces/src/index.ts` — `GET /spaces/:spaceId/shell/manifest` projects
  `model: pc?.modelConfig?.model ?? null` (`pc` is the already-loaded effective product config)
  so the end-user shell can read the configured model without a second round trip.
- `workers/agents/src/index.ts` — the actual bug fix. Removed the dead `model_config: string`
  field from the `SpaceTypeRow` interface entirely (nothing ever populated it). The dispatch
  path now parses `spaceRow.config_json` — a column that already exists and is already fetched
  by the same `SELECT * FROM spaces WHERE id = ? AND tenant_id = ?` query every run already
  issues, so this costs zero new queries — for `productConfig.modelConfig.model`, falling back
  to the pre-existing hardcoded model string (`claude-sonnet-4-6`) whenever the override is
  absent OR `config_json` fails to parse (malformed JSON degrades to the same safe fallback,
  never a 500).
- `apps/dashboard` — `BuilderProductConfig` (`src/lib/api.ts`) gains the matching
  `modelConfig?: {model?: string}` field; the Configuration tab
  (`dashboard/products/[productId]/configuration/page.tsx`) gains a new "Model" card — a
  3-button picker (Haiku/Sonnet/Opus), styled identically to the existing Product Mode
  button-group, writing through the SAME generic PATCH handler above with no new endpoint.

### 100. Project-Universal, Bot-Attributed Scheduled Crons

**Final behavior:** Registered in `SpaceDO.project_scheduled_jobs`. Executes in clean Workflow contexts without inheriting bloated chat histories.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- The Gap Workers that need CF Cron Triggers (analytics aggregation, quota reset, key expiry cleanup) must declare `[triggers] crons` in wrangler.toml. Without this, the `scheduled` handler is dead code in production — it only runs during local `wrangler dev`.`
- **Tests:** `tests/unit/workflow-tier-routing.test.ts` (5 — dispatches to `workflowRunner.start`
instead of `codeRunner` and returns immediately without blocking; per-tenant isolation, i.e. two
different spaces' runs pass their own space/tenant, never a shared/fixed one; honest `ok:false`
degrade with no runner wired; a runner rejection surfaces as `ok:false` rather than throwing; an
ordinary `runtime:"isolate"` script is unaffected and still reaches `codeRunner`).
`tests/unit/internal-scripts-run-durable.test.ts` (5 — the new route's HMAC auth boundary: rejects
no token, wrong secret, tenant-header/body mismatch, missing `scriptName`; accepts a valid token
and forwards to the space's agent DO). 1013/1013 tests pass (10 new). `pnpm turbo run typecheck`
clean (75 tasks).
- # 3. Does This Architecture Confuse Non-Technical Users?
**No, because non-technical users never see the underlying engineering.**
Think of an iPhone: under the hood, it runs a 64-bit multi-core ARM CPU, a Mach kernel, virtual memory paging, and Unix file permissions. But the user only sees an **intuitive touchscreen with clean icons.**
The platform applies the **"Iceberg Principle"**:
```
WHAT THE NON-TECHNICAL FOUNDER SEES (The 10% Surface — Simple & Beautiful)
─────────────────────────────────────────────────────────────────────────────────────
• A simple, friendly chat box (like texting a colleague on iMessage).
• Clean buttons: [ Approve Design ], [ Book Appointment ], [ Launch Website ].
• A live visual preview of their website or a calendar of their bookings.
• A morning WhatsApp summary: "You made $450 in sales yesterday; 2 calls booked."
═════════════════════════════════════════════════════════════════════════════════════
WHAT RUNS SILENTLY UNDER THE HOOD (The 90% Submerged — Complete Engineering)
─────────────────────────────────────────────────────────────────────────────────────
• Cloudflare Artifacts Git repositories with SHA-256 commit trees.
• V8 Isolates, Dynamic Worker Loaders, and FUSE-mounted Linux Container Sandboxes.
• AST search-and-replace patching and optimistic concurrency control (OCC).
• Vectorize ACL-partitioned semantic embeddings and prompt cache breakpoints.
```
- ### Real-World Example: A Non-Technical Dentist vs. The Engine
Look at how a non-technical dental clinic owner experiences the platform compared to what the engine is doing in the background:
| What the Non-Technical Dentist Does | What the Platform Executes Invisibly Under the Hood |
| :--- | :--- |
| **1. Dentist clicks:** *"Launch 24/7 Receptionist Template"*. | • `GenesisEngine` provisions `SpaceDO`, creates D1 tables, registers WhatsApp webhooks, and seeds clinic FAQs into Vectorize in 3 seconds. |
| **2. Dentist types:** *"Update our Friday hours to close at 2 PM instead of 5 PM."* | • Agent receives prompt, executes `patch_file` on `PROJECT.md` and calendar rules in Tier 1 SQLite FS, and creates commit `c_4f12`. |
| **3. Dentist sees an alert in chat:** *"Your assistant updated the booking rules. Click here to review."* | • A visual Pull Request card renders. The dentist sees a simple green highlighted box (*"Friday: 9 AM - 2 PM"*). |
| **4. Dentist clicks:** `[ Approve ]`. | • Cloudflare Artifacts fast-forwards the Git branch, `WsHubDO` broadcasts the merge over WebSockets, and the WhatsApp bot immediately uses the new hours. |
- ### Summary
1. **Finite Projects Sleep Automatically:** Projects built for a single task (like building a website or auditing a contract) **shut down their alarms and sleep at $0 cost** the second the journal hits 100%.
2. **Context-Aware Connector Selection:** The agent defaults to **Personal accounts in private 1-on-1s** and **Shared company accounts in public team channels**, with a clear visual pill in the chat bar.
3. **Enterprise Power with Consumer Simplicity:** Non-technical users get a clean, human-friendly experience with simple buttons and previews, while all Git versioning, container promotions, and database isolations run invisibly at the edge.

### 101. Compact Background Job Receipt Cards

**Final behavior:** Background jobs post a 2-line expandable notification card into the timeline; heavy terminal logs are offloaded to R2.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- The Gap: Builders building on Naelao have no visibility into planned features, timelines, or priorities. They cannot plan their product roadmaps around platform capabilities. No public roadmap exists. This creates anxiety for builders making long-term platform bets.
 Required Fix: Publish public roadmap at naelao.com/roadmap : board view with columns: "Now" (in development), "Next" (committed), "Later" (planned), "Considering" (not committed). Each card: feature name, description, category (Security, DX, AI, Marketplace, etc.), target quarter. Integration with feature request system (G-AS38): most-voted requests appear with vote counts. Builder dashboard: roadmap widget showing upcoming features relevant to their plan tier. Email digest: monthly "What's coming" email to Pro+ builders. Status updates: Jira-like status changes trigger notification to subscribed builders.
- **Provisioner wiring:** `workers/provisioner/src/index.ts`'s `installLaunchpadAgents` (step 9)
now calls a new `installAgentTrigger` per installed agent: `schedule` → POST
`/spaces/:id/scheduled-jobs` with `agent_id` + a `goal` derived from the agent's own
`description` (`"Run your scheduled work per your role: ...; use script.find ...; distill a new
one when you succeed"`); `webhook`/`manual` → no-op (see decision 2 above). Best-effort — a
failed install logs and does not fail provisioning, same posture as the other non-critical
install steps (`spacedo_init_hook`, `workflow_templates`). `rollbackSpace` now also deletes any
`scheduled_jobs` rows for the space (PLATFORM_DB, not under the R2-prefix wipe the block above
already does) so a retried `provisionSpace` after a failure doesn't accumulate duplicate cron
rows for the same agent.

### 102. Pluggable Space-Shared Calendar Connector (`primary_calendar`)

**Final behavior:** Replaces rigid SQLite calendar silos with a standardized MCP connector alias (`primary_calendar`) binding to Google Workspace, Microsoft 365, or CalDAV.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- Required Fix: Extend ConnectorDefinition with provider: 'direct' | 'composio' | 'pipedream' and key_source: 'platform' | 'byo' . Curate an initial platform-keyed inventory chosen for the general autonomous Space Assistant and the free-tier business program: Google Maps/Places (prospect research), Gmail, Google Calendar, Google Sheets, Notion, Slack, LinkedIn, X, YouTube, GitHub. Catalogue stays exclusively Naelao-authored (same rule as SpaceTypes). mcp.register for a platform-keyed entry requires no credential_name — only the G-BF03 consent flow where the app needs a user account. The Space Assistant profile's system prompt names the inventory and the connect flow so the assistant can propose "connect your calendar and I'll handle scheduling" unprompted. Money-in tool names remain reserved to the commerce prebuilt regardless of provider.
- Tests: `tests/unit/whop-oauth-connect.test.ts` (12 tests) — authorize-URL construction (client
id, PKCE challenge method, redirect_uri, state), honest `oauth_not_configured` degradation when
the OAuth app isn't set up, a missing/unknown state ticket rejected with a clear message, the
full happy path (code exchange → vaulted tokens never appearing in the redirect → MCP server
upserted with the right `auth_type`/`auth_secret_name`), single-use ticket replay rejection, an
`error=` query param from Whop redirecting cleanly instead of 500ing, the refresh endpoint's HMAC
gate and token-rotation persistence, and mcp-hub's `resolveOAuthAccessToken` exercised directly
(fresh token passthrough, proactive refresh + verified HMAC token to the agents worker, graceful
fallback to the stale token on a failed refresh call or a missing `AGENTS_WORKER` binding).
1835/1835 suite green, `pnpm turbo run typecheck` clean (75 tasks), shell verified via
`next build`. **Not verified against a live Whop OAuth app** (exact endpoint paths/scopes/response
shapes are per Whop's published guide, not exercised against a real registered app — confirm once
`WHOP_OAUTH_CLIENT_ID`/`WHOP_OAUTH_CLIENT_SECRET` are actually issued). **Not done:** an
equivalent OAuth button on the dashboard's own `/dashboard/spaces/[spaceId]/connectors` console
(still manual-key-only — this pass targeted the shell's per-business flow specifically).
- ### Summary of What This Adds:
1. **Space-Wide Shared Calendar & State:** Hosted in `SpaceDO` SQLite; ensures that appointments, leads, and customer states are shared seamlessly across all project workstations without data silos.
2. **`kind: "voice_agent"`:** Deploys 24/7 AI phone receptionists using Cloudflare Calls (WebRTC) and Workers AI with zero external server infrastructure.
3. **Built-in Voice Dictation:** Adds native WhisperFlow-style voice-to-text directly inside the chat composer dock powered by Cloudflare's free edge Whisper model.
B7t since we have space wide mcp connector there is no need that means every project has access to the same mcp calendar. But we have to let agents know difference between space shared connector vs space wide user connect vs project specific
Establishing a clear **3-Tier Connector Scope Model** prevents cross-user account bleed and ensures the agent never books a public customer onto a founder’s personal calendar by accident.
By annotating tool definitions with explicit **Scope Provenance**, the agent immediately understands whether a tool acts on behalf of the **Whole Company**, a **Specific Human Member**, or a **Single Project Container**.
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

### 103. 15-Second Edge Slot-Hold Mutex (`ConcurrencyDO`)

**Final behavior:** Ephemeral edge lock reserved during voice calls before external API execution, preventing double-booking during third-party API latency windows.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

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
- Required Fix Add a cost/resource preview: (1) Before executing, estimate the plan's cost from per-node heuristics (expected LLM calls × avg tokens × model price + expected tool/API costs + sub-agent fan-out). (2) Check the estimate against the space's remaining budget; if it would exceed, require explicit confirmation or block. (3) Present the estimate (credits, est. duration, sub-agent count, external calls) for approval on high-cost plans (over a threshold). (4) Enforce a hard budget cap during execution (auto-pause at the cap, G-AE23). (5) After execution, compare actual vs estimated cost and feed the delta back to improve future estimates.
- Tests: `tests/unit/whop-wallet.test.ts` (13 tests — webhook signature verify/reject,
sub-merchant provisioning idempotency + honest error-status on missing key, cross-business
isolation on both balance-read and payout-request, webhook idempotent recording + unknown-
company skip + invalid-signature rejection, the full payout-approval state machine (pending →
emailed link → single-use execution → destination marked verified → a verified destination's
NEXT payout skips approval), insufficient-balance rejection, and a secret-hygiene check that the
master API key never lands in any D1 row). `tests/unit/reserved-capabilities.test.ts` updated to
assert Whop is now blocked as a direct-fetch host (previously asserted the opposite, before Whop
became a reserved rail). 1818/1818 suite green (13 new, 3 pre-existing owner-email-lookup
crashes fixed via try/catch wrapping), `pnpm turbo run typecheck` clean (75 tasks), dashboard +
shell both verified via `next build`.

## Final reconciled architectural changes (newest authority)

These are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.

#### 1. The Universal Swarm Orchestrator Paradigm
* **This updates/replaces:** The Grok Bot / Hermes "chatty coworker roster" model (where users manage 5 named avatars in a sidebar and act as middle-manager dispatchers).
* **The New Architecture & Mental Model:** The user interacts with **ONE Sovereign Universal Agent (`NaelaoAgentDO`)** that acts as the **Lead Swarm Director** (modeled directly after Cursor’s SQLite benchmark swarm). When given a goal (`/goal` or natural language), the Universal Agent does not engage in conversational roleplay; it deconstructs the objective into a clean Task DAG in `SpaceDO.tasks`, forks isolated Git branches on Cloudflare Artifacts, and dispatches tasks to ephemeral worker subagents.
* **Key Invariant:** The human is strictly the **Outcome Definer & Final Approver**; the AI Lead is the **Orchestrator**. Humans never act as air-traffic controllers between bots.

#### 3. Worker Runtime Bifurcation (Fast Isolate Actors vs. Durable Workflows)
* **This updates/replaces:** The idea that *all* workers should be Cloudflare Dynamic Workflows (which introduced multi-second scheduling latency on simple queries).
* **The New Architecture & Mental Model:** Workers are physically split across two engines based on latency requirements:
  * **Prebuilt System Workers (The Executive Cabinet & Project Operators):** Run as **in-memory `NaelaoAgentDO` V8 Isolate Actors** over sub-millisecond Durable Object RPC (5ms–50ms response times) for interactive queries where the user or parent agent is actively waiting.
  * **Custom Developer Subagents & Batch Sagas:** Run as **Tier 3 Cloudflare Dynamic Workflows** for multi-minute, multi-hour, or multi-day tasks requiring step durability, retries, and dormant sleeping (`step.sleep`).
* **Key Invariant:** Any operation taking <30 seconds where a caller is waiting runs in-memory; long-running, multi-step batch tasks run as workflows.

#### 4. Asymmetric Subagent Topology (Verbs vs. Nouns)
* **This updates/replaces:** Over-engineering subagents into full mini-operating systems with their own thread trees, message schemas, and session managers.
* **The New Architecture & Mental Model:** Subagents are **ephemeral execution functions ("verbs")**, while only the Parent Agent is a **persistent entity ("noun")** that owns threads and UI. Subagents run with a slimmed-down `SubagentContext` (`ai`, `fs`, `cli`, `vault`, `step`), perform their assigned task, return a clean JSON result to the parent, and dissolve.
* **Key Invariant:** Subagents never create user-facing threads, manage WebSockets, or pollute the UI. The Parent Agent receives the subagent’s output and renders a single, compact **2-line Receipt Card**.

#### 6. The Strict 3-Depth Delegation Ceiling
* **This updates/replaces:** Unbounded recursive agent delegation where agents spawn agents indefinitely.
* **The New Architecture & Mental Model:** Delegation depth is hard-capped at exactly 3:
  * **Depth 1 (Lead Orchestrator):** Space Assistant or Project Lead (`NaelaoAgentDO`).
  * **Depth 2 (Domain Sub-Planner):** Ephemeral workflow managing a major workstream (e.g. API refactor).
  * **Depth 3 (Leaf Execution Worker):** Single-task isolate performing AST patching or running a test.
* **Key Invariant:** Depth 3 leaf workers **physically lack the delegation tool** in their runtime SDK, making Depth 4 calls structurally impossible.

#### 10. Durable Daemons (Fusing Micro-Apps with Dynamic Workflows)
* **This updates/replaces:** Treating Micro-Apps (static UI/DB) and Dynamic Workflows (ephemeral cron/pipelines) as disconnected features.
* **The New Architecture & Mental Model:** Combines a stateful DO Facet SQLite database with a continuous Cloudflare Workflow into a **Durable Daemon (or Active Service)**. Runs autonomously in the background across domains:
  * *Code:* Plandex-style Wasm Tree-Sitter AST Symbol Indexer (`ext_tree_sitter_indexer`).
  * *Finance:* General Ledger Double-Entry Reconciler (`gadget_ledger_reconciler`).
  * *Legal:* Delaware Case Law & Statute Citation Grapher (`gadget_citation_matrix`).
* **Key Invariant:** Daemons operate continuously in the background with zero CPU or token drag on active user chat sessions, auto-exposing `/mcp` endpoints to agents.

#### 11. Dual-Role Dynamic Workflows (Company Automations vs. Agent Tasks)
* **This updates/replaces:** Restricting Dynamic Workflows solely to "AI agent task execution."
* **The New Architecture & Mental Model:** Workflows serve two distinct masters:
  * *Agent Tasks:* Ephemeral, AI-heavy multi-step tasks.
  * *Company Automations:* Standalone operational software pipelines (ETL batch ingestion, nightly billing reconciliations, SLA sentinels) that run without human presence, executing deterministic code for 90% of steps ($0.00005) and invoking AI models only for semantic anomalies.
* **Key Invariant:** Workflows replace third-party enterprise automation suites (Zapier, Make, Temporal) natively on Cloudflare’s edge.

#### 12. Visual No-Code Subagent Studio
* **This updates/replaces:** Requiring users or developers to write complex TypeScript to create custom subagents.
* **The New Architecture & Mental Model:** Non-technical operators build specialized subagents in `apps/shell` visually by selecting tools, skills, knowledge bases, and triggers from a checklist. Compiles into a declarative `NoCodeSubagentManifest` JSON executed by a pre-compiled `GenericSubagentWorkflow`.
* **Key Invariant:** The builder UI is hardware-clamped to the creator's role rank; users cannot grant tools or knowledge bases they lack clearance to access.

#### 14. Pluggable Space-Shared Calendar Connector (`primary_calendar`)
* **This updates/replaces:** The isolated, hardcoded SQLite calendar table silo in `SpaceDO`.
* **The New Architecture & Mental Model:** The calendar is formalized as a standardized, pluggable **Space-Shared MCP Connector** (`ctx.connectors.use("primary_calendar")`). Spaces bind to Google Workspace, Microsoft 365, CalDAV, or an Edge SQLite Fallback.
* **Key Invariant (Edge Slot-Hold Mutex):** Voice agents acquire a 15-second reservation lock in `ConcurrencyDO` before calling external calendar APIs, eliminating double-booking race conditions during call spikes.

#### 16. The 13-Point Automation Failure Defense Suite
* **This updates/replaces:** Basic webhook catching that crashes under enterprise conditions.
* **The New Architecture & Mental Model:** A comprehensive edge protection suite:
  1. *Edge Tombstone Filter:* KV registry returning `410 Gone` on deleted webhooks and `204 No Content` on paused webhooks ($0 compute).
  2. *Cloudflare Queues Buffering:* Absorbs massive webhook spikes (e.g. 10,000 Shopify orders) and paces worker execution.
  3. *Time-Travel Replay Lake:* Raw webhooks archived in R2 for 14 days for 1-click debugging.
  4. *Leaky-Bucket Outbound Pacer:* Throttles external API calls (max 5 req/s) in `ConcurrencyDO` to prevent third-party 429 bans.
  5. *Payload Hash Idempotency:* Drops duplicate webhook replays via SQLite SHA-256 event hashes.
  6. *Ouroboros Loop Circuit Breaker:* Halts recursive automation ping-pong loops via `x-avos-hop-count` headers.
  7. *Lenient Zod Adapters:* Cheap edge models dynamically repair broken field mappings when third-party APIs update schemas.

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
