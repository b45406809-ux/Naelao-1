# AI Studio implementation prompt — batch 06, plan items 55–60

## Manual AI Studio hand-off contract

Implement this batch against the repository snapshot embedded after this instruction. Return the
implementation as **one complete unified Git diff** beginning with `diff --git`. Do not return a
shell script, prose before the diff, a partial snippet, or Markdown fences. The downloaded response
must be saved as `repomix/patches/batch-06.patch` and committed to
the accumulator branch. That path triggers the repository's batch-application workflow, which
validates and applies the patch, rebuilds the prompts, verifies the Repomix configuration, commits
the resulting code, and publishes the next batch XML plus its prompt as a workflow artifact.

The patch must not edit generated `repomix/outputs/` files, `.repomix-cache/`, or the downloaded
patch itself. Include tests and configuration changes in the same diff. If the entire batch cannot
fit, still return one apply-ready diff at an atomic verified boundary; the next downloaded patch
for the same batch continues from the newly generated repository snapshot.

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Thread tiers, solo promotion, artifact CAS, locks, PRs, and rebases**. This prompt is self-contained: the feature definitions and retained implementation
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

### 55. 4-Tier Thread Hierarchy

**Final behavior:** Project conversations partitioned into Team Rooms (Tier 1), Task Workstations (Tier 2), Consult Lanes (Tier 3), and Private Scratchpads (Tier 4).

**Production acceptance contract:**
Production entry: SpaceDO conversations and agent scratchpad helpers.
Persistence/deployment: SpaceDO/agent DO SQLite.
Required observable verification: conversation access tests exist; four-tier journey remains missing.

