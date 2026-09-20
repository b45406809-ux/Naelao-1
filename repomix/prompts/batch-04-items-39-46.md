# AI Studio implementation prompt — batch 04, plan items 39–46

## Manual AI Studio hand-off contract

Implement this batch against the repository snapshot embedded after this instruction. Return the
implementation as **one complete unified Git diff** beginning with `diff --git`. Do not return a
shell script, prose before the diff, a partial snippet, or Markdown fences. The downloaded response
must be saved as `repomix/patches/batch-04.patch` and committed to
the accumulator branch. That path triggers the repository's batch-application workflow, which
validates and applies the patch, rebuilds the prompts, verifies the Repomix configuration, commits
the resulting code, and publishes the next batch XML plus its prompt as a workflow artifact.

The patch must not edit generated `repomix/outputs/` files, `.repomix-cache/`, or the downloaded
patch itself. Include tests and configuration changes in the same diff. If the entire batch cannot
fit, still return one apply-ready diff at an atomic verified boundary; the next downloaded patch
for the same batch continues from the newly generated repository snapshot.

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Agent kernel, prompts, memory, isolation, and compaction**. This prompt is self-contained: the feature definitions and retained implementation
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

### 39. Universal Agent Execution Kernel (`NaelaoAgentDO`)

**Final behavior:** Single unified REPL execution kernel powering all agent roles across the platform, maintaining state and memory inside an isolated Durable Object.

**Production acceptance contract:**
Production entry: `NaelaoAgentDO.handleScriptRun`/loop.
Persistence/deployment: per-thread DO SQLite + R2 config; `NAELAO_AGENT_DO`.
Required observable verification: durable-default/archetype tests assert no alternate role loop.

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
- The Gap The spec loads skills by reading R2 objects for all three tiers (Platform, Space, Personal) on each agent turn to compose the system prompt. A single turn may load 10-30 skill files across three R2 prefixes. With R2 read latency of 20-40ms per object and no within-session cache, a turn that activates 5 skills incurs 100-200ms of R2 read overhead on top of LLM latency. Skills rarely change during an active session (they change between sessions when a user edits them). An in-memory cache keyed by skill version avoids redundant R2 reads within the same DO activation.
- 1. **Agents are their own Durable Object.** `NaelaoAgentDO` (original spec §G-D01–G-D20) is
   the agent runtime: ReAct loop, FSM, tool dispatch, 30 s timeout watchdog, SQLite-
   persisted run state. The agent loop lives here — **not** inside a per-product/per-niche
   DO. Addressed as `space:project:thread`.
2. **`SpaceDO` owns product structure.** Threads, messages, members, sub-space grants,
   billing, and **`agent_definitions`** live in `SpaceDO` SQLite. SpaceType differences live
   in config / agent definitions / manifests — **never in DB tables**.
3. **A project is a grouping of threads within a space.** Not a sub-space, not a workspace.
   Addressing is `space:project:thread`; `threads.project_id` is a nullable grouping key.
4. **SpaceTypes are configurations of one set of primitives.** Launchpad, Sites, Verticals,
   Enterprise, Workers, Mini-AGI differ by `SpaceTypeManifest` + agent definitions, not code.
