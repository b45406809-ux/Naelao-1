# AVOS EVOLUTIONARY CHANGELOG (PART 2)
## Architectural Expansions, Edge Decisions & Sovereign Venture Subsystems

This changelog records all architectural additions, refinements, and reconciliations established **after the initial changelog**. It documents the transition from a developer-focused workflow into a **complete, self-hosting enterprise operating system** powered by System 1 edge decisions, unified runtime scoping, and all-in-one venture infrastructure.

---

### SECTION 1: EDGE DECISION LAYER & TWO-BRAIN COGNITION

#### 1. Jev AI Edge Decision Sentry (System 1 vs. System 2 Integration)
* **This updates/replaces:** Burning expensive, high-latency generative LLM calls (Claude 3.7 / Gemini Flash at 1,500ms–3,000ms) just to make simple categorical, boolean, or routing decisions.
* **The New Architecture & Mental Model:** Integrates **Jev AI** as the platform’s dedicated **"System 1" non-autoregressive decision engine**. Jev generates zero prose; it reads state and returns typed probabilistic answers (`Choice` for classification, `Score` for numerical rating, and `Noul` for Yes/No confidence) in **70ms to 250ms at $0.042 per million input tokens (with free output tokens)**. Generative frontier models (System 2) are invoked *only* when actual code writing, text synthesis, or deep reasoning is required.
* **Key Invariant:** System 1 decision calls never produce conversational text, eliminating output formatting hallucinations and slashing internal routing latency by 85%.

#### 2. Jev AI-Powered WriteGuard & Gatekeeper Firewall
* **This updates/replaces:** Brittle regex patterns or slow generative LLM evaluations for checking if an agent’s terminal command or SQL query is destructive.
* **The New Architecture & Mental Model:** Before any command runs in `Bash` or any SQL query hits a database, WriteGuard passes the payload to Jev AI. Jev answers `is_destructive_or_exfiltration: Noul` in 80 milliseconds. If the probability exceeds 0.85, the command is intercepted and aborted before execution.
* **Key Invariant:** Destructive mutations (`DROP TABLE`, `DELETE *`, `rm -rf /`) are blocked deterministically at the edge proxy layer regardless of prompt injection framing.

#### 3. Sub-Second Customer Triage & Emergency Escalation
* **This updates/replaces:** Waking full Dynamic Workflows or large LLMs to parse incoming customer messages for urgency.
* **The New Architecture & Mental Model:** Inbound WhatsApp/Telegram customer messages pass through Jev AI at the edge router. In 90ms, Jev categorizes intent (`Choice`), scores customer frustration (`Score` 1–10), and flags life-safety or legal emergencies (`Noul`). High-urgency events bypass queues and immediately alert the business owner’s phone via the Executive Copilot channel.
* **Key Invariant:** Emergency customer escalations trigger immediate human alerts without waiting for batch queues.

---

### SECTION 2: RUNTIME HYPERVISOR, WEBCONTAINERS & CONTEXT OPTIMIZATION

#### 4. The Unified Container Tier (WebContainer as a Tier 6 Backend)
* **This updates/replaces:** Creating an awkward "Tier 0" that complicated the 6-tier execution ladder.
* **The New Architecture & Mental Model:** Preserves the clean **6-Tier Ladder** by housing **In-Browser WebContainers as a pluggable backend inside Tier 6 (Container & Full-System Runtime)**. Tier 6 now offers three interchangeable backends:
  * *Backend A (Client WebContainer):* Runs Node.js/Vite inside the client's browser tab via WebAssembly for $0.00 cloud compute.
  * *Backend B (Cloudflare Container):* Runs Docker/Ubuntu serverlessly at the edge for heavy compilers and native Linux binaries.
  * *Backend C (Local Workstation):* Runs on the client's physical GPU/server via `LocalTunnelDO`.
* **Key Invariant:** The AI sees only standard `Bash`; the platform hypervisor routes to the browser or cloud container invisibly.

