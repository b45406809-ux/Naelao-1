# AVOS EVOLUTIONARY ARCHITECTURAL CHANGELOG
## Master List of Reconciled Upgrades, Transitions & Structural Shifts

This document serves as the **standalone architectural delta**. It details every major design shift made from the early exploratory files up to the finalized architecture, formatted as **explicit feature updates** detailing what was replaced, why it was changed, and how the new mental model operates.

---

### SECTION 1: AGENT TOPOLOGY & ORCHESTRATION SHIFTS

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

---

### SECTION 2: MULTI-WORKER SCALING, PROTOCOLS & GOVERNANCE

#### 5. One-to-Many Worker Assignment (The SR-EEO Protocol)
* **This updates/replaces:** Assigning a single task to exactly one worker sequentially.
* **The New Architecture & Mental Model:** Adopts the **Speculative Race with Early-Exit Oracle (SR-EEO)** protocol (grounded in Tencent’s *Agent Forest* and the *SEMAP* protocol). For critical tasks, the Orchestrator assigns a single task to $N$ parallel worker instances across isolated Cloudflare Artifacts branches (using different temperatures or prompt strategies).
* **Key Invariant (Early-Exit Circuit):** The moment Worker A satisfies the deterministic test oracle (`exitCode === 0`), **Workers B and C are immediately terminated via abort signals**, saving ~65% of potential token and credit waste. The winning branch is fast-forward merged to `main`.

#### 6. The Strict 3-Depth Delegation Ceiling
* **This updates/replaces:** Unbounded recursive agent delegation where agents spawn agents indefinitely.
* **The New Architecture & Mental Model:** Delegation depth is hard-capped at exactly 3:
  * **Depth 1 (Lead Orchestrator):** Space Assistant or Project Lead (`NaelaoAgentDO`).
  * **Depth 2 (Domain Sub-Planner):** Ephemeral workflow managing a major workstream (e.g. API refactor).
  * **Depth 3 (Leaf Execution Worker):** Single-task isolate performing AST patching or running a test.
* **Key Invariant:** Depth 3 leaf workers **physically lack the delegation tool** in their runtime SDK, making Depth 4 calls structurally impossible.

#### 7. The 5 Credit Defense Envelopes (Anti-Bankruptcy Shields)
* **This updates/replaces:** Unmetered swarm execution that risks burning a user's monthly credits on Day 1.
* **The New Architecture & Mental Model:** Five non-negotiable financial guardrails:
  1. *Model Tiering by Depth:* Depth 1 uses Frontier models (Claude 3.7/o3); Depth 2 uses cheap edge models (Llama 3.3 70B); Depth 3 uses **free edge models** (Qwen 2.5 Coder / Llama 3.2 3B in V8 at $0.00).
  2. *Task Escrow Holds:* Tasks reserve a maximum credit envelope upfront (e.g. 30 credits). If exceeded, the tree pauses and requests approval.
  3. *Plan-Based Parallelism Clamping:* $29 Starter plans run workers sequentially (no parallel races); Pro and Enterprise plans unlock multi-worker races.
  4. *Early-Exit Token Reclaim:* Kills competing workers the instant one passes the test oracle.
  5. *Daily Personal Budget Envelopes:* Clamps personal user assistants to max $3.00–$5.00/day from the shared corporate pool.

#### 8. Multi-Assistant Shared Space Collision Defense
* **This updates/replaces:** Chaotic multi-user spaces where Alice's assistant and Bob's assistant clash, duplicate work, and burn double credits.
* **The New Architecture & Mental Model:** Enforces a 4-point coordination suite in `SpaceDO` SQLite:
  * **Atomic Task Leases (`SpaceDO.tasks` CAS):** When an incident occurs, the first assistant to claim it wins an exclusive 15-minute lease; all sibling assistants abort immediately.
  * **Sibling Spectator Mode:** Non-claiming assistants observe, avoid duplicate execution, and offer to audit the active assistant's Pull Request.
  * **Semantic Intent Deduplication Gate:** An incoming prompt with $>0.85$ cosine similarity to an active task links the user to the existing branch instead of building it twice.
  * **Sponsor Alignment RFC Gate:** Contradictory architectural orders freeze execution and surface an RFC discussion card in the Team Room before code is touched.