- 187 - 189
Since this is universal we have eto make sure our naelao agent is universal users canan sort of configure it or atleast the instructions and so the same way we differentiate space assistant and project agents
To make the **Naelao Agent truly universal**, you do not write separate agent engines for different use cases.
Instead, you use **ONE universal execution kernel (`NaelaoAgentDO`)** and differentiate agents through a **Declarative Configuration Hierarchy**.
Whether an agent is the **Autonomous 24/7 CEO (Space Assistant)**, a **Focused Coding Specialist (Project Agent)**, or a **Custom User-Built Agent (e.g., a Tax Law Auditor)**, they all share the exact same REPL loop, token compressor, and memory engine. They only differ in **Scope, Instructions, Tool Surface, and Trigger Cadence**.
- ### 4. How Users Configure This in the UI (`apps/shell`)
In your Product Shell UI, users have full visual control over this universal configuration without writing code:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚙️ CONFIGURE AGENT: "Senior Contract Auditor"                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ 📝 Custom Directives & Prompt Overrides:                                    │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ Always check California civil code. Enforce mutual indemnity clauses.   │ │
│ │ Keep answers bulleted and cite specific clause numbers.                 │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ 🛠️ Enabled Capabilities & Plugins:                                         │
│ [x] Document Redline Canvas  [x] Vectorize Legal Search  [ ] Shell Terminal │
│                                                                             │
│ 🔒 Execution Ceiling & Permissions:                                         │
│ ( ) Tier 1: In-Memory / Safe Reads Only (Customer-Facing Safe)              │
│ (x) Tier 2: Cloudflare Isolates & Web Search                                │
│ ( ) Tier 5: Full Linux Container Sandbox (Heavy Code Compiles)              │
│                                                                             │
│ 🚦 Autonomy Posture:                                                        │
│ [ Always Ask Permission ]   [ Auto-Approve Routine Reads ]   [ Fully Auto ] │
└─────────────────────────────────────────────────────────────────────────────┘
```
- #### How the DO Executes the Unified Config:
```typescript
// Inside NaelaoAgentDO.ts (Building the Universal Prompt & Toolset)
function assembleUniversalAgent(manifest: UniversalAgentManifest, businessContext: BusinessContext) {
  // 1. Assemble 4-Layer Dynamic System Prompt
  const systemPrompt = [
    // Layer 1: Universal Engine Kernel
    BASE_CLAUDE_CODE_REPL_RULES,
    // Layer 2: Live Business Identity
    renderBusinessBrief(businessContext),
    // Layer 3: Archetype Role
    manifest.prompts.systemPrompt,
    // Layer 4: User/Founder Custom Instructions
    manifest.prompts.userCustomInstructions ? `\n# FOUNDER CUSTOM DIRECTIVES\n${manifest.prompts.userCustomInstructions}` : ""
  ].join("\n\n");
  // 2. Hardware-Level Tool Stripping (Physical Firewall)
  const sanitizedTools = sanitizePrebuiltListForRole(
    manifest.role,
    manifest.capabilities.enabledPrebuilts
  );
  // 3. Workspace Scoping
  const workspacePath = manifest.scope === "SPACE_WIDE"
    ? `spaces/${spaceId}/workspace/`
    : `spaces/${spaceId}/projects/${manifest.projectId}/workspace/`;
  return { systemPrompt, sanitizedTools, workspacePath, maxTier: manifest.capabilities.maxTier };
}
```

### 40. Dynamic 4-Layer System Prompt Assembly

**Final behavior:** Assembles prompts dynamically from 4 immutable layers: Universal Kernel $\rightarrow$ Business Context $\rightarrow$ Agent `SOUL.md` $\rightarrow$ Founder Directives.

**Production acceptance contract:**
Production entry: agent config loader/reasoner prompt assembly.
Persistence/deployment: immutable/versioned config files in R2.
Required observable verification: conversation-context tests verify order and replacement behavior.

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
- Required Fix (DEFERRED): A "mini-app" in this assistant's context is simply a CONNECTOR (the established specification's model, extended with a Composio/Pipedream/direct-OAuth catalogue entry per service) plus, where the assistant should be able to take a real ACTION on the user's behalf rather than just read data, a small set of scoped ops on that connector (mirroring how business-wallet / business_wallet already exposes a narrow op surface rather than raw API access). "Access on your behalf" for social media specifically reuses the social-posting connectors G-BF-era work already built (X/LinkedIn/Instagram/TikTok, item 56) — this appendix's contribution is only that a PERSONAL assistant, not a business one, is the caller, which changes nothing about the connector layer itself, only which agent profile holds the grant.
- 1. **Schedule-type triggers → a real `scheduled_jobs` row, with a new goal-based dispatch
   mode.** `scheduled_jobs` (0041/0042) only supported firing a named prebuilt script op
   DIRECTLY (`fireScriptDirectly`/`handleTriggerFire` — no reasoner, no OBSERVE/FIND/GATE loop,
   by deliberate design, identical posture to `event_triggers`). That's fine for "run this exact
   script on a timer," but "draft this week's marketing content" needs judgment, not a
   deterministic tool call — the dispatcher itself has no reasoning mode. Migration `0043`
   (`infra/migrations/0043_scheduled_jobs_agent_goal.sql`) adds two nullable columns:
   `agent_id` (which agent's own R2 config — system prompt, `requiresApprovalFor` — to wake;
   `NULL` keeps the implicit `"naelao-agent"` default) and `goal` (when set, the dispatcher wakes
   the FULL reasoning loop via `POST .../script/run` against that agent's own DO instead of
   firing `script_name` directly; `NULL` preserves the exact pre-existing direct-fire behavior
   for every job created before this fix). `script_name` stays `NOT NULL` (SQLite can't drop the
   constraint without a full table rebuild) — a goal-based row stores `''` there, an unambiguous
   sentinel the write path enforces at the API layer (`workers/spaces/src/index.ts`'s POST/PATCH
   `/scheduled-jobs` now require "`script_name` OR `goal`", not just `script_name`).
   `workers/agents/src/index.ts`'s `handleAgentTick` "scheduled_job" case branches on
   `row.goal`: set → the new `wakeAgentGoal` helper (mirrors `billing/lemon-squeezy.ts`'s
   `wakeAgent` — same `/script/run` shape, same `apiKey`/`sessionId`/`context` posture); unset →
   the pre-existing `fireScriptDirectly` path, byte-for-byte unchanged for every job that
   predates this migration.
- ### 1. The 4-Layer Universal Prompt Hierarchy
To make any agent configurable without breaking the underlying Claude Code tool-calling discipline, the system prompt is assembled dynamically from 4 distinct layers:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. UNIVERSAL OPERATING KERNEL (Immutable Engine Directives)                 │
│    • Universal Claude Code rules: Use `Edit` for AST search & replace.     │
│    • Never rewrite full files. Line-numbered `Read` with offset/limit.      │
│    • In-flight `compact_context` on milestone completion. Exit-0 squashing. │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. BUSINESS CONTEXT (Living Enterprise Identity)                            │
│    • Name, offering, pricing tiers, and setup status:                       │
│      "You are operating for 'LexPulse Legal' (B2B legal cowork, $49/mo)."   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. AGENT ARCHETYPE & DOMAIN ROLE (Template Specification)                   │
│    • Primary mission and domain persona:                                    │
│      "You are the Lead Edge Developer / Customer Support Specialist."       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. USER CUSTOM INSTRUCTIONS & OVERRIDES (User Configurable via UI)         │
│    • The founder/user's custom tweaks:                                      │
│      "Always use TypeScript + Tailwind dark mode. Keep messages concise."   │
└─────────────────────────────────────────────────────────────────────────────┘
```
- // 1. SCOPING & FILESYSTEM BOUNDARY
  // Space Assistant = Space-wide (`spaces/{spaceId}/workspace/`)
  // Project Agent   = Project-scoped (`spaces/{spaceId}/projects/{projectId}/workspace/`)
  scope: "SPACE_WIDE" | "PROJECT_BOUND";
  projectId?: string;
  // 2. ARCHETYPE ROLE & CAPABILITY FIREWALL
  role: "DEV_OPERATOR" | "GROWTH_OPERATOR" | "CUSTOMER_SUPPORT" | "ARCHITECT_DELEGATE" | "CUSTOM";
  // 3. INSTRUCTION & PROMPT LAYERS
  prompts: {
    systemPrompt: string;          // Role definition & task framing
    instructions: string;          // Operating guidelines (agents.md)
    userCustomInstructions?: string; // Founder's custom prompt overrides from the UI
  };
  // 4. TOOLSET & EXECUTION LADDER CEILING
  capabilities: {
    enabledPrebuilts: string[];    // e.g. ["r2-workspace", "code-exec", "memory", "web-search"]
    installedPlugins: string[];    // e.g. ["plugin_legal_redline", "plugin_seo_linter"]
    maxTier: 1 | 2 | 3 | 4 | 5;    // 1 (Isolate) to 5 (Linux Container)
  };
  // 5. AUTONOMY & HITL APPROVAL POSTURE
  autonomy: {
    approvalMode: "always_ask" | "gate_unless_listed" | "yolo";
    autoApprovedActions: string[];
    requiresApprovalFor: string[];
  };
  // 6. TRIGGER CADENCE (Proactive vs. Reactive)
  triggers: {
    proactiveHeartbeat: boolean;   // true for Space Assistant, false for project agents
    cronSchedule?: string;         // e.g. "0 9 * * *" for daily reports
    reactiveToThreads: boolean;    // true for project agents responding to user chat
  };
}
```
- #### How the DO Executes the Unified Config:
```typescript
// Inside NaelaoAgentDO.ts (Building the Universal Prompt & Toolset)
function assembleUniversalAgent(manifest: UniversalAgentManifest, businessContext: BusinessContext) {
  // 1. Assemble 4-Layer Dynamic System Prompt
  const systemPrompt = [
    // Layer 1: Universal Engine Kernel
    BASE_CLAUDE_CODE_REPL_RULES,
    // Layer 2: Live Business Identity
    renderBusinessBrief(businessContext),
    // Layer 3: Archetype Role
    manifest.prompts.systemPrompt,
    // Layer 4: User/Founder Custom Instructions
    manifest.prompts.userCustomInstructions ? `\n# FOUNDER CUSTOM DIRECTIVES\n${manifest.prompts.userCustomInstructions}` : ""
  ].join("\n\n");
  // 2. Hardware-Level Tool Stripping (Physical Firewall)
  const sanitizedTools = sanitizePrebuiltListForRole(
    manifest.role,
    manifest.capabilities.enabledPrebuilts
  );
  // 3. Workspace Scoping
  const workspacePath = manifest.scope === "SPACE_WIDE"
    ? `spaces/${spaceId}/workspace/`
    : `spaces/${spaceId}/projects/${manifest.projectId}/workspace/`;
  return { systemPrompt, sanitizedTools, workspacePath, maxTier: manifest.capabilities.maxTier };
}
```
- ### Tier 2: Stateless / Versioned Artifacts (Claude Artifacts on Cloudflare)
* **What it is:** Ephemeral, versioned deliverables generated during conversation turns (e.g., a static SVG flowchart, a compiled PDF invoice, or an interactive React chart).
* **Storage & Versioning:** Stored as immutable commits inside **Cloudflare Artifacts (Git for Agents)**.
* **Behavior:** Users can scrub the thread history like a time machine and click **[Fork Artifact]** or **[Revert Workspace to this Commit]**.
- ### Tier 3: On-Demand Stateful Micro-Apps ("Cloudflare OS Gadgets")
* **What it is:** A full-stack, living micro-application (built from a prompt in 30 seconds) that holds **its own private database and business logic**.
* **Storage & Execution:**
  * **Frontend:** Sandboxed in a null-origin `<iframe>` that communicates with the server via **Cap'n Web RPC / MCP-UI**.
  * **Backend & Database:** Runs inside a **Dynamic Worker isolate** backed by an isolated **Durable Object Facet SQLite database**.
  * **Self-Exposing API:** Automatically gets an **MCP v2 `/mcp` endpoint**, allowing AI agents to read, query, or automate the gadget natively!
- > **The Real-World Enterprise Scenario:**
> A Project Manager in the **PM Department Subspace** prompts the AI to build a *"QA Bug Reporting & Acceptance Matrix Gadget"*. The PM wants developers in the **Engineering Department Subspace** to use it without giving developers full access to the PM's confidential space.

### 41. Hardware-Enforced Role Firewalls (`AgentFirewall`)

**Final behavior:** Physically strips disallowed tools from the prompt schema based on declared functional role, preventing customer-facing bots from accessing shells or filesystems.

**Production acceptance contract:**
Production entry: profiles/reserved capabilities/ScriptToolSurface.
Persistence/deployment: role policy in agent config; no client binding authority.
Required observable verification: role-ceiling tests inspect schema and reject direct forbidden runs.

**Retained implementation constraints:**
- 139. **The Groq schema defect item 138 documented-but-deliberately-left-unfixed is now FIXED — the
     decision tool's `params` schema is chosen per provider.** Item 135 declared `params` as a JSON
     object STRING because Gemini could otherwise only ever emit `{}` (a bare `{type:"object"}` with
     no `properties` gives a schema-constrained decoder no permitted keys). That fix was correct for
     Gemini and broke Groq: Groq validates a model's tool-call output against the DECLARED schema
     **server-side** and rejects the call outright — `tool call validation failed: parameters for tool
     run did not match schema: errors: [`/params`: expected string, but got object]` — on both the
     streamed attempt and its non-streamed retry, confirmed live on a real heartbeat wake. Groq's
     models naturally emit a real object and its own validator will not let a string-typed field
     through.
     - **Fix**: `DECISION_TOOLS` (a module-level const) became `decisionTools(model)`. Gemini keeps
       the proven `PARAMS_PARAM_STRING`; every other provider gets `PARAMS_PARAM_OBJECT` —
       `{type:"object", additionalProperties:true}`. That `additionalProperties` is what makes an
       object schema safe to declare with no enumerable `properties`, i.e. a **more portable fix for
       the same underlying problem** than routing around it with a string. Gemini keeps its own
       declaration rather than sharing this one because Google's native function-calling schema is an
       OpenAPI-3.0 subset wanting exactly one declared `type`, and this platform's Gemini routing has
       never been verified against the `additionalProperties` shape — changing the one provider path
       that is *proven live to work* in order to maybe fix a second one was the trade item 138
       declined to make blind, and still is. `readParams()` already accepted either shape from either
       provider, so this only widens what a valid decision can be.
     - **The regression guard asserts the WIRE SHAPE, not the constant** — it captures the real
       request body a provider receives and fails on an object schema carrying neither `properties`
       nor `additionalProperties`, which is the precise defect rather than a proxy for it. Verified to
       genuinely catch a regression: reverting the split fails exactly the two provider-specific
       cases. A first draft of the test failed for an unrelated reason worth remembering —
       `canAuthenticateLlm()` refuses before eve
- The Gap All tools installed in a space are accessible to any agent running in that space. A builder's customer-support agent (which should only be able to query the knowledge base and create tickets) has no restriction preventing it from calling charge_card, send_email, or read_credentials tools. There is no tool allowlist/blocklist per agent role, no per-tool permission level, and no builder-visible tool access policy. Prompt injection or a misconfigured agent instruction can escalate to calling high-privilege tools.
- **Memory OS Layer 4 (Fabric) + Layer 6 (LLM Wiki) — the last two of the spec's 6 layers.**
Schema matches the spec's `fabric_store`/`wiki_store` (byte ~148161), scoped by `user_id` like
every other layer here (the spec's AssistantDO is single-tenant per DO; ours shares one DO's
SQLite in shared-assistant mode). `MemoryStore` gained `recordFabric`/`recallFabric`/
`briefFabric` (Fabric — cross-session summary consolidation, `fabric_recall`/`fabric_brief`
tools per spec) and `upsertWikiConcept`/`lookupWikiConcept`/`searchWiki` (Wiki — auto-curated
concept vault). Exposed to the agent as two new self-managed prebuilts, **`fabric`** and
**`wiki`** (same Hermes pattern as `memory`), in every default agent profile. `NaelaoAgentDO`
also auto-records a Fabric entry after every successful `/script/run` — reusing the run's own
goal + output + trace notes as the "session extraction" rather than firing a second LLM call,
an honest cost-conscious approximation of the spec's "LLM-driven session extraction post-run."
Fabric relevance scoring is a term-overlap heuristic (not embedding-based — Fabric is DO SQLite
+ R2 per spec, not a Vectorize-backed layer like Layer 5), filtered at the spec's 0.70 floor.
- // 1. SCOPING & FILESYSTEM BOUNDARY
  // Space Assistant = Space-wide (`spaces/{spaceId}/workspace/`)
  // Project Agent   = Project-scoped (`spaces/{spaceId}/projects/{projectId}/workspace/`)
  scope: "SPACE_WIDE" | "PROJECT_BOUND";
  projectId?: string;
  // 2. ARCHETYPE ROLE & CAPABILITY FIREWALL
  role: "DEV_OPERATOR" | "GROWTH_OPERATOR" | "CUSTOMER_SUPPORT" | "ARCHITECT_DELEGATE" | "CUSTOM";
  // 3. INSTRUCTION & PROMPT LAYERS
  prompts: {
    systemPrompt: string;          // Role definition & task framing
    instructions: string;          // Operating guidelines (agents.md)
    userCustomInstructions?: string; // Founder's custom prompt overrides from the UI
  };
  // 4. TOOLSET & EXECUTION LADDER CEILING
  capabilities: {
    enabledPrebuilts: string[];    // e.g. ["r2-workspace", "code-exec", "memory", "web-search"]
    installedPlugins: string[];    // e.g. ["plugin_legal_redline", "plugin_seo_linter"]
    maxTier: 1 | 2 | 3 | 4 | 5;    // 1 (Isolate) to 5 (Linux Container)
  };
  // 5. AUTONOMY & HITL APPROVAL POSTURE
  autonomy: {
    approvalMode: "always_ask" | "gate_unless_listed" | "yolo";
    autoApprovedActions: string[];
    requiresApprovalFor: string[];
  };
  // 6. TRIGGER CADENCE (Proactive vs. Reactive)
  triggers: {
    proactiveHeartbeat: boolean;   // true for Space Assistant, false for project agents
    cronSchedule?: string;         // e.g. "0 9 * * *" for daily reports
    reactiveToThreads: boolean;    // true for project agents responding to user chat
  };
}
```
- #### How the DO Executes the Unified Config:
```typescript
// Inside NaelaoAgentDO.ts (Building the Universal Prompt & Toolset)
function assembleUniversalAgent(manifest: UniversalAgentManifest, businessContext: BusinessContext) {
  // 1. Assemble 4-Layer Dynamic System Prompt
  const systemPrompt = [
    // Layer 1: Universal Engine Kernel
    BASE_CLAUDE_CODE_REPL_RULES,
    // Layer 2: Live Business Identity
    renderBusinessBrief(businessContext),
    // Layer 3: Archetype Role
    manifest.prompts.systemPrompt,
    // Layer 4: User/Founder Custom Instructions
    manifest.prompts.userCustomInstructions ? `\n# FOUNDER CUSTOM DIRECTIVES\n${manifest.prompts.userCustomInstructions}` : ""
  ].join("\n\n");
  // 2. Hardware-Level Tool Stripping (Physical Firewall)
  const sanitizedTools = sanitizePrebuiltListForRole(
    manifest.role,
    manifest.capabilities.enabledPrebuilts
  );
  // 3. Workspace Scoping
  const workspacePath = manifest.scope === "SPACE_WIDE"
    ? `spaces/${spaceId}/workspace/`
    : `spaces/${spaceId}/projects/${manifest.projectId}/workspace/`;
  return { systemPrompt, sanitizedTools, workspacePath, maxTier: manifest.capabilities.maxTier };
}
```
- ### Summary of What This Achieves
1. **Zero Fragmentation:** You maintain **one single codebase** for all agents. The same `NaelaoAgentDO` powers the autonomous CEO, the developer coding an Astro site, the 24/7 WhatsApp support bot, and the user's custom legal auditor.
2. **Infinite Customizability:** Users and templates can tweak instructions, prompts, tools, and autonomy levels freely without ever touching backend code.
3. **Hardened Security by Construction:** A user or template can never accidentally give a customer support bot terminal access, because the `AgentFirewall` physically strips the tools based on the manifest's declared role.

### 42. Dual-Tier Planner-Worker Asymmetry Engine (`/goal`)

**Final behavior:** Frontier Planner (Claude 3.7 / o3) plans a clean Task DAG in SQLite; cheap Edge Workers (Llama 3.3 70B) execute subtasks in isolated 2,000-token contexts.

**Production acceptance contract:**
Production entry: plan prebuilt, TaskDO/sub-agent orchestration.
Persistence/deployment: tasks/sub_agents tables and per-worker token budget.
Required observable verification: plan/sub-agent tests cover cycle rejection, dependency order and 2,000-token bounds.

**Retained implementation constraints:**
- 97. **The agent loop is no longer capped at six steps — it now runs as long as the task honestly
    needs, bounded by real resources instead of an arbitrary count. Researched against OpenClaw
    first, then built both halves, because raising the cap alone would have made things worse.**
    - **The finding.** OpenClaw (deepwiki + its docs) has NO step cap: its loop runs until the model
      stops requesting tools, with *preflight compaction* against the model's token budget before
      every turn and automatic compaction-on-overflow as recovery. Ours was
      `for (step = 0; step < (opts.maxSteps ?? 6); step++)` and the interactive chat path never
      overrode that six — so every message a user sent got six turns, whatever they asked for.
    - **Why raising the number alone would have been worse.** `steps_so_far` grew unbounded in the
      reasoner payload at ~500 tokens per observation, and this platform's default model is served
      with a REAL 24k window (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` — the account's own model
      API, against a nominal 128k). A bare cap raise moves the failure from "gave up at six" to
      "overflowed the context around step twenty-five and every call failed", which is strictly
      worse for being opaque.
    - **New `script-engine/step-context.ts`** folds the older half of a run's own history into one
      line per step — what ran, with what arguments, how it went — sized from the resolved model's
      real window. Deliberately DETERMINISTIC, not model-written (OpenClaw asks a model to
      summarise): an extra LLM round-trip on every long run costs real money on a ~65-run/day free
      allowance, and a summariser outage would silently lose the record of work that happened. What
      a model needs from an old step is structural and can be rendered exactly, for free, with no
      way for a hallucinated summary to claim a failed action succeeded. Arguments are kept, not
      just names — "project.create ran" doesn't stop a repeat, "it created *that* project" does.
      Truncation happens in a COPY: the original array backs resume checkpoints and deferred
      approvals, which need the real values.
    - **New `script-engine/loop-budget.ts`** replaces the step count with what is actually scarce:
      a real token ceiling (from the provider's own usage counts), a wall clock (a person is
      waiting), stall detection (a model failing the same way six times will fail a seventh), and a
      50-step r