#### 5. Automated Transport Failover (The "No AI Plumbing" Invariant)
* **This updates/replaces:** Requiring the AI model to detect WebSocket disconnects, browser tab sleeping, or manually manage container spin-ups.
* **The New Architecture & Mental Model:** Network state is treated as an infrastructure event, not an AI reasoning task. If a user locks their phone or closes their browser tab mid-task, the **Runtime Hypervisor** detects socket termination and **automatically migrates the execution to a Cloudflare Container** in 200ms. Jev AI acts as a pre-flight validator, predicting whether a command will exceed browser mobile RAM before execution.
* **Key Invariant:** The AI is never prompted with network connection state; the runtime ensures uninterrupted command execution.

#### 6. AWS Strands Context Optimization (1,500-Token Truncation & 85% Compaction)
* **This updates/replaces:** Dumping massive terminal outputs into conversational context and waiting until 100% context capacity to trigger emergency summarization.
* **The New Architecture & Mental Model:** Adopts the context-engineering techniques from the AWS Strands Harness:
  * *Tool Output Offloading:* Any tool stdout/stderr exceeding ~1,500 tokens is truncated, summarized, and saved to `/.avos/tmp/tool_out_*.log`.
  * *85% Proactive Compaction:* Milestone squashing triggers precisely at 85% context utilization, preventing context-length crashes.
  * *In-Loop Recovery:* Unexpected token overflows trigger an immediate recovery step that evicts older tool results and retries within the same turn.
* **Key Invariant:** Active conversational context is kept strictly below 85% capacity, reducing token burn by 28%–45%.

#### 7. Dynamic JIT Steering Handlers
* **This updates/replaces:** Stuffing 50 conditional rules and formatting instructions into a monolithic 30,000-token system prompt.
* **The New Architecture & Mental Model:** Uses ephemeral **Steering Handlers**. When an agent calls an SQL tool or a billing API, the harness injects a single-turn micro-directive for that turn only (e.g., *"Steering: Enforce atomic CAS; format amounts as integer cents"*). The instruction dissolves immediately upon completion.
* **Key Invariant:** System prompts remain under 500 words; domain rules are injected strictly on demand.

---

### SECTION 3: MIGRATION HANDSHAKES, VISION PERCEPTION & CONFORMANCE

#### 8. The WebContainer $\leftrightarrow$ Cloudflare Container State Migration Protocol
* **This updates/replaces:** Attempting to synchronize fragile `node_modules` folders or binary artifacts between browser memory and Linux servers.
* **The New Architecture & Mental Model:** Enforces that **`package.json` and `package-lock.json` in DO SQLite VFS are the sole source of truth**. Physical `node_modules` are never synced over the network. When a build escalates from a phone's browser to Cloudflare:
  1. The browser dev server process receives an automated `SIGTERM`.
  2. The Cloudflare Container boots over ArtifactFS FUSE in 200ms.
  3. The container restores dependencies via Cloudflare's internal edge npm package mirror in under 2.5 seconds.
  4. The preview iframe automatically swaps from `localhost:3000` to the edge tunnel URL.
* **Key Invariant:** `node_modules` remains strictly local to the active environment; lockfiles govern all cross-tier consistency.

#### 9. Decoupled On-Demand Terminal Vision (`see` CLI)
* **This updates/replaces:** Automatically dumping full-resolution 1280x800 screenshots (1,600+ vision tokens) into the context window after every browser action.
* **The New Architecture & Mental Model:** Separates text navigation from visual inspection. By default, `browse` returns a compact accessibility tree (AXTree) in text (<300 tokens) and saves the screenshot to disk. The agent uses the **`see [path]`** CLI command only when visual layout, CSS styling, or chart inspection is strictly necessary.
* **Key Invariant:** Visual tokens are injected into context only when the agent explicitly commands visual perception, cutting vision token spend by 80%.

#### 10. The 6-Tier Conformance Test Suite (`harness/conformance/`)
* **This updates/replaces:** Assuming a foundation model can handle all execution tiers without benchmarking its failure modes.
* **The New Architecture & Mental Model:** An automated test harness benchmarking models across AST patch precision (Tier 1), isolate sandbox execution (Tier 2), workflow step serialization (Tier 3), dynamic SPA hydration (Tier 4/5), and non-interactive container process management (Tier 6).
* **Key Invariant:** Any model scoring below 90% accuracy on surgical AST edits is barred from acting as an autonomous dev operator.