**Retained implementation constraints:**
- 76. **The thread model from item 75 was approved and is now BUILT, refined from the original
    proposal — the user's own framing (two SEPARATE conversations: user↔agent and
    assistant↔agent, the second hidden-but-expandable) is stronger than item 75's "state only, no
    second chat" recommendation, because it resolves the exact addressing-ambiguity objection that
    recommendation was raised to avoid. Connectors also gained a real space-vs-user scope model,
    closing a gap items 32/55 had already flagged and left open.**
    - **Thread model.** `threads.session_id` (SpaceDO migration v32) links a structural thread to
      a real chat session — a general-purpose column, not consult-specific, closing the "two
      tables with no server-side link" approximation items 66/71 documented, for threads created
      through this new path (every pre-existing thread/session pairing is untouched).
      `listThreads` gained a `parent_thread_id` filter, always answered in full regardless of a
      project's `show_sub_threads` default — the caller named exactly which subthreads it wants.
      New `OrchestrationHooks.consultAgent` (mirrors `spawnSubAgent`'s DO-to-DO dispatch pattern
      exactly, but addresses an EXISTING named agent definition via `{sessionId}:{agentId}` —
      Phase T2's own addressing — instead of a throwaway child): mints a fresh session + a
      `thread_kind='sub_agent'` subthread (or reuses one via `thread_id`), writes the assistant's
      own turn (nothing else does — `handleScriptRun` only ever writes back the answer, per its
      own comment), dispatches to the target agent's own DO directly via
      `agentDO.get(agentDO.idFromName(...))`, and returns the reply — or an honest
      "needs approval" when the consulted agent itself hits a HITL gate. New prebuilt
      `project-coordination` (`agent.consult`, `thread.list`, `thread.read` — deliberately a
      SEPARATE script from `workspace-admin`, which stays Launchpad-business-scaffolding-specific
      per its own header) is wired into BOTH assistant profiles, not just Launchpad's. `thread.
      list`/`thread.read` are read-only and added to the Launchpad guided-mode auto-approved
      allowlist (same precedent as `project.list`/`agent.list`); `agent.consult` stays gated by
      default (a real dispatched run has real cost, same posture as project scaffolding).
      Shell: `Chat.tsx` gained a `threadId` prop (only project threads pass one — Home/assistant
      sessions h
- // Temple: ScholarAI
const TEMPLE_SCHOLARAI: Temple = {
 id: 'temple-scholarai-v1',
 name: 'ScholarAI',
 tagline: 'Socratic AI tutoring — guides students to answers, never just gives them',
 category: 'vertical-education',
 spaceType: 'team',
 suggestedPricing: { type: 'subscription', pricePerSeat: 2900, trialDays: 14 },
 defaultAuthProvider: 'naelao-native',
 productConfig: {
 allowPublicSignup: true,
 featureFlags: {
 'socratic-mode': true, // Core flag — disables direct-answer mode
 'progress-tracking': true,
 'topic-coverage-analytics': true,
 'parent-progress-report': false, // Optional: weekly email summary to linked parent account
 'exam-prep-mode': true,
 },
 userPermissions: {
 canCreateProjects: false,
 canCreateSubSpaces: false,
 maxCreditsPerMonth: 500, // Per-student monthly cap — builder adjusts per plan tier
 maxThreadsPerUser: null,
 },
 adminFeatures: {
 userManagement: true,
 analyticsAccess: true,
 knowledgeBaseManagement: true,
 conversationLogAccess: false,
 },
 subSpaceTerminology: 'subjects',
 },
 agentBundle: [
 {
 agentId: 'team-assistant-v1',
 required: true,
 configOverrides: {
 systemPromptAddendum: 'You are a Socratic tutor. You NEVER give the answer directly. When a student asks a question, respond with a guiding question that moves them toward the answer. If they have tried 3 times and are stuck, give a hint — not the answer. If they are frustrated, acknowledge the difficulty warmly before the next guiding question. Always check their working, not just their final answer. Reference the curriculum document for this subject when constructing questions.',
 socraticMode: true,
 },
 },
 {
 agentId: 'analytics-reporter-v1',
 required: false,
 configOverrides: {
 schedule: 'weekly-sunday-8am',
 output: 'admin_dashboard_summary',
 },
 },
 ],
 knowledgeSchema: [
 { documentType: 'curriculum', required: true, description: 'The syllabus and topic list for each subject sub-space', exampleUrl: 'https://docs.naelao.app/templates/scholarai-curriculum' },
 { documentType: 'textbook_pages', required: false, description: 'Reference pages from approved textbooks for the agent to cite', exampleUrl: null },
 { documentType: 'past_papers', required: false, description: 'Past exam questions — enables exam prep mode', exampleUrl: null },
 ],
 estimatedSetupMinutes: 15,
 featured: false,
};
- - ~~**Credential hierarchy**~~ — **BUILT** (see A1.16.5). Per-user (default) + per-space
  (shared) + per-privileged-user overrides, in `workers/credentials`. Also closed a
  pre-existing gap: `space_credentials` had no migration at all — the worker would have
  thrown at runtime against a real D1.
- **MCP as scripts**: agents never connect to MCP directly; they write/use scripts that wrap
  MCP providers (Pipedream, Composio).
- ~~**Member/seat billing**~~ — **BUILT** (see A1.16.4). Lemon Squeezy billing for a builder's
  space-members (the third payer class): `/internal/seats/checkout` + LS-webhook
  `recordSeatActivation` (member activated on paid seat) already existed; this pass added the
  builder-facing enable/price surface (`GET/PATCH /spaces/:spaceId/member-billing`) that
  provisions the seat LS variant and stores the config as a per-space `productConfig` override.
- ~~**Storefront render + CF for SaaS apply step**~~ — **BUILT** (see A1.16.3). The portal
  Worker now serves the store at the root path a buyer lands on (`GET /` resolves the Host via
  `business_services`, precedence storefront → product portal), and the zone-scoped
  `custom_hostnames` apply (`createCustomHostname` + TXT DCV + status poll) is wired end-to-end
  in the spaces worker. The `storefront.set_custom_domain` prebuilt now posts `kind='custom_domain'`
  (the branch that actually runs the CF-for-SaaS apply).
- ~~**Space collaboration**~~ — **BUILT** (see A1.16.6). Roles already existed
  (`space_members.role`); locks already existed (`LockDO`/A1.15). This pass added presence
  (heartbeat-based, in `SpaceDO`) and project deduplication (name-similarity heads-up on
  `POST /projects`, wired to the existing event-trigger mechanism so a builder can broadcast
  "this already exists" via a no-code trigger). "Task boards" is the existing
  Projects+threads model (§A1.0) — a dashboard rendering concern, not a missing backend.
- ~~**Reseller / `tenant` membership**~~ — **BUILT** (see A1.16.4). `parent_tenant_id` hierarchy
  (`tenant_hierarchy`), `reseller_accounts`, per-event `reseller_ledger` attribution
  (`recordResellerAttribution` in the LS webhook), `/reseller/spaces` + client-portfolio
  endpoints were already in place; this pass added the consolidated **wholesale statement**
  (`GET /reseller/statement?period=YYYY-MM`) that sums the ledger into the invoice the reseller
  settles + a per-client breakdown (spec G-AS34/G-AS35).
- ### 1. Solving Thread Sprawl: The 3-Tier Thread Hierarchy
Do not allow an unorganized flat list of 50 disconnected threads. Structure project conversations into **3 clear tiers**:
* **Tier 1: The Main Project Channel (The "Team Room"):**
  * The single, always-present central room for the project.
  * All team members and the project's default agent discuss high-level updates, roadmaps, and milestones here.
* **Tier 2: Feature & Task Threads (Branch Workstations):**
  * Created for specific subtasks or bugs (e.g., `Thread #102: Stripe Webhook Refactor`).
  * Scoped to that specific task's `Todo` DAG state. Once completed, the thread is archived.
* **Tier 3: Sub-Agent Consult Lanes (Private Subthreads):**
  * Private background exchanges between the Space Assistant and specialist agents. Completely collapsed in the UI so they never clutter the human chat feed.
- ### 3. Real-Time Multiplayer Awareness (WebSockets over `WsHubDO`)
When Alice's agent edits a component, your **WebSocket Gateway (`WsHubDO`)** broadcasts a live presence event to all connected teammates:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 👥 LIVE MULTIPLAYER WORKSPACE CANVAS                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📁 src/components/                                                          │
│   ├── 📄 Header.astro  [ 👩‍💻 Alice's Agent Editing... (Locked) ]              │
│   ├── 📄 Footer.astro  [ 👨‍💻 Bob's Agent Editing... (Locked) ]                │
│   └── 📄 Button.astro  [ Available ]                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```
* **Live AST Diff Updates:** While Alice watches her agent write code, Bob's file tree and visual canvas update in real-time with zero latency.
* **No Lost Work:** The authoritative SQLite virtual filesystem inside the Durable Object guarantees serial consistency across all active threads.
- ### Summary Checklist
1. **Sub-Spaces as Departments:** Parent spaces provide **top-down executive oversight, corporate billing, and global brand policies**, while department sub-spaces provide **isolated templates, custom toolsets, and local spend caps**.
2. **Clean Scoping:** Sub-space members cannot see parent or sibling data by default; cross-department collaboration is explicitly authorized via `cross_space_grants`.
3. **Multi-User Projects Without Chaos:**
   * Tame thread sprawl with **1 Team Room + Dedicated Task Threads**.
   * Prevent code corruption with **Optimistic Hash-Checked SQLite Writes (`OCC`)** and **File Mutex Locks**.
   * Broadcast real-time awareness over **`WsHubDO` WebSockets**.
- #### Failure Modes & Anti-Patterns
* **Post-Retrieval Filtering (Information Leakage via Ranking):** Performing vector similarity search across all documents and filtering unauthorized documents in application logic allows unauthorized chunks to alter top-$k$ nearest-neighbor density, inadvertently leaking the existence or topical clustering of classified materials.
* **Global Assistant Amnesia & Scope Leakage:** Sharing memory state across different project spaces within the same organization allows non-privileged project threads to inherit semantic facts derived in restricted rooms [1.3.15].
* **Raw String Interpolation of External Artifacts:** Injecting unstructured scraper outputs directly into the prompt without semantic envelope encapsulation allows third-party websites to execute prompt injection against the agent.
- #### Core Architectural Blueprint
Multi-agent concurrency across shared workspaces is organized into a four-tier operational structure enforced by stateful edge actors:
```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE 4-TIER COLLABORATION MODEL                                          │
├────────────────────┬─────────────────────────┬────────────────────────────┬───────────────────────────────┤
│ Tier Level         │ Audience & Visibility   │ Multi-Player Interaction   │ Workspace Write Permissions   │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 1: Team**   │ **Public to Project**   │ Humans chat freely;        │ **Full Execution:**           │
│ **Room**           │ (All team members)      │ Agents answer on `@mention`│ File edits, builds, deploys.  │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 2: Task**   │ **Public to Project**   │ Focused on 1 Feature/DAG;  │ **Full Execution:**           │
│ **Workstations**   │ (All team members)      │ Teammates + `@DevAgent`    │ Locks & OCC patches.          │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 3: System** │ **Internal System**     │ Space Assistant consulting │ **Coordination Only:**        │
│ **Consult Lanes**  │ (Collapsed in UI)       │ Specialist Agents in bg    │ Journal & state updates.      │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 4: Private**│ **Strictly Private**    │ 1-on-1 between User & Agent│ **Read-Only / Simulation:**   │
│ **Scratchpad**     │ (Only that single user) │ No `@mention` needed       │ Zero direct writes to repo.   │
└────────────────────┴─────────────────────────┴────────────────────────────┴───────────────────────────────┘
```
* **Optimistic Concurrency Control (OCC) Storage Layer:** The authoritative filesystem stores source files as content-addressed chunk graphs in SQLite. File update transactions execute atomically using Compare-And-Swap (CAS) based on SHA-256 hashes.
* **Hierarchical File Mutex Engine:** Long-running refactoring operations acquire bounded-TTL distributed mutexes managed by dedicated actor instances. If an agent attempts to edit a locked file, the runtime intercepts the operation and signals the agent to yield or execute alternative DAG paths.
* **Slack-Style `@mention` Dispatch Matrix:** Public project rooms (Tier 1 & Tier 2) process multi-user chat streams. Agents remain inactive until explicitly summoned via tokens (e.g., `@DevAgent`), preventing unprompted token burn and race conditions [1.3.17].
- #### Failure Modes & Anti-Patterns
* **Silent Write-Clobbering (Last-Write-Wins):** Blindly overwriting files without hash-checkpoint verification causes concurrent agents to overwrite sibling changes, resulting in broken builds and missing dependencies.
* **Deadlock Cascades:** Multiple agents acquiring locks on intersecting sets of files in arbitrary order create classic distributed deadlocks. All lock acquisitions must enforce lexicographical key ordering and strict TTL bounds.
* **Ghost Workspace Mutations:** Allowing private 1-on-1 user scratchpads (Tier 4) to write directly to shared repository files causes untracked side effects that disrupt active team sprints.

### 56. Solo 2-Tier Cockpit vs. Multi-User 4-Tier Digital Office

**Final behavior:** Solo founders see a streamlined 2-Tier Cockpit (Chat + Live Canvas); inviting teammates dynamically promotes to the full 4-Tier Digital Office.

**Production acceptance contract:**
Production entry: shell project/thread surfaces only.
Persistence/deployment: no explicit cockpit-mode migration state.
Required observable verification: UI shells are not end-to-end evidence; promotion test is required.

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
- Required Fix: A codebase-index skill (Tier 2, runs in the sandbox's own git checkout — see G-BG09) builds and incrementally maintains a lightweight symbol/import/schema dependency graph of the operator's registered repository, stored as structured rows (not prose) in a new operator_dependency_graph table, refreshed on every merged change rather than recomputed from scratch. Before the SRE/QA agent green-lights a spec, it runs qa.blast_radius(changed_files) , which walks the graph outward N hops and returns the concrete list of call sites, schema consumers, and existing tests that touch the changed surface — turning "generate and run regression tests" from a blind full-suite re-run into a targeted, explainable list the QA agent (and a human reviewing its verdict) can actually reason about.
- First concrete step of the full-vision plan (Naelao → Builder → End User, end user gets the
launchpad-6-mockup agentic workspace; see the established architecture item 30 for the complete phased plan A-E).
Phase A had two deliverables: a shared design system, and a running end-user shell app that can
resolve a product, sign an end user up or in, and render the manifest-driven chrome — no chat yet
(that's Phase B).

### 57. Optimistic Concurrency Control (OCC) with SHA-256 Checkpoints

**Final behavior:** Atomic Compare-And-Swap file writes verified against SHA-256 base hashes, preventing concurrent users or agents from clobbering code.

**Production acceptance contract:**
Production entry: RepositoryDO/workspace write adapters.
Persistence/deployment: Git objects/refs and R2.
Required observable verification: repository stale-revision tests cover refs, not all file-write ingresses.

**Retained implementation constraints:**
- 70. **The LLM eval matrix is now REAL — and running it found six production bugs, the largest of
    which meant multi-step agent work had never once worked.** The harness (`workers/eval` in
    `mode:"agent"`, driven by `infra/scripts/run-eval-suite.mjs --models`) dispatches a REAL
    `/agent/run` per case through the live reasoning loop and judges the agent's actual answer.
    Findings and the full ranked table live in **`docs/MODEL_EVAL_2026-07-25.md`** — read that
    rather than duplicating numbers here, so they can't drift.
    - **The loop returned on the FIRST successful tool call** (`script-engine/loop.ts`). At L3/L4
      a successful `run` ended the run immediately, so the model never observed its own tool
      output. Multi-step work was structurally impossible and users got a blank `finalAnswer`.
      Live before the fix: "what is 2+2" worked, every tool-requiring request returned
      `status: completed` with an empty answer. Now the observation is appended to `priorSteps`
      (with a `stableStringify` repeat-call guard) and the loop continues; on exhaustion it fails
      honestly naming the steps it ran rather than returning nothing. **Three script-engine tests
      had been passing BECAUSE of this bug** — their fake reasoners only ever returned `run` and
      never answered; made realistic.
    - **The reasoner never saw prior steps.** `steps_so_far` (with a 2000-char observation cap)
      added to the payload, plus instructions to read them and finish with `answer`.
    - **A transient assistant-policy fetch failure turned the assistant off.** Failing closed is
      right, but the closed state is `gate_unless_listed` with an EMPTY allowlist — gate
      everything, no approver reachable — so under concurrent load every run died with what reads
      as a refusal to work. Now cached 30s, distinguishing 5xx/network (transient → serve the
      last verified policy) from 4xx (definitive → still fail closed), plus one retry for cold
      reads. A revoked policy still takes effect once the window passes.
    - **Quota split-brain.** `/internal/usage/{llm-tokens,infra-credits}/check` read
      `subscriptions.plan_tier` while `EntitlementsChecker` reads `orgs.plan_tier` — an org set to
      enterprise the way the docs instruct still hit the free tier's 100k wall (hit live at
      111,510/100,000). New shared `resolvePlanTier()`.
    - **The eval worker wrote columns that have never existed** (`eval_results (eval_suite_id,
      re
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
- ### 2. Solving Concurrent File Clashing: 3-Layer Concurrency Defense
To guarantee that multiple AI agents and humans never corrupt the codebase or overwrite each other's code, implement this 3-layer protocol:
- #### Layer 1: Optimistic Concurrency Control (OCC / Hash Checkpoint)
Every file in your authoritative SQLite `workspace_files` table carries a **SHA-256 content hash**.
When an agent calls `Edit(filePath, oldString, newString)`, the DO SQLite write enforces a **Conditional Checkpoint**:
```sql
-- Atomic OCC Update in DO SQLite
UPDATE workspace_files
SET content = ?, hash = ?, size_bytes = ?, updated_at = datetime('now')
WHERE path = ? AND hash = ?; -- Verified against hash at start of turn!
```
* **If another user/agent edited the file mid-turn:** `changes === 0`. The DO throws an instant conflict exception:
  > `✖ Conflict Error: 'src/Header.astro' was modified by another thread 1.2s ago. Re-read lines before applying patch.`
* The agent reads the fresh lines with `Read` and self-heals its patch cleanly.
- ### Summary Checklist
1. **Sub-Spaces as Departments:** Parent spaces provide **top-down executive oversight, corporate billing, and global brand policies**, while department sub-spaces provide **isolated templates, custom toolsets, and local spend caps**.
2. **Clean Scoping:** Sub-space members cannot see parent or sibling data by default; cross-department collaboration is explicitly authorized via `cross_space_grants`.
3. **Multi-User Projects Without Chaos:**
   * Tame thread sprawl with **1 Team Room + Dedicated Task Threads**.
   * Prevent code corruption with **Optimistic Hash-Checked SQLite Writes (`OCC`)** and **File Mutex Locks**.
   * Broadcast real-time awareness over **`WsHubDO` WebSockets**.
- ### Axis 6: Multi-Agent Concurrency & Conflict-Free Code Editing
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │      PROJECT WORKSPACE: "Core WebApp"                       │
                                  │   (Shared Authoritative SQLite Virtual Filesystem)          │
                                  └──────────────────────┬──────────────────────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 👩‍💻 THREAD 1: (Feature: "Add Dark Mode")                      │   │ 👨‍💻 THREAD 2: (Feature: "Fix Stripe Webhook")                 │
│ Agent: Dev Agent 1                                          │   │ Agent: Dev Agent 2                                          │
├─────────────────────────────────────────────────────────────┤   ├─────────────────────────────────────────────────────────────┤
│ 1. Agent 1 reads: `Header.astro` (hash: `h_v1`)             │   │ 1. Agent 2 reads: `Header.astro` (hash: `h_v1`)             │
│                                                             │   │                                                             │
│ 2. Agent 1 acquires mutex: `lock.acquire("src/Header.astro")│   │ 2. Agent 2 attempts mutex: `lock.acquire("src/Header.astro")│
│    Status: ✅ GRANTED                                        │   │    Status: ❌ DENIED (Held by Thread 1)                     │
│                                                             │   │                                                             │
│ 3. Agent 1 applies AST Patch: `patch_file`                  │   │ 3. Agent 2 yields: Operates on `src/api/stripe.ts` instead. │
│    SQLite OCC Write: Verified `hash == h_v1` ──► `h_v2`     │   │                                                             │
│                                                             │   │                                                             │
│ 4. Releases Lock. Broadcasts change via WsHubDO WebSockets. │   │ 4. Acquires Lock on `Header.astro` (sees `h_v2`), patches.  │
└─────────────────────────────────────────────────────────────┘   └─────────────────────────────────────────────────────────────┘
```
- #### Key Scientific & Industry Papers
* **Conflict-Free Replicated Data Types for Collaborative Code Synthesis**
  *Authors:* Distributed Algorithms & Collaborative Systems Group
  *Venue/Year:* ACM SIGPLAN / arXiv 2025
  *Summary:* Demonstrates that state-based CRDTs (specifically Logoot-Undo and RGA trees) allow multiple autonomous coding agents to simultaneously manipulate source code ASTs without generating syntax-invalid merge conflicts.
* **Optimistic Concurrency Control in Multi-Agent Software Development Workspaces**
  *Authors:* Autonomous Systems Laboratory
  *Venue/Year:* IEEE Transactions on Software Engineering 2026
  *Summary:* Evaluates lock-free optimistic concurrency control (OCC) against pessimistic mutex locking in multi-agent repositories, finding that hash-verified AST patching yields an 84% reduction in transaction abort rates compared to raw line-level patching.
- #### Core Architectural Blueprint
Multi-agent concurrency across shared workspaces is organized into a four-tier operational structure enforced by stateful edge actors:
```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE 4-TIER COLLABORATION MODEL                                          │
├────────────────────┬─────────────────────────┬────────────────────────────┬───────────────────────────────┤
│ Tier Level         │ Audience & Visibility   │ Multi-Player Interaction   │ Workspace Write Permissions   │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 1: Team**   │ **Public to Project**   │ Humans chat freely;        │ **Full Execution:**           │
│ **Room**           │ (All team members)      │ Agents answer on `@mention`│ File edits, builds, deploys.  │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 2: Task**   │ **Public to Project**   │ Focused on 1 Feature/DAG;  │ **Full Execution:**           │
│ **Workstations**   │ (All team members)      │ Teammates + `@DevAgent`    │ Locks & OCC patches.          │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 3: System** │ **Internal System**     │ Space Assistant consulting │ **Coordination Only:**        │
│ **Consult Lanes**  │ (Collapsed in UI)       │ Specialist Agents in bg    │ Journal & state updates.      │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 4: Private**│ **Strictly Private**    │ 1-on-1 between User & Agent│ **Read-Only / Simulation:**   │
│ **Scratchpad**     │ (Only that single user) │ No `@mention` needed       │ Zero direct writes to repo.   │
└────────────────────┴─────────────────────────┴────────────────────────────┴───────────────────────────────┘
```
* **Optimistic Concurrency Control (OCC) Storage Layer:** The authoritative filesystem stores source files as content-addressed chunk graphs in SQLite. File update transactions execute atomically using Compare-And-Swap (CAS) based on SHA-256 hashes.
* **Hierarchical File Mutex Engine:** Long-running refactoring operations acquire bounded-TTL distributed mutexes managed by dedicated actor instances. If an agent attempts to edit a locked file, the runtime intercepts the operation and signals the agent to yield or execute alternative DAG paths.
* **Slack-Style `@mention` Dispatch Matrix:** Public project rooms (Tier 1 & Tier 2) process multi-user chat streams. Agents remain inactive until explicitly summoned via tokens (e.g., `@DevAgent`), preventing unprompted token burn and race conditions [1.3.17].

### 58. Distributed File-Level Mutex Locks (`ConcurrencyDO`)

**Final behavior:** Multi-file refactoring acquires 30-second TTL locks on file keys. Crashed agents automatically release locks on expiration.

**Production acceptance contract:**
Production entry: LockDO and lock prebuilt request path.
Persistence/deployment: Durable Object SQLite state and alarms.
Required observable verification: concurrency/fail-closed tests cover primitive races; orchestration enforcement remains.

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
- Required Fix
 Required Fix Halve the default TTL to 30 seconds and make it configurable per call. Add an admin-force-release endpoint on ProjectDO (`POST /force-release-lock`) callable by the naelao-admin Worker for stuck locks. Define the UI state when a lock is held: show a spinner with "File locked by [agent name], retrying…" and auto-retry every 5 seconds. The sweeper's cleanup path should call force-release (not releaseLock) to avoid the ownership check throwing. Severity: Medium — Every agent crash produces a 60-second write blockout on affected files. In multi-agent projects this silently stalls parallel agents. T-132 — ProjectDO
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
- # PART 2: Multi-User Project Collaboration & Conflict Resolution
When multiple humans and multiple AI agents collaborate in the same project simultaneously, you run into two massive problems:
1. **Thread Sprawl:** 5 users creating uncoordinated, overlapping threads.
2. **File Clashing:** Agent A (working for Alice) and Agent B (working for Bob) trying to edit `src/Header.astro` at the exact same millisecond.
Here is the exact engineering solution to handle seamless multi-player collaboration at Cloudflare's edge:
```
                                  ┌──────────────────────────────────────────────┐
                                  │      PROJECT WORKSPACE: "Core WebApp"        │
                                  │   (Shared Authoritative SQLite Filesystem)   │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 👩‍💻 ALICE'S THREAD (Feature: "Add Dark Mode")                 │   │ 👨‍💻 BOB'S THREAD (Feature: "Update Navbar Links")            │
│ Agent: Dev Agent 1                                          │   │ Agent: Dev Agent 2                                          │
├─────────────────────────────────────────────────────────────┤   ├─────────────────────────────────────────────────────────────┤
│ 1. Agent 1 calls: `lock.acquire("src/Header.astro")`        │   │ 1. Agent 2 calls: `lock.acquire("src/Header.astro")`        │
│    ✅ **LOCK GRANTED** to Alice's Thread.                    │   │    ❌ **LOCK DENIED (Held by Alice's Thread)**.             │
│                                                             │   │                                                             │
│ 2. Agent 1 applies search/replace `Edit` patch.             │   │ 2. Agent 2 yields: *"Header.astro is currently being edited │
│    SQLite hash updates: `h_v1` ──► `h_v2`.                  │   │    by Alice. Working on Footer.astro first..."*             │
│                                                             │   │                                                             │
│ 3. Agent 1 releases lock. WebSocket broadcasts change.      │   │ 3. Agent 2 acquires lock once freed & applies clean patch.  │
└─────────────────────────────────────────────────────────────┘   └─────────────────────────────────────────────────────────────┘
```
- #### Layer 2: File-Level Mutex Locks (`lock.ts` / `ConcurrencyDO`)
Before an agent begins a complex, multi-file refactor:
1. It calls `lock.acquire({ key: "file:src/Header.astro", holderId: threadId, ttlMs: 30000 })`.
2. If another thread holds the lock, the agent does not crash—it adapts:
   * *"Header.astro is currently locked by Bob's task. I will work on `Footer.astro` and return to Header later."*
3. Locks carry a 30-second TTL in `ConcurrencyDO` so a crashed agent never deadlocks a file forever.
- ### Summary Checklist
1. **Sub-Spaces as Departments:** Parent spaces provide **top-down executive oversight, corporate billing, and global brand policies**, while department sub-spaces provide **isolated templates, custom toolsets, and local spend caps**.
2. **Clean Scoping:** Sub-space members cannot see parent or sibling data by default; cross-department collaboration is explicitly authorized via `cross_space_grants`.
3. **Multi-User Projects Without Chaos:**
   * Tame thread sprawl with **1 Team Room + Dedicated Task Threads**.
   * Prevent code corruption with **Optimistic Hash-Checked SQLite Writes (`OCC`)** and **File Mutex Locks**.
   * Broadcast real-time awareness over **`WsHubDO` WebSockets**.
- #### Core Architectural Blueprint
Multi-agent concurrency across shared workspaces is organized into a four-tier operational structure enforced by stateful edge actors:
```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE 4-TIER COLLABORATION MODEL                                          │
├────────────────────┬─────────────────────────┬────────────────────────────┬───────────────────────────────┤
│ Tier Level         │ Audience & Visibility   │ Multi-Player Interaction   │ Workspace Write Permissions   │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 1: Team**   │ **Public to Project**   │ Humans chat freely;        │ **Full Execution:**           │
│ **Room**           │ (All team members)      │ Agents answer on `@mention`│ File edits, builds, deploys.  │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 2: Task**   │ **Public to Project**   │ Focused on 1 Feature/DAG;  │ **Full Execution:**           │
│ **Workstations**   │ (All team members)      │ Teammates + `@DevAgent`    │ Locks & OCC patches.          │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 3: System** │ **Internal System**     │ Space Assistant consulting │ **Coordination Only:**        │
│ **Consult Lanes**  │ (Collapsed in UI)       │ Specialist Agents in bg    │ Journal & state updates.      │
├────────────────────┼─────────────────────────┼────────────────────────────┼───────────────────────────────┤
│ **Tier 4: Private**│ **Strictly Private**    │ 1-on-1 between User & Agent│ **Read-Only / Simulation:**   │
│ **Scratchpad**     │ (Only that single user) │ No `@mention` needed       │ Zero direct writes to repo.   │
└────────────────────┴─────────────────────────┴────────────────────────────┴───────────────────────────────┘
```
* **Optimistic Concurrency Control (OCC) Storage Layer:** The authoritative filesystem stores source files as content-addressed chunk graphs in SQLite. File update transactions execute atomically using Compare-And-Swap (CAS) based on SHA-256 hashes.
* **Hierarchical File Mutex Engine:** Long-running refactoring operations acquire bounded-TTL distributed mutexes managed by dedicated actor instances. If an agent attempts to edit a locked file, the runtime intercepts the operation and signals the agent to yield or execute alternative DAG paths.
* **Slack-Style `@mention` Dispatch Matrix:** Public project rooms (Tier 1 & Tier 2) process multi-user chat streams. Agents remain inactive until explicitly summoned via tokens (e.g., `@DevAgent`), preventing unprompted token burn and race conditions [1.3.17].
- #### Failure Modes & Anti-Patterns
* **Silent Write-Clobbering (Last-Write-Wins):** Blindly overwriting files without hash-checkpoint verification causes concurrent agents to overwrite sibling changes, resulting in broken builds and missing dependencies.
* **Deadlock Cascades:** Multiple agents acquiring locks on intersecting sets of files in arbitrary order create classic distributed deadlocks. All lock acquisitions must enforce lexicographical key ordering and strict TTL bounds.
* **Ghost Workspace Mutations:** Allowing private 1-on-1 user scratchpads (Tier 4) to write directly to shared repository files causes untracked side effects that disrupt active team sprints.
- #### Direct Implementation Recommendation for Cloudflare Edge Runtime
Implement the project virtual filesystem inside a single **Cloudflare Durable Object** (`SpaceDO`) to ensure all file writes are serialized through a single-threaded SQLite event loop [1.3.17]. Utilize **Cloudflare WebSocket Hibernation (`WsHubDO`)** to broadcast file mutation events (`presence.file_editing`, `workspace.file_changed`) across all connected clients in real time [1.3.17]. Lock acquisition is managed via `ConcurrencyDO` with automatic 30-second TTL expirations [1.3.17].

### 59. Inline Pull Request (PR) Review Cards

**Final behavior:** Merges from branches to `main` render interactive cards with visual AST diffs, author attribution, and one-click merge buttons.

**Production acceptance contract:**
Production entry: artifact branches and shell artifact card.
Persistence/deployment: RepositoryDO durable Git object storage.
Required observable verification: artifact tests do not prove trusted diff rendering plus membership-checked merge.

**Retained implementation constraints:**
- 118. **Real streaming, and the agent now TALKS between tool calls — item 117's two stated
     limitations are both closed.** The user's correction was structural, not cosmetic: Claude Code
     has no hardcoded "tools then one final answer" shape; the model streams as it generates,
     speaks to the user as many times as it decides to, and stops when it judges the job done. Two
     of those three were genuinely missing here.
     - **The reasoning call is now streamed** (`stream: true` + `stream_options.include_usage`,
       new `parseUniversalStream` in `shared/ai-client.ts`). The hard part is that a tool call
       arrives as JSON *fragments* — `{"say":"Let me ch` — so `JSON.parse` is unusable until the
       final chunk, which would defeat the point. New `partialJsonString(buffer, key)` walks the
       buffer by hand and returns whatever of a value has arrived, unescaped, whether or not the
       closing quote has been seen (stopping at a half-arrived `\` or `\uXXXX` rather than emitting
       a character the next chunk replaces). Streaming is **opt-in per call** via a new
       `Reasoner.decide({onDelta})`: an interactive chat passes it, a cron wake / channel drain /
       sub-agent does not, so those keep the cheaper non-streamed path and cannot regress.
     - **Mid-run replies are a first-class tool parameter, not incidental prose.** Item 117
       captured text a model *happened* to attach beside its tool call — but under
       `tool_choice:"required"` many providers suppress free text entirely, so that source is
       unreliable exactly where reliability matters most (the small open-weight models a free-tier
       business runs on). `run`/`distill`/`patch` now each declare a **required `say`**, so it
       comes back through the provider's own constrained decoding every time, and it streams — the
       user reads the sentence before the tool it describes has started. `DECISION_INSTRUCTIONS`
       gained a paragraph telling the model to write it as speech reflecting what it just learned,
       never a stock phrase; the existing "not on a short leash" paragraph absorbed the
       conversation framing (keep going as long as the goal needs, `answer` when YOU judge it met).
     - **Growing text needed a new checkpoint kind.** New `LiveCheckpoint = TraceStep + {partial,
       answer_preview}` (`script-engine/types.ts`) — deliberately NOT on `TraceStep` itself, which
       is the durable record. `NaelaoAgentDO.recordLiveProgress` u
- Required Fix: A codebase-index skill (Tier 2, runs in the sandbox's own git checkout — see G-BG09) builds and incrementally maintains a lightweight symbol/import/schema dependency graph of the operator's registered repository, stored as structured rows (not prose) in a new operator_dependency_graph table, refreshed on every merged change rather than recomputed from scratch. Before the SRE/QA agent green-lights a spec, it runs qa.blast_radius(changed_files) , which walks the graph outward N hops and returns the concrete list of call sites, schema consumers, and existing tests that touch the changed surface — turning "generate and run regression tests" from a blind full-suite re-run into a targeted, explainable list the QA agent (and a human reviewing its verdict) can actually reason about.
- **`packages/ui`** — new workspace package, plain `tsc` build (matches every other package's
convention, no bundler). `tokens.css` ports the mockup's `:root`/`[data-theme=dark]` custom
properties verbatim (warm paper palette, `--accent #5b52f0`, DM Sans/Instrument Serif). `styles.css`
ports the mockup's ~600 lines of component classes verbatim (sidebar, nav, space-switcher,
chat/thread-panel, home view, input box, page views, cards, badges, buttons, workflows, kb items,
settings, assistant layout, modal, toast, and the full responsive/mobile layer) — kept as global
CSS classes (not CSS-in-JS or Tailwind) specifically so the exact same stylesheet can be consumed
by both the new shell AND the reskinned dashboard (Phase D) without forking styles twice. A handful
of the mockup's singleton `#id` selectors were converted to classes (`.topbar`, `.chat-area`,
`.thread-panel`, `.home-view`, `.modal-overlay`, `.toast`, etc.) since these are now reusable React
components, not one-off page elements — `#sidebar`/`#app`/`#main` stayed as ids since the
responsive media queries key off `#sidebar.icon-only` specifically. React primitives:
`Sidebar`/`NavItem`/`HistoryItem`/`SpaceSwitcher` (all data-driven — no hardcoded nav items, since
different SpaceTypes and `hidden_core_items` need different sidebars), `Card`/`Badge`/`Button`/
`Modal`/`Toast`/`Avatar`/`FormInput`/`FormSelect`/`Toggle`/`TopBar`/`PageView`, an icon registry
(`icons.tsx`, inline SVGs matching the mockup's exact paths for pixel parity), and a `useTheme`
hook (localStorage-persisted, falls back to `prefers-color-scheme`).
- # PART 3: Cloudflare Virtual FS Branching & "Pull Request" (PR) Engine
You can implement a **Git-like Branching and Pull Request (PR) workflow** directly inside the **Authoritative SQLite Virtual Filesystem (`workspace_files`)** of your Durable Object.
This allows users or specialist agents in **Tier 4 Private Scratchpads** to make changes on a **virtual branch**, verify the code in isolation, and then open a **Pull Request Card** in the **Tier 1 Main Team Room** where team members review visual diffs and merge them atomically to the main project.
```
                                  ┌──────────────────────────────────────────────┐
                                  │      PROJECT WORKSPACE (`NaelaoAgentDO`)     │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┴───────────────────────────────┐
                         ▼                                                               ▼
┌─────────────────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────────────────┐
│ 🌿 MAIN BRANCH (`branch = 'main'`)                           │   │ 🌿 ALICE'S VIRTUAL BRANCH (`branch = 'branch:alice_v1'`)    │
│ • Production/Shared Project Codebase.                       │   │ • Created inside Tier 4 Private Scratchpad.                 │
│ • Read by team members and live deployments.                │   │ • Alice's agent runs AST `Edit` patches on private branch.  │
│ • Untouched while Alice experiments.                        │   │ • Zero risk of clobbering Main workspace.                   │
└──────────────────────────────┬──────────────────────────────┘   └──────────────────────────────┬──────────────────────────────┘
                               │                                                                 │
                               │           [ User or Agent clicks "Submit Pull Request" ]        │
                               │                                  │                              │
                               ▼                                  ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 📬 TIER 1 TEAM ROOM: INLINE PR REVIEW CARD (Rendered via Chat.tsx)                                           │
│ ├── 📌 **PR #12: "Refactor Dark Mode Header & Fix Button Link"** (by Alice & @DevAgent)                     │
│ ├── 🤖 **AI Reasoning:** "Replaced inline CSS with Tailwind dark classes. Passed Astro build test."         │
│ ├── 🔍 **Visual AST Diff:** `src/components/Header.astro` [ +12 lines / -4 lines ]                         │
│ └── 🔘 **Action Buttons:** `[ ✅ Accept & Merge to Main ]`   `[ 💬 Request Revisions ]`   `[ ❌ Reject ]`     │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼ (Admin clicks "Accept & Merge")
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ATOMIC SQLITE MERGE: `UPDATE workspace_files SET content = branch_content WHERE branch = 'main'`            │
│ WsHubDO WebSockets broadcasts `workspace.merged` ──► Live Preview Canvas hot-reloads on Cloudflare Pages!   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### 3. The Inline PR Review Card in the Team Room (`apps/shell`)
When an agent or user submits a PR from their private scratchpad, an **Inline Pull Request Card** appears directly in the Tier 1 Team Room:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 📬 PULL REQUEST #14: Dark Mode Navbar & Logo Fix                            │
│ 👤 Author: Alice (@alice) via Private Scratchpad 4                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🤖 **Agent Reasoning & Summary:**                                            │
│ "Replaced static header styling with Tailwind `dark:bg-slate-900` classes.   │
│  Updated logo link to point to `/dashboard`. Verified with `npm run build`."│
├─────────────────────────────────────────────────────────────────────────────┤
│ 🔍 **Changed Files (2):**                                                    │
│ • `src/components/Header.astro`   [ 12 additions / 4 deletions ]             │
│ • `src/styles/theme.css`          [ 2 additions  / 0 deletions ]             │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🔘 **Reviewer Actions:**                                                    │
│ [ ✅ Accept & Merge to Main ]    [ 💬 Request Changes ]    [ ❌ Reject ]     │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### Summary of What This Establishes:
1. **Deterministic Multi-Tier Knowledge (Mini-AGI):** Documents are partitioned by **Space, Project, and Role Rank**; Vectorize discards unauthorized chunks at the hardware query layer so classified information never leaks.
2. **Google-Search-Level Edge Intelligence:** Combines **sub-50ms KV semantic caching**, **Hybrid RRF (Dense Vectorize + Sparse BM25)**, and **live edge web search** with clickable citation footnotes.
3. **Safe Multi-Player Collaboration:** Users and agents can freely branch and experiment in **Tier 4 Private Scratchpads**. Edits are committed via structured **Pull Requests**, and teammates review visual diffs and merge changes to the main workspace with zero risk of code clobbering.
The release of **Cloudflare Artifacts (Git for Agents)** provides the exact native infrastructure layer needed for this architecture.
Instead of hand-rolling custom table schemas in SQLite to simulate branches and diffs, Cloudflare has built a **native Git-compatible versioned filesystem running inside Durable Objects (via a Zig-to-WASM Git engine)**.
This unlocks the **Per-Session/Per-Project Git Engine**, **Instant Zero-Copy Forking**, and **ArtifactFS FUSE Mounting** directly within our 6-Tier Execution Ladder.
- # 1. The Upstream Staleness & AI Rebase Engine
When work is committed to `main` (Tier 1 Team Room), any active Tier 4 Private Scratchpad or Tier 2 Task Thread automatically detects that it is **behind upstream** and enables the agent to **autonomously inspect, evaluate, and pull changes.**
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        UPSTREAM STALENESS & AI REBASE FLOW                                             │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. [Commit on Main]         Admin merges PR #14 on `main` (New Commit: `c_main_v2`).                   │
│                                  │                                                                     │
│ 2. [Artifacts Event]        Cloudflare Queue receives `artifacts.repo.pushed`.                        │
│                             `WsHubDO` broadcasts `workspace.upstream_pushed` to all active threads.    │
│                                  │                                                                     │
│ 3. [Divergence Calculation] Active Thread DO queries: `env.AGENT_REPOS.compare(scratchpad, main)`      │
│                             Result: "2 commits behind main. Files changed: ['src/api/stripe.ts']"     │
│                                  │                                                                     │
│ 4. [UI Status Bar]          Thread UI updates: `[ 🌿 scratchpad-alice | ⚠️ 2 commits behind | [Sync] ]`│
│                                  │                                                                     │
│ 5. [AI Auto-Reconciliation] Agent in thread inspects diff:                                             │
│                             • "My task is editing `src/Header.astro`."                                 │
│                             • "Upstream changed `src/api/stripe.ts` (No direct overlap)."              │
│                             • Agent triggers `git.pull_upstream()` and updates its local types!        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### D. Automated 3-Way AST Conflict Resolver Agent
If a PR submitted from a private scratchpad has conflicting edits with `main`:
1. The platform does not throw a dumb raw text conflict marker (`<<<<<<< HEAD`).
2. A specialized **Resolver Subagent** receives the 3-way AST diff:
   * Base commit ($O$)
   * Upstream changes on Main ($A$)
   * Scratchpad changes ($B$)
3. The agent inspects both intents, merges the non-overlapping AST nodes in Tier 2 CodeMode, runs the test suite, and presents a **verified, conflict-resolved merge commit**.
- ### Summary of What This Adds to the Platform
| Feature | How It Works with Cloudflare Artifacts |
| :--- | :--- |
| **Upstream Staleness Tracking** | Real-time `commitsBehind` badges across all scratchpads and task threads. |
| **Smart Agent Rebase** | Agents inspect upstream diffs before pulling, auto-rebasing non-overlapping files. |
| **Turn-by-Turn Time Machine** | 1-click rollback to any historical agent turn via instant Git commit resets. |
| **Reasoning-Aware `git-blame`** | Agents read historical commit reasoning to understand why past code was written. |
| **Multi-Model Branch Races** | Fork 3 branches for 3 models in parallel; merge the winning benchmarked code. |
| **AST-Aware Merge Resolver** | AI resolves Git merge conflicts automatically by understanding code syntax. |

### 60. Upstream Staleness Detection & Auto-Rebase

**Final behavior:** Tracks branch divergence (`2 commits behind main`). Autonomously rebases non-conflicting files and surfaces overlaps for review.

**Production acceptance contract:**
Production entry: RepositoryDO refs/history.
Persistence/deployment: immutable Git objects and refs.
Required observable verification: stale-revision tests are not a stale-branch rebase journey.

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

- Required Fix: A codebase-index skill (Tier 2, runs in the sandbox's own git checkout — see G-BG09) builds and incrementally maintains a lightweight symbol/import/schema dependency graph of the operator's registered repository, stored as structured rows (not prose) in a new operator_dependency_graph table, refreshed on every merged change rather than recomputed from scratch. Before the SRE/QA agent green-lights a spec, it runs qa.blast_radius(changed_files) , which walks the graph outward N hops and returns the concrete list of call sites, schema consumers, and existing tests that touch the changed surface — turning "generate and run regression tests" from a blind full-suite re-run into a targeted, explainable list the QA agent (and a human reviewing its verdict) can actually reason about.
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
- # 1. The Upstream Staleness & AI Rebase Engine
When work is committed to `main` (Tier 1 Team Room), any active Tier 4 Private Scratchpad or Tier 2 Task Thread automatically detects that it is **behind upstream** and enables the agent to **autonomously inspect, evaluate, and pull changes.**
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        UPSTREAM STALENESS & AI REBASE FLOW                                             │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. [Commit on Main]         Admin merges PR #14 on `main` (New Commit: `c_main_v2`).                   │
│                                  │                                                                     │
│ 2. [Artifacts Event]        Cloudflare Queue receives `artifacts.repo.pushed`.                        │
│                             `WsHubDO` broadcasts `workspace.upstream_pushed` to all active threads.    │
│                                  │                                                                     │
│ 3. [Divergence Calculation] Active Thread DO queries: `env.AGENT_REPOS.compare(scratchpad, main)`      │
│                             Result: "2 commits behind main. Files changed: ['src/api/stripe.ts']"     │
│                                  │                                                                     │
│ 4. [UI Status Bar]          Thread UI updates: `[ 🌿 scratchpad-alice | ⚠️ 2 commits behind | [Sync] ]`│
│                                  │                                                                     │
│ 5. [AI Auto-Reconciliation] Agent in thread inspects diff:                                             │
│                             • "My task is editing `src/Header.astro`."                                 │
│                             • "Upstream changed `src/api/stripe.ts` (No direct overlap)."              │
│                             • Agent triggers `git.pull_upstream()` and updates its local types!        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- ### 2. How the Agent Evaluates Upstream Changes (Smart Reconciliation)
When an agent notices its scratchpad branch is behind `main`, it doesn't blindly fail. It runs an **Autonomous Upstream Impact Assessment**:
```typescript
// workers/agents/src/script-engine/prebuilt/git-sync.ts
export const checkAndReconcileUpstream = async (ctx: PrebuiltOpContext) => {
  const git = ctx.env.artifactsGit;
  const status = await git.getDivergenceStatus(ctx.env.projectId, ctx.env.threadId);
  if (status.commitsBehind === 0) {
    return { status: "UP_TO_DATE", message: "Branch is fully synchronized with main." };
  }
  // 1. Fetch exact git diff of what changed upstream on main
  const upstreamDiff = await git.getUpstreamDiff(status.baseCommit, status.upstreamHead);
  // 2. Compare upstream changed files with the files the agent is currently modifying
  const myActiveFiles = (await ctx.env.fs.glob("src/**/*")).files;
  const intersectingFiles = upstreamDiff.changedFiles.filter(f => myActiveFiles.includes(f));
  // 3. Decision Matrix
  if (intersectingFiles.length === 0) {
    // Zero overlap: Auto-rebase / Fast-forward cleanly
    await git.rebaseOntoMain(ctx.env.threadId);
    return {
      status: "AUTO_REBASED",
      commitsPulled: status.commitsBehind,
      message: `✔ Automatically pulled ${status.commitsBehind} upstream commits from main. Zero file collisions.`
    };
  }
  // Conflict Risk: Ask model to evaluate AST collision before pulling
  return {
    status: "REVIEW_REQUIRED",
    commitsBehind: status.commitsBehind,
    overlappingFiles: intersectingFiles,
    upstreamChangesSummary: upstreamDiff.summary,
    message: `⚠️ Upstream modified ${intersectingFiles.join(", ")}. Agent review required before merging.`
  };
};
```
- ### Summary of What This Adds to the Platform
| Feature | How It Works with Cloudflare Artifacts |
| :--- | :--- |
| **Upstream Staleness Tracking** | Real-time `commitsBehind` badges across all scratchpads and task threads. |
| **Smart Agent Rebase** | Agents inspect upstream diffs before pulling, auto-rebasing non-overlapping files. |
| **Turn-by-Turn Time Machine** | 1-click rollback to any historical agent turn via instant Git commit resets. |
| **Reasoning-Aware `git-blame`** | Agents read historical commit reasoning to understand why past code was written. |
| **Multi-Model Branch Races** | Fork 3 branches for 3 models in parallel; merge the winning benchmarked code. |
| **AST-Aware Merge Resolver** | AI resolves Git merge conflicts automatically by understanding code syntax. |

## Final reconciled architectural changes (newest authority)

These are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.

#### 4. Asymmetric Subagent Topology (Verbs vs. Nouns)
* **This updates/replaces:** Over-engineering subagents into full mini-operating systems with their own thread trees, message schemas, and session managers.
* **The New Architecture & Mental Model:** Subagents are **ephemeral execution functions ("verbs")**, while only the Parent Agent is a **persistent entity ("noun")** that owns threads and UI. Subagents run with a slimmed-down `SubagentContext` (`ai`, `fs`, `cli`, `vault`, `step`), perform their assigned task, return a clean JSON result to the parent, and dissolve.
* **Key Invariant:** Subagents never create user-facing threads, manage WebSockets, or pollute the UI. The Parent Agent receives the subagent’s output and renders a single, compact **2-line Receipt Card**.

#### 17. Generalization of `/workspace/` (Deliverable Canvas, Not Just Code)
* **This updates/replaces:** The developer bias that Git and `/workspace/` are strictly for programming source code.
* **The New Architecture & Mental Model:** `/workspace/` is the **Project Deliverable Canvas** regardless of file format. In legal projects, it holds contract suites (`.docx`, `.md`); in finance, it holds Excel models (`.xlsx`, `.csv`); in coding, it holds source code (`src/`). All executable agent machinery (skills, workflows, daemons) lives strictly in `/.avos/`.
* **Key Invariant:** Cloudflare Artifacts (Git for Agents) versions any file type; Pull Request cards adapt to show spreadsheet cell deltas or document redlines.

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