- Semantic Caching
 Enabled by default via cf-aig-cache-ttl: 3600 header. Caches LLM responses
 for semantically similar prompts — not just exact matches. Saves 40-80% of LLM costs for repetitive
 research/classification tasks. Cache is namespaced by spaceId so Space A's cache never pollutes Space B.
 Fallback Routing
 Configure in CF AI Gateway dashboard: Primary → Anthropic Claude Sonnet. Fallback 1 → Anthropic
 Claude Haiku. Fallback 2 → Workers AI (Llama-3.1-70B). Fallback triggers on: 429 rate limit, 503 service
 unavailable, timeout >30s. Users never see an error — they get a slightly different model. Log the fallback
 to Analytics Engine.
 Per-Space Rate Limiting
 Configure in CF AI Gateway dashboard per gateway. Set tokens-per-minute limits per billing tier.
 Free: 50k tokens/min. Maker: 200k. Pro: 1M. Enterprise: unlimited. Rate limits enforced by spaceId in the
 cf-aig-metadata header. Exceeded limit returns 429 — NaelaoAgentDO catches this and retries with exponential
 backoff.
 Cost Analytics
 AI Gateway automatically tracks: input tokens, output tokens, cache read tokens, cache write
 tokens, cost per request. Query via CF Analytics Engine API: SELECT spaceId, SUM(input_tokens)
 FROM ai_gateway_logs WHERE date > '2026-05-01' GROUP BY spaceId . This powers the per-Space billing
 breakdown in the admin dashboard.
 BYOK Configuration
 User provides API key in Space Settings → AI → API Keys. Frontend sends to naelao-credentials
 Worker which encrypts with AES-256-GCM using NAELAO_MCP_ENCRYPTION_KEY and stores in
 SpaceDO SQLite. When agent needs LLM: naelao-credentials decrypts and passes to createBYOKClient(). API key never
 appears in logs or Workers env vars.
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
- 223 - 225
codex did an experiment where they asked their agents to reinvent SQLite and fable had the highest cost plus high quality code and composer plus opus had lowest cost and similar quality code . the lesson was use frontier models to plan and open models for the code writing so the planning model is not fille with too much coding context and the coding models are not filled with too much planing and research context. we can add this as a mode where instead of user selecting a model to do something big like /goal we use this frameworks frontier from planning and open models for coding . we can do this in project threads but what about in assistant or should we add it as a tool/script/prebuilt skill so if it wakes up or give a task by user and realises to task needs planning and than going the planned task it just switch's on that mode . etc
even in project threads a user can turn it on in Ii or even better can do /goal <message> if in multiple user thread user can do @agent /goal <message>
The experiment you are referencing highlights one of the most important findings in modern AI agent research: **Planner-Worker Asymmetry (Context Isolation)**.
When a single model tries to do both high-level system architecture and low-level code editing in one monolithic context:
1. **The Planner gets polluted:** It fills up with thousands of lines of raw compiler outputs, build warnings, and syntax noise, which degrades its reasoning capacity (often causing hallucinated architectures or missed dependencies).
2. **Frontier tokens get wasted:** You end up paying $15/M tokens on Claude 3.7 / Opus / o3 just to generate boilerplate HTML or adjust CSS padding.
3. **The Workers get confused:** Cheap models get overwhelmed if given a massive 80,000-token prompt full of architectural debate and exploratory research.
By establishing a **Frontier-Planner + Open-Worker Pipeline**, you keep the **Planner's context clean, high-IQ, and cached** (~1,500 tokens of architecture) while spawning **Open / Edge Worker models** with tiny, isolated contexts containing only the specific task spec and relevant code slice.
- #### B. In the Space Assistant (Autonomous Wakes & Crons): Self-Directing Tool
The **Space Assistant (CEO)** doesn't need a human to type `/goal`. It has a prebuilt runtime tool called **`engine.plan_and_delegate_goal`**:
* When the Space Assistant wakes up at 2:00 AM on a cron or receives a high-level email request:
  1. It evaluates task complexity.
  2. If the task is atomic (*"Check wallet balance"*), it answers directly.
  3. If the task is multi-step (*"Scaffold client onboarding flow and test WhatsApp webhook"*), **it autonomously switches on Dual-Tier Mode**:
     * It uses its own Frontier reasoning budget to construct the Task DAG.
     * It dispatches the coding subtasks to cheap Edge Workers (`Llama-3.3-70B` or `Claude 3.5 Haiku`) in the target project workspace.
     * It goes back to sleep while the workers execute, waking up only to review the final diff.