---

### SECTION 3: EXTENSIONS, DAEMONS & CUSTOM WORKFLOWS

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

---

### SECTION 4: INTEGRATIONS, CONNECTORS & SECURITY

#### 13. Decoupled Logical Connector Aliasing
* **This updates/replaces:** Hardcoding physical account names (e.g. `leads@company.com`) inside automation scripts.
* **The New Architecture & Mental Model:** Code references abstract semantic aliases (e.g. `ctx.connectors.use("inbound_mail")`). A dynamic binding table in `SpaceDO` maps that alias to an active physical account (Company Gmail vs. Personal Gmail).
* **Key Invariant:** Switching connected accounts in the UI re-binds the alias instantly without modifying a single line of application source code.

#### 14. Pluggable Space-Shared Calendar Connector (`primary_calendar`)
* **This updates/replaces:** The isolated, hardcoded SQLite calendar table silo in `SpaceDO`.
* **The New Architecture & Mental Model:** The calendar is formalized as a standardized, pluggable **Space-Shared MCP Connector** (`ctx.connectors.use("primary_calendar")`). Spaces bind to Google Workspace, Microsoft 365, CalDAV, or an Edge SQLite Fallback.
* **Key Invariant (Edge Slot-Hold Mutex):** Voice agents acquire a 15-second reservation lock in `ConcurrencyDO` before calling external calendar APIs, eliminating double-booking race conditions during call spikes.

#### 15. Dual-Plane Customer Bot Architecture
* **This updates/replaces:** Exposing main project agents directly to public chat channels or phone lines.
* **The New Architecture & Mental Model:** Main project agents are strictly internal software/support ops architects. Outside customers on WhatsApp, Telegram, or phone lines communicate exclusively with **quarantined, ephemeral Dynamic Workflow Subagents** using a restricted `CustomerBotContext`.
* **Key Invariant:** Customer bots have zero access to `Bash`, file-editing tools, Git Artifacts, or internal vault credentials, making prompt injection attacks against the infrastructure impossible.

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

---

### SECTION 5: DELIVERABLES, DATA & USER EXPERIENCE

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

---

### Summary Checklist of System Evolution

```
┌──────────────────────────────────────┬──────────────────────────────────────┐
│ Earlier Concept                      │ Final Reconciled Architecture        │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ ❌ Chatty bot personas in a sidebar   │ 🟢 **Sovereign Universal Lead +      │
│    (Human acts as middle-manager)    │    Ephemeral Subagents (Outcomes)**  │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ ❌ Space Assistant holds 50+ tools   │ 🟢 **Executive Cabinet Workers       │
│    (Massive tool schema bloat)       │    (Isolated functional boundaries)**│
├──────────────────────────────────────┼──────────────────────────────────────┤
│ ❌ All subagents are Dynamic Workflows│ 🟢 **Fast DO Actors for Prebuilts /   │
│    (Multi-second scheduling latency) │    Workflows for Custom Dev Sagas**  │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ ❌ Extensions can rewrite AI loop    │ 🟢 **Immutable Kernel Loop +         │
│    (Dangerous security & runaway)    │    Userspace Sandboxed Daemons**     │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ ❌ Hardcoded SQLite calendar table   │ 🟢 **Pluggable Space-Shared Calendar │
│    (Isolated from Google/Outlook)    │    Connector (`primary_calendar`)**  │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ ❌ Git is only for source code       │ 🟢 **`/workspace/` is for any        │
│                                      │    Deliverable (Excel, Docs, Data)** │
└──────────────────────────────────────┴──────────────────────────────────────┘
```