#### 11. Domain-Specialized Workers (Rejecting Tier Specialization)
* **This updates/replaces:** The anti-pattern of creating "Tier 1 Workers" and "Tier 6 Workers" (forcing 3 agents to coordinate just to edit and test a file).
* **The New Architecture & Mental Model:** Workers are strictly **Domain-Specialized** (`@DevWorker`, `@LegalWorker`, `@ReviewWorker`). Each domain worker owns its task end-to-end and has access to the full 6-tier ladder as its internal toolbox. The Planner manages the Task DAG, never the hardware tiers.
* **Key Invariant:** A task is never handed off between agents merely because execution moved from an isolate to a container.

---

### SECTION 4: ENTERPRISE VENTURE ORGANS & REPLACING THIRD-PARTY SAAS

#### 12. The Jev AI Quantitative Trading Desk & RiskGuard (`kind: "quant_desk"`)
* **This updates/replaces:** Allowing LLMs to execute financial orders or trading strategies via unvalidated text outputs.
* **The New Architecture & Mental Model:** Financial and algorithmic ventures execute on a dedicated trading desk backed by `RiskGuardDO`. Strategies are formulated by LLMs but evaluated on historical data in R2 by a deterministic backtesting oracle. Live orders pass through Jev AI to verify drawdown boundaries and score market risk in 70ms before reaching broker APIs via Outbound Workers.
* **Key Invariant:** Hard stop-losses and position limits are mathematically enforced in SQLite; LLM prompts cannot override the risk engine.

#### 13. Mobile Emergency Kill-Switch (`STOP` Protocol)
* **This updates/replaces:** Requiring a user to log into an administrative web dashboard to halt a misbehaving or losing business.
* **The New Architecture & Mental Model:** The business owner can text `STOP` or `PANIC` to their WhatsApp/Telegram Executive Copilot at any time. This triggers an immediate, atomic platform freeze: all active workflows terminate, outbound API calls block, and open trading positions liquidate to cash within 500 milliseconds.
* **Key Invariant:** The emergency halt is a hardware-priority interrupt that bypasses all agent reasoning loops.

#### 14. The Double-Entry General Ledger Daemon (`ledger_core`) — *Replaces QuickBooks*
* **This updates/replaces:** Exporting CSVs to third-party accounting software or using spreadsheets for financial truth.
* **The New Architecture & Mental Model:** A background Durable Daemon with a private DO Facet SQLite database maintaining double-entry debit and credit lines ($\text{Assets} = \text{Liabilities} + \text{Equity}$). Reconciles Stripe charges, container compute costs, and partner payouts nightly via automated workflows.
* **Key Invariant:** Balanced accounting ledger lines are immutable; balances cannot be altered without a corresponding journal entry.

#### 15. The Native CRM & Pipeline State Machine (`crm_core`) — *Replaces Salesforce*
* **This updates/replaces:** Storing sales leads in third-party CRMs and paying per-seat subscriptions.
* **The New Architecture & Mental Model:** A native contact state graph in SQLite supporting customizable deal stages (`Lead` $\rightarrow$ `Proposal` $\rightarrow$ `Won`). Features 70ms Jev AI lead scoring and triggers automated contract generation when deals advance to closing.
* **Key Invariant:** Customer relationship data remains self-contained within the space’s encrypted database.

#### 16. The Cryptographic E-Signature Plane (`esign_core`) — *Replaces DocuSign*
* **This updates/replaces:** Redirecting clients to external e-sign portals and paying per-envelope fees.
* **The New Architecture & Mental Model:** Generates single-use signing links for contracts finalized in `doc_studio`. Computes SHA-256 hashes of document bytes, captures touch signatures on mobile browsers, and appends an immutable PDF audit certificate committed directly to Cloudflare Artifacts.
* **Key Invariant:** Finalized signed contracts generate cryptographic proof of execution with zero external vendor dependencies.

#### 17. The Omnichannel Support Inbox (`omnichannel_inbox`) — *Replaces Zendesk*
* **This updates/replaces:** Fragmented communication tools across email, WhatsApp, and Telegram.
* **The New Architecture & Mental Model:** A unified conversation engine in `SpaceDO` SQLite that links disparate channel identifiers (phone number, email, handle) to a single customer profile. Quarantined subagents draft replies; human operators approve with one click.
* **Key Invariant:** Cross-channel customer interactions merge into a single chronological timeline.