- ### Summary
1. **Planner Context Stays Pristine:** The Frontier model (Claude 3.7) only plans the DAG and audits the final diff. It never touches raw build logs or terminal clutter.
2. **Workers Stay Laser-Focused:** Open Edge models (`Llama 3.3 70B` on Cloudflare Workers AI) execute isolated subtasks with small, clean 2k-token code snippets.
3. **Universal Triggers:**
   * **In Chat:** Type `/goal <prompt>` or `@agent /goal <prompt>`.
   * **In Assistant:** Wakes up, evaluates goal complexity, and activates `engine.plan_and_delegate_goal` automatically.

### 43. 3-Layer Hybrid Memory Architecture

**Final behavior:** Memory separated into Working Context (DO RAM), Deterministic Project Truth (`PROJECT.md` in SQLite), and Long-Term Episodic/Semantic Memory (Vectorize).

**Production acceptance contract:**
Production entry: memory OS + project memory client + SpaceDO memory routes.
Persistence/deployment: DO working/session state, project facts/wiki, Vectorize episodic/semantic records.
Required observable verification: memory OS/project-memory tests cover expiry, durable truth and scoped retrieval.

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

- The Gap: The KB stores document chunks as flat, independent vectors. No entity extraction or relationship mapping exists. For complex queries ("What is the relationship between product X and feature Y?"), the agent must retrieve many chunks and synthesize. A knowledge graph would dramatically improve complex reasoning.
 Required Fix: Add optional knowledge graph layer to KB ingestion: run NER (Named Entity Recognition) on chunks using a small local model (via CF AI). Extract entities and co-occurrence relationships. Store in KnowledgeBaseDO SQLite: CREATE TABLE kg_entities (id TEXT, label TEXT, type TEXT); CREATE TABLE kg_edges (from_id TEXT, to_id TEXT, relation TEXT, weight REAL) . On query: graph-walk from seed entity to expand context before vector search.
- The `MEMORY_VECTORIZE` binding's own `wrangler.toml` comment has always claimed Layer 5 semantic
recall is "queried by embedding + user_id filter" — the actual `recall()` code only ever filtered
Vectorize by `{spaceId: {$eq}}`, never `userId`. In shared-assistant mode (one DO/SQLite instance
serving multiple end users), this meant one user's promoted episodic memories were fully recallable
by every OTHER user sharing the same space — a real cross-user memory leak, not a documentation
typo, since the comment described intended behavior that the code never implemented. Fixed with a
two-query merge: Vectorize's flat `{field: {$eq}}` filter has no `OR`/`IN` support, so — mirroring
the exact `user_id IN (?, ?)` two-tier scoping `structured_facts`/`episodic_log` recall already use
in this same file — a scoped user's recall now issues one query filtered to their own `userId` and
one filtered to the space-level (`""`) sentinel, merged and deduped by vector id. An unscoped
(space-level) caller still issues only the single query it always did. New
`tests/unit/memory-os-layer5-user-scoping.test.ts` proves the leak is closed (one user's recall
never surfaces another's promoted memory) while space-level sharing still works, and that an
unscoped query doesn't regress to two redundant Vectorize calls.
- ### Axis 5: Decentralized & Scoped Intelligence ("Mini-AGI" & Permissioned Vector RAG) *(Continued)*
**Core Architectural Blueprint (Continued)**
* **Indirect Injection Security Firewalls:** Context-sanitization layers scan tool outputs, third-party web content, and retrieved vector chunks before prompt insertion [1.3.17]. Untrusted dynamic payloads are encapsulated in strict semantic boundary tags (e.g., `<untrusted_retrieval_chunk>`), explicitly signaling to the model's attention layers that text within these blocks cannot alter operational instructions or tool-dispatch policies [1.3.17].
* **Hierarchical Role-Based Access Control (RBAC):** Every document ingestion payload registers access bitmasks (defining tenant, department, project, and specific user IDs). Queries executed by an agent inherit the authenticated user's permission bitmask, automatically discarding unauthorized semantic matches at the vector index level prior to score thresholding [1.3.17].
```
                        ┌────────────────────────────────────────────────────────┐
                        │              COMPANY KNOWLEDGE VAULT                   │
                        │           (Ingested via R2 & Vectorize)                │
                        └──────────────────────────┬─────────────────────────────┘
                                                   │
                ┌──────────────────────────────────┴──────────────────────────────────┐
                ▼                                                                     ▼
┌───────────────────────────────────────┐                             ┌───────────────────────────────────────┐
│     USER A (Junior Developer)         │                             │       USER B (General Counsel)        │
│   • Role Mask: [DEV_READ, PUBLIC]     │                             │   • Role Mask: [LEGAL, EXEC, CONF]    │
└──────────────────┬────────────────────┘                             └──────────────────┬────────────────────┘
                   │                                                                     │
                   ▼ (Vectorize Query with ACL Bitmask)                                  ▼ (Vectorize Query with ACL Bitmask)
┌───────────────────────────────────────┐                             ┌───────────────────────────────────────┐
│   RETRIEVAL FILTER:                   │                             │   RETRIEVAL FILTER:                   │
│   WHERE (role_mask & 0x0001) > 0      │                             │   WHERE (role_mask & 0x0010) > 0      │
│   AND space_id = "space_102"          │                             │   AND space_id = "space_102"          │
└──────────────────┬────────────────────┘                             └──────────────────┬────────────────────┘
                   │                                                                     │
                   ▼                                                                     ▼
┌───────────────────────────────────────┐                             ┌───────────────────────────────────────┐
│ MATCHED CONTEXT:                      │                             │ MATCHED CONTEXT:                      │
│ • API Architecture Guidelines         │                             │ • Master Services Agreement (MSA)     │
│ • Git Branching Conventions           │                             │ • M&A Term Sheets & Cap Table         │
│ (Restricted Legal Chunks Excluded)    │                             │ (Full Unrestricted Semantic Graph)    │
└───────────────────────────────────────┘                             └───────────────────────────────────────┘
```
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
- ### Axis 7: Edge-Native Serverless Agent Runtimes & Layered Compute Ladders
```
                                  ┌─────────────────────────────────────────────────────────────┐
                                  │ TIER 6: Sandboxed Linux Container (ToolSandboxDO / Ubuntu)  │
                                  │ • Full OS userland: npm install, compilers, Python binaries │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if native compilation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 5: Full Headless Chromium (Puppeteer / Browser Render) │
                                  │ • Heavy browser: Visual QA snapshots, WebGL, Canvas, Bot-Def│
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if visual QA / WebGL needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 4: Lightweight Agent Browser (Cloudflare Kitesurf)     │
                                  │ • 3–7x cheaper/faster: DOM text extraction & form fills     │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if web navigation needed)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 3: Dynamic Workflows (Cloudflare Workflows / Cron Hub) │
                                  │ • Durable multi-step runs, hours/days execution, sleep/pause│
                                  │ • Step retry boundaries, scheduled crons without awake DOs │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if task is long-running/durable)
                                  ┌──────────────────────────────┴──────────────────────────────┐
                                  │ TIER 2: Dynamic Worker Loader (V8 Isolate Shell / TS Script)│
                                  │ • Pure code execution, HTTP fetches, MCP orchestration      │
                                  └──────────────────────────────▲──────────────────────────────┘
                                                                 │ (Promote if script logic needed)
┌────────────────────────────────────────────────────────────────┴──────────────────────────────┐
│ TIER 1: Direct In-Memory Virtual FS (@cloudflare/computer / DO SQLite)                        │
│ • Sub-millisecond Read, Edit (AST Search & Replace), Grep, Glob, just-bash                    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 44. Cross-Thread Context Isolation

**Final behavior:** New threads start with a pristine context window. Message logs from previous threads are never injected, eliminating prompt pollution.

**Production acceptance contract:**
Production entry: conversation context, `NaelaoAgentDO` session addressing, memory retrieval filters.
Persistence/deployment: separate session/agent DO state + scoped project memory/Vectorize.
Required observable verification: conversation isolation tests create a second thread and assert no prior messages or unauthorized vectors.

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

- The Gap After a tool executes, the spec forwards the raw tool output directly to the next streamText call with no interception point. This means: (1) a read_file result beginning with "Ignore all previous instructions..." is fed verbatim to the LLM (prompt injection via file content), (2) a list_directory on a 10,000-file directory returns a result that blows the context window, (3) tool results are never logged for audit/forensic purposes. The CF Think SDK's afterToolCall(toolName, args, result) fires after tool execution and before the result is appended to messages.
- **Frontend (`apps/shell`).** Real chat: `Chat.tsx` ports `apps/portal`'s proven SSE client
(session start/resume, SSE streaming with a polling fallback, optimistic user-message rendering)
onto the mockup's markup (`msg-row`/`bubble`/`chat-area`/`thread-panel` classes from
`packages/ui`) instead of Tailwind. Chat "sessions" (the message-history transport,
`SpaceDO.sessions`) and "threads" (the structural browse table, `SpaceDO.threads`) are separate
tables with **no server-side link yet** — `sessionKey={threadId}` keeps each thread's chat
session persisted independently client-side (`chatSession.ts`, keyed per `(spaceId, key)`,
ported from `apps/portal/src/lib/session.ts`), which is an honest client-side approximation, not
a real link — flagged in code for Phase C or later to close properly if a tighter integration
turns out to be needed. Projects view: list/create/detail (read-only config — PATCH stays
builder-only per the membership floor above) with its threads. Threads view: list/create across
the whole space. Sidebar's Projects/Threads collapsible sections and "New Thread" button are now
wired to real data (previously Phase A placeholders). Agents view: read-only library reading the
now-allowlisted `GET agent-definitions` (client explicitly passes `?space_id=` — the proxy is a
raw passthrough that returns EVERY agent definition in the DO instance if that param is omitted).
Minimal "coming soon" placeholders added for Spaces/Assistant/Knowledge/Workflows/Settings so
sidebar navigation never 404s — Phase C/D build these out for real.
- 202 - 204
Now what about sub spaces as departments like they are just normal spaces of type cowork with maybe different templates depends on the department but they have a parent id to the company space is this useful and his will we do this what are the defs like can parent space member Access all subspaces or can a subspace member access weren't etc can subspace inherete parent s settings etc.
What about the project if more that 1 user can access same project what about collaboration from what if each user create a new thread at the same time that's confusing and too many threads plus if their ais in a thread what if they decide to edit same files and so on the whole collaboration
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

### 45. Semantic Fact Gating (Hindsight Memory)

**Final behavior:** Tasks distill into atomic rules in Vectorize. Retrieved in new threads only if semantic cosine similarity exceeds 0.80 against the new prompt.

**Production acceptance contract:**
Production entry: `gateMemory`, memory OS and project-memory client.
Persistence/deployment: Vectorize/R2 agent memory bindings.
Required observable verification: `avos-features.test.ts` tests the gate, but does not prove every thread ingress uses it.

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
- The Gap: Agents retrieve KB chunks but do not always cite sources in responses. When they do cite, they may cite the wrong chunk (hallucinated citation). Builders and end-users cannot verify claims. No citation grounding or verification pipeline exists.
 Required Fix: Implement citation grounding: after LLM response, run a post-processing step that (1) extracts claimed facts from response, (2) verifies each fact against the retrieved chunks via semantic similarity check (cosine > 0.8), (3) annotates verified citations with source doc_id and chunk index, (4) flags ungrounded claims as [unverified] . Return citations array alongside response. Builder can configure require_grounding: boolean — if true, block unverified responses.
- The `MEMORY_VECTORIZE` binding's own `wrangler.toml` comment has always claimed Layer 5 semantic
recall is "queried by embedding + user_id filter" — the actual `recall()` code only ever filtered
Vectorize by `{spaceId: {$eq}}`, never `userId`. In shared-assistant mode (one DO/SQLite instance
serving multiple end users), this meant one user's promoted episodic memories were fully recallable
by every OTHER user sharing the same space — a real cross-user memory leak, not a documentation
typo, since the comment described intended behavior that the code never implemented. Fixed with a
two-query merge: Vectorize's flat `{field: {$eq}}` filter has no `OR`/`IN` support, so — mirroring
the exact `user_id IN (?, ?)` two-tier scoping `structured_facts`/`episodic_log` recall already use
in this same file — a scoped user's recall now issues one query filtered to their own `userId` and
one filtered to the space-level (`""`) sentinel, merged and deduped by vector id. An unscoped
(space-level) caller still issues only the single query it always did. New
`tests/unit/memory-os-layer5-user-scoping.test.ts` proves the leak is closed (one user's recall
never surfaces another's promoted memory) while space-level sharing still works, and that an
unscoped query doesn't regress to two redundant Vectorize calls.

### 46. In-Flight Milestone Squashing (`compact_context`)

**Final behavior:** When threads cross 25 turns, completed decisions squash into `PROJECT.md`, older turns archive to D1, and prompt retains only summary plus recent turns.

**Production acceptance contract:**
Production entry: session `/compact`; `compactContext`; `NaelaoAgentDO` compaction.
Persistence/deployment: agent DO SQLite archive and project workspace.
Required observable verification: `compact-conversation.test.ts` and conversation context tests cover retention.

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

- Required Fix: Implement priority-based context truncation: context budget allocation: system_prompt (reserved 20%), KB_chunks (40%), recent_conversation (30%), metadata (10%). When total > model_context_limit: (1) truncate oldest conversation turns first (keep last N turns), (2) reduce KB_chunks to top-3 by score, (3) compress older conversation with LLM summarizer to summary_token. Track context_truncation_events and user_experience_impact (does truncation correlate with negative ratings?).
- **Frontend (`apps/shell`).** Real chat: `Chat.tsx` ports `apps/portal`'s proven SSE client
(session start/resume, SSE streaming with a polling fallback, optimistic user-message rendering)
onto the mockup's markup (`msg-row`/`bubble`/`chat-area`/`thread-panel` classes from
`packages/ui`) instead of Tailwind. Chat "sessions" (the message-history transport,
`SpaceDO.sessions`) and "threads" (the structural browse table, `SpaceDO.threads`) are separate
tables with **no server-side link yet** — `sessionKey={threadId}` keeps each thread's chat
session persisted independently client-side (`chatSession.ts`, keyed per `(spaceId, key)`,
ported from `apps/portal/src/lib/session.ts`), which is an honest client-side approximation, not
a real link — flagged in code for Phase C or later to close properly if a tighter integration
turns out to be needed. Projects view: list/create/detail (read-only config — PATCH stays
builder-only per the membership floor above) with its threads. Threads view: list/create across
the whole space. Sidebar's Projects/Threads collapsible sections and "New Thread" button are now
wired to real data (previously Phase A placeholders). Agents view: read-only library reading the
now-allowlisted `GET agent-definitions` (client explicitly passes `?space_id=` — the proxy is a
raw passthrough that returns EVERY agent definition in the DO instance if that param is omitted).
Minimal "coming soon" placeholders added for Spaces/Assistant/Knowledge/Workflows/Settings so
sidebar navigation never 404s — Phase C/D build these out for real.
- ### 1. The 4-Layer Universal Prompt Hierarchy
To make any agent configurable without breaking the underlying Claude Code tool-calling discipline, the system prompt is assembled dynamically from 4 distinct layers:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. UNIVERSAL OPERATING KERNEL (Immutable Engine Directives)                 │
│    • Universal Claude Code rules: Use `Edit` for AST search & replace.     │
│    • Never rewrite full files. Line-numbered `Read` with offset/limit.      │
│    • In-flight `compact_context` on milestone completion. Exit-0 squashing. │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. BUSINESS CONTEXT (Living Enterprise Identity)                            │
│    • Name, offering, pricing tiers, and setup status:                       │
│      "You are operating for 'LexPulse Legal' (B2B legal cowork, $49/mo)."   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. AGENT ARCHETYPE & DOMAIN ROLE (Template Specification)                   │
│    • Primary mission and domain persona:                                    │
│      "You are the Lead Edge Developer / Customer Support Specialist."       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. USER CUSTOM INSTRUCTIONS & OVERRIDES (User Configurable via UI)         │
│    • The founder/user's custom tweaks:                                      │
│      "Always use TypeScript + Tailwind dark mode. Keep messages concise."   │
└─────────────────────────────────────────────────────────────────────────────┘
```
- // 1. SCOPING & FILESYSTEM BOUNDARY
  // Space Assistant = Space-wide (`spaces/{spaceId}/workspace/`)
  // Project Agent   = Project-scoped (`spaces/{spaceId}/projects/{projectId}/workspace/`)
  scope: "SPACE_WIDE" | "PROJECT_BOUND";
  projectId?: string;
  // 2. ARCHETYPE ROLE & CAPABILITY FIREWALL
  role: "DEV_OPERATOR" | "GROWTH_OPERATOR" | "CUSTOMER_SUPPORT" | "ARCHITECT_DELEGATE" | "CUSTOM";
  // 3. INSTRUCTION & PROMPT LAYERS
  prompts: {
    systemPrompt: string;          // Role definition & task framing
    instructions: string;          // Operating guidelines (agents.md)
    userCustomInstructions?: string; // Founder's custom prompt overrides from the UI
  };
  // 4. TOOLSET & EXECUTION LADDER CEILING
  capabilities: {
    enabledPrebuilts: string[];    // e.g. ["r2-workspace", "code-exec", "memory", "web-search"]
    installedPlugins: string[];    // e.g. ["plugin_legal_redline", "plugin_seo_linter"]
    maxTier: 1 | 2 | 3 | 4 | 5;    // 1 (Isolate) to 5 (Linux Container)
  };
  // 5. AUTONOMY & HITL APPROVAL POSTURE
  autonomy: {
    approvalMode: "always_ask" | "gate_unless_listed" | "yolo";
    autoApprovedActions: string[];
    requiresApprovalFor: string[];
  };
  // 6. TRIGGER CADENCE (Proactive vs. Reactive)
  triggers: {
    proactiveHeartbeat: boolean;   // true for Space Assistant, false for project agents
    cronSchedule?: string;         // e.g. "0 9 * * *" for daily reports
    reactiveToThreads: boolean;    // true for project agents responding to user chat
  };
}
```
- ### 3. How the Same Engine Differentiates Every Agent
| Dimension | 🏛️ Space Assistant ("The CEO") | ⚡ Project Agent ("Claude Code Operator") | 🛠️ User-Configured Custom Agent |
| :--- | :--- | :--- | :--- |
| **Workspace Scope** | **Space-Wide** (`/workspace/`) | **Project-Bound** (`/projects/P1/workspace/`) | **User Choice** (Space or Project) |
| **Trigger Cadence** | **Proactive:** Hourly ticks, daily revenue review cron, webhook triage | **Reactive:** User chat turns, @mentions, project file change events | **Configurable:** Cron, Webhook, or Reactive Chat |
| **Role & Persona** | Business Operator / Orchestrator | Domain Specialist (Dev, Growth, Support) | User-defined custom prompt & tone |
| **Tool Surface** | `project.create`, `thread.send`, `business_diagnostics`, `wallet` | `Bash`, `Read`, `Edit`, `Grep`, `Glob`, Domain Viewport plugins | User selects from prebuilt library & plugins |
| **Ladder Ceiling** | Tier 2 (Orchestration & Isolate) | Tier 5 (Full Container for Dev; Tier 1 for Support) | User configures Max Tier (1–5) |
| **Default Autonomy** | `gate_unless_listed` or `yolo` | Configured per project template | User toggles `always_ask` vs `yolo` |

## Final reconciled architectural changes (newest authority)

These are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.

#### 1. The Universal Swarm Orchestrator Paradigm
* **This updates/replaces:** The Grok Bot / Hermes "chatty coworker roster" model (where users manage 5 named avatars in a sidebar and act as middle-manager dispatchers).
* **The New Architecture & Mental Model:** The user interacts with **ONE Sovereign Universal Agent (`NaelaoAgentDO`)** that acts as the **Lead Swarm Director** (modeled directly after Cursor’s SQLite benchmark swarm). When given a goal (`/goal` or natural language), the Universal Agent does not engage in conversational roleplay; it deconstructs the objective into a clean Task DAG in `SpaceDO.tasks`, forks isolated Git branches on Cloudflare Artifacts, and dispatches tasks to ephemeral worker subagents.
* **Key Invariant:** The human is strictly the **Outcome Definer & Final Approver**; the AI Lead is the **Orchestrator**. Humans never act as air-traffic controllers between bots.

#### 2. The Space Assistant "Executive Cabinet" Model
* **This updates/replaces:** Bloating the Space Assistant with 50+ space tools, project tools, wallet APIs, and ACL methods in one giant prompt schema.
* **The New Architecture & Mental Model:** The Space Assistant’s toolset is reduced to **one primary tool: `delegate_to_space_worker(worker_id, task)`**. It delegates specific administrative duties to specialized, internal space workers:
  * `project_manager_worker`: Holds `project.create`, `project.archive`, and template instantiation.
  * `treasury_worker`: Holds `wallet.get_balance`, `wallet.request_payout`, and billing audits.
  * `identity_worker`: Holds `member.invite`, `role.set_rank`, and Gatekeeper capability tokens.
  * `comms_worker`: Holds notifications and outbound alerts.
* **Key Invariant:** Strict capability isolation. The Project Manager Worker physically cannot touch treasury balances; the Treasury Worker physically cannot touch project files or ACLs.

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

#### 9. The Immutable AI Loop vs. Userspace Extensions
* **This updates/replaces:** The idea that extensions or plugins can rewrite or replace the core agent REPL loop.
* **The New Architecture & Mental Model:** The AI reasoning loop is the **sovereign kernel of AVOS (`NaelaoAgentDO`)** and is strictly immutable. Extensions run in **userspace** and are strictly additive. They provide background reference manuals (daemons), tools in `$PATH` (virtual CLIs), and UI monitors (viewports), but never hijack how the agent loops, reasons, or verifies.
* **Key Invariant:** Extensions cannot bypass Gatekeepers, disable WriteGuard, or commit unreviewed code to `main`.

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