#### 18. Automated Payroll & Contractor Payout Rails (`payroll_core`) — *Replaces Gusto*
* **This updates/replaces:** Manually processing monthly contractor invoices and developer partner royalties.
* **The New Architecture & Mental Model:** Scheduled Class 1 Dynamic Workflows reading from the immutable `developer_earnings_ledger`. Dispatches automated bank transfers via Stripe Connect or ACH on the 1st of each month and records balanced debits in the General Ledger.
* **Key Invariant:** Payouts execute only against cryptographically verified ledger balances.

---

### SECTION 5: ARCHITECTURAL PURITY & THE FOUNDRY ENGINE

#### 19. The Self-Hosting (Homoiconic) Developer Foundry (`tpl_dev_foundry_v1`)
* **This updates/replaces:** Maintaining two separate frontend applications (`apps/shell` for clients and `apps/partner-studio` for developers).
* **The New Architecture & Mental Model:** The developer portal is not an external website; it is an **AVOS Space Template (`tpl_dev_foundry_v1`) running inside the standard shell**. Developers use the platform to build the platform: authoring extensions, running conformance test suites, inspecting SQLite schemas, and tracking 40% royalties in a unified workspace.
* **Key Invariant:** The platform maintains exactly one frontend shell codebase; developer and client experiences differ only by the loaded space blueprint.

#### 20. Universal State Scoping & Actor ID Resolution
* **This updates/replaces:** Ambiguous database sharing where micro-apps had no structured way to share state across projects.
* **The New Architecture & Mental Model:** Scope is formalized as the **physical Actor ID derivation formula**. When an app, connector, or workflow declares its scope, it mounts a deterministic Durable Object partition:
  * `SPACE_WIDE`: `idFromName("gadget:" + appId + ":space:" + spaceId)` (Single shared DB across all projects).
  * `PROJECT_BOUND`: `idFromName("gadget:" + appId + ":project:" + projectId)` (Isolated to 1 project).
  * `USER_PRIVATE`: `idFromName("gadget:" + appId + ":space:" + spaceId + ":user:" + userId)` (Personal sandbox).
* **Key Invariant:** A lead acquisition project and a customer service project mount the exact same `SPACE_WIDE` CRM database simultaneously with zero data-sync latency.

#### 21. Strictly Hierarchical 1-Space = 1-Assistant Topology
* **This updates/replaces:** Creating multiple uncoordinated floating assistants inside a single flat space.
* **The New Architecture & Mental Model:** Replaces bot chaos with corporate hierarchy: **Exactly One Assistant per Space or Sub-Space**. The Parent Space Assistant acts as the CEO/Chief of Staff; Sub-Space Assistants act as Department Directors (VP Legal, VP Eng) managing local projects. Cross-department work is delegated via Gatekeeper capability tokens.
* **Key Invariant:** Users never manage a list of unassigned assistants; assistants map 1-to-1 with organizational security boundaries.

---

### Summary of the Expanded Architecture

```
┌──────────────────────────────────────┬──────────────────────────────────────┐
│ Prior State                          │ Final Reconciled State               │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ Slow LLMs evaluating routine checks  │ ⚡ **System 1 Jev AI (70ms decisions)│
│                                      │    for WriteGuard, routing & triage**│
├──────────────────────────────────────┼──────────────────────────────────────┤
│ Separate "Tier 0" WebContainer       │ 🌐 **WebContainer as a sub-backend   │
│                                      │    inside Tier 6 Container Runtime** │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ Context bloat from terminal stdout   │ ✂️ **AWS Strands 1,500-token cutoff  │
│                                      │    & on-demand `see` vision CLI**    │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ External SaaS dependencies           │ 💼 **Native Ledger, CRM, E-Sign,     │
│ (QuickBooks, DocuSign, Zendesk)      │    and Omnichannel Inbox engines**   │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ Two separate frontends (Dev vs User) │ 🔄 **Homoiconic Dev Foundry Template │
│                                      │    running inside single shell**     │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ Floating assistants in a flat space  │ 🏛️ **Hierarchical 1-Space = 1-Asst   │
│                                      │    Executive Chain of Command**      │
└──────────────────────────────────────┴──────────────────────────────────────┘
```
