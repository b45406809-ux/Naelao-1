
---

# AVOS EVOLUTIONARY CHANGELOG (PART 2 — COMPLETE & UNABRIDGED)
## The Terminal-Native, Self-Extending Edge Operating System

---

### SECTION 1: THE ALL-CLI PARADIGM & VIRTUAL `$PATH` EXTENSIBILITY

#### 1. The All-CLI Single Terminal Action Space
* **This updates/replaces:** Fragmented JSON tool declarations in the prompt (`exec_sqlite_fs`, `exec_isolate_codemode`, `exec_workflow`, `exec_container_bash`).
* **The New Architecture & Mental Model:** The AI's tool surface is collapsed into **one primary execution tool: `Bash(command)`** (complemented only by high-precision surgical `Read` and `Edit`). All system capabilities, cloud APIs, database engines, and compilers exist as standard executable commands in the agent's virtual `$PATH`. The AI works in a single Unix shell environment, allowing it to compose pipelines with standard pipes (`|`), redirections (`>`), and environment variables in a single turn.
* **Key Invariant:** The AI prompt never lists 6 separate execution tools. It sees only `Bash`, `Read`, and `Edit`.

#### 2. Self-Extending `$PATH` via `/.avos/bin/`
* **This updates/replaces:** Requiring developers or agents to register tools via complex JSON schema registration APIs or MCP server config files.
* **The New Architecture & Mental Model:** The virtual shell automatically mounts `/.avos/bin/` as the highest-priority directory in the agent's `$PATH`. When the AI needs a reusable automation or custom tool:
  1. It writes a standard TypeScript script to `/.avos/bin/<command-name>.ts`.
  2. It marks it executable: `chmod +x /.avos/bin/<command-name>`.
  3. The command is **immediately live in `$PATH` across the entire project**.
* **Underlying Execution:** When the AI invokes that command, the runtime loads the `.ts` file into a **Tier 2 V8 Isolate in sub-5ms**, injects the universal `ctx` SDK, and streams stdout/stderr back into the terminal.
* **Key Invariant:** Any executable file in `/.avos/bin/` is instantly callable by name without rebooting the agent or updating system prompts.

#### 3. Scoped Command Namespaces (`avos chore`, `ext:`, `auto:`)
* **This updates/replaces:** Unorganized, flat command names where agents confuse internal maintenance tasks with company operations.
* **The New Architecture & Mental Model:** The virtual terminal groups commands into three explicit namespaces:
  * **`avos chore <name>`:** Internal agent housekeeping (e.g., `avos chore repomix-pack`, `avos chore compact-memory`).
  * **`ext:<extension_name> <command>`:** Domain extensions and background daemons (e.g., `ext:tree-sitter query <symbol>`, `ext:ledger audit`).
  * **`auto:<automation_name> [trigger|status|pause]`:** Company operational pipelines (e.g., `auto:stripe-sync trigger`).
* **Key Invariant:** The AI uses the namespace prefixes to disambiguate between modifying internal agent state vs. running company business operations.

---

### SECTION 2: THE INVISIBLE RUNTIME HYPERVISOR & AUTO-ROUTING

#### 4. Automated Tier Routing Under `Bash` (The Invisible Hypervisor)
* **This updates/replaces:** Forcing the LLM to choose which compute tier to run its commands in.
* **The New Architecture & Mental Model:** The AI simply writes standard bash commands. The **Cloudflare Runtime Hypervisor** inside `NaelaoAgentDO` intercepts the command string and routes it automatically:
  * *POSIX Utilities (`grep`, `cat`, `sed`, `awk`, `find`, `jq`, `diff`):* Routed to **Tier 1/2 V8 Isolates** via `just-bash` against DO SQLite (<2ms, $0.0001).
  * *Cloud API CLIs (`stripe`, `gh`, `r2`, `resend`, `twilio`):* Routed to **Tier 2 Virtual CLI Shims** executing edge REST fetches with Vault tokens injected (<50ms).
  * *Script Execution (`node script.ts`, `python3 -c "..."`):* Routed to **Tier 2 V8 Isolates** (running JS natively or Python via in-memory Pyodide Wasm).
  * *Web Browsing (`browse <url>`):* Routed to **Tier 4 Kitesurf** (<200ms).
  * *Native Compilations (`npm run build`, `cargo`, `docker`):* Routed to **Tier 6 Containers** via persistent gRPC over ArtifactFS FUSE.
* **Key Invariant:** The AI never chooses a tier. It runs standard bash; the hypervisor routes to the cheapest capable tier invisibly.

#### 5. Pre-Flight Capability Checks via Jev AI
* **This updates/replaces:** Running a heavy command in an isolate, watching it crash due to missing native libraries, and retrying in a container.
* **The New Architecture & Mental Model:** Before `Bash` executes, **Jev AI (System 1)** evaluates the command string in 70ms:
  * Evaluation: `requires_native_linux_compilation: Noul(Yes/No)`.
  * If a command contains native build tools (e.g. `npm install @tensorflow/tfjs-node` or `cargo build`), Jev flags it as native. The hypervisor bypasses V8 and routes directly to the Tier 6 Linux Container upfront.
* **Key Invariant:** Commands that require native Linux compilers never attempt execution in V8 isolates first.

#### 6. The "Two Languages, One SDK" Convergence
* **This updates/replaces:** Requiring the AI to learn 4 different proprietary programming languages for workers, workflows, browsers, and containers.
* **The New Architecture & Mental Model:** The AI only speaks **Bash** (for triggering commands and pipelines) and **TypeScript** (for writing all logic, tools, and workflows). Every tier exposes the identical **`@avos/runtime` (`ctx`) SDK**:
  * An ephemeral script in a Tier 2 Worker uses: `run(ctx)`.
  * A durable pipeline in a Tier 3 Workflow uses: `execute(step, ctx)`.
  * The only difference is whether the script needs `step.sleep()` or durable retries.
* **Key Invariant:** The AI never learns custom workflow boilerplate or container daemon protocols. Everything is standard TypeScript with `ctx`.

---

### SECTION 3: WORKFLOW EXECUTION COMMANDS & CONTEXT HANDLING

#### 7. Terminal Workflow Execution Commands (`schedule` & `workflow run`)
* **This updates/replaces:** Invoking workflows through complex SDK calls or background webhook configurations.
* **The New Architecture & Mental Model:** The virtual shell provides two native terminal commands to manage Cloudflare Workflows:
  * **`workflow run <script_path> [--detach]`:** Dispatches an immediate, asynchronous execution of a Tier 3 Dynamic Workflow. If `--detach` is passed, the terminal yields immediately with a run ID, and the workflow executes in the background.
  * **`schedule --cron "<cron_expression>" <script_path>`:** Registers a persistent cron in `SpaceDO.project_scheduled_jobs`. The platform compiler wraps the script into a Cloudflare `WorkflowEntrypoint` and arms the trigger.
* **Key Invariant:** Background workflows execute asynchronously and never block the user's interactive terminal turn.

#### 8. Compact Background Job Receipt Cards
* **This updates/replaces:** Background crons dumping 50 lines of stdout/stderr into the active chat thread.
* **The New Architecture & Mental Model:** When a scheduled cron or detached workflow completes, it emits an event over `WsHubDO`. The thread renders an inline **2-line expandable Receipt Card**:
  `[ ⏰ Background Cron: @DevOperator | Status: 🟢 0 Vulnerabilities | [View Full R2 Logs] [Inspect Diff] ]`
* **Key Invariant:** Verbose terminal logs are stored in Cloudflare R2; the chat feed receives only a compact status summary.

#### 9. Decoupled Context for Workflows & Crons
* **This updates/replaces:** Waking background crons inside an active chat thread and loading 50 historical messages into context.
* **The New Architecture & Mental Model:** Workflows execute in **pristine contexts (<2,000 tokens)**. They load only their task payload, relevant workspace files, and `SOUL.md`. They inherit zero chat history from the thread where they were scheduled.
* **Key Invariant:** Running a midnight cron costs fractions of a cent and never suffers from conversational context pollution.

#### 10. Decoupled On-Demand Terminal Vision (`see` CLI)
* **This updates/replaces:** Dumping a 1280x800 screenshot (1,600+ vision tokens) into the context window after every browser action.
* **The New Architecture & Mental Model:** By default, `browse <url>` outputs clean accessibility text (<300 tokens) and saves the PNG to disk. The agent uses the **`see [path]`** CLI command only when visual layout, CSS styling, or chart verification is required:
  * `see latest`: Injects the most recent screenshot into the vision context.
  * `see --crop "x,y,w,h"`: Crops to a specific bounding box, saving 75% of vision tokens.
* **Key Invariant:** Visual tokens enter the context window only when the agent explicitly runs `see`.

---

### SECTION 4: CONTAINER SUB-BACKENDS & STATE MIGRATION

#### 11. Tier 6 Container Backends (WebContainer, Cloudflare Container, Local Workstation)
* **This updates/replaces:** Creating an artificial "Tier 0" WebContainer that complicated the 6-tier ladder.
* **The New Architecture & Mental Model:** Tier 6 represents the **Container & Full-System Runtime**, offering three interchangeable backends:
  * *Backend A (Client WebContainer):* Runs Node.js and Vite dev servers in the user's browser tab via Wasm for **$0.00 cloud compute**.
  * *Backend B (Cloudflare Container):* Serverless Docker/Ubuntu at the edge mounted over ArtifactFS FUSE for native compilers and Xvfb GUI automation.
  * *Backend C (Local Workstation):* Physical on-premise GPUs/servers via `LocalTunnelDO`.
* **Key Invariant:** The AI sees standard `Bash`; the hypervisor selects the appropriate backend automatically.

#### 12. The WebContainer $\leftrightarrow$ Cloudflare Container State Migration Protocol
* **This updates/replaces:** Attempting to synchronize fragile `node_modules` folders or binary artifacts between browser memory and Linux servers.
* **The New Architecture & Mental Model:** 
  1. **Lockfiles are the Single Truth:** Only `package.json` and `package-lock.json` are committed to the DO SQLite Virtual Filesystem. Physical `node_modules` are never synced over the network.
  2. **Process Transfer Lease:** When execution escalates to a cloud container, the hypervisor sends a `SIGTERM` to the browser's WebContainer dev server.
  3. **Cloud Re-Hydration in 2 Seconds:** The Cloudflare Container boots over ArtifactFS FUSE and runs `npm ci` against Cloudflare’s **internal edge npm package mirror**, restoring dependencies in under 2.5 seconds.
  4. **Preview URL Redirect:** The live preview iframe automatically swaps from `localhost:3000` (browser ServiceWorker) to `https://preview.avos.dev/:id` (Cloudflare edge tunnel).
* **Key Invariant:** `node_modules` remains strictly local to the active environment; lockfiles govern cross-tier consistency.

#### 13. Automated Conformance Benchmark Suite (`harness/conformance/`)
* **This updates/replaces:** Assuming a foundation model can handle all execution tiers without benchmarking its failure modes.
* **The New Architecture & Mental Model:** An automated test harness benchmarking models across AST patch precision (Tier 1), isolate sandbox execution (Tier 2), workflow step serialization (Tier 3), dynamic SPA hydration (Tier 4/5), and non-interactive container process management (Tier 6).
* **Key Invariant:** Any model scoring below 90% accuracy on surgical AST edits is barred from acting as an autonomous dev operator.

---

### SECTION 5: FIRST-PARTY DOGFOODED EXTENSIONS & JEV AI SENTRIES

#### 14. The Microkernel Architecture (Core Substrate vs. Dogfooded Extensions)
* **This updates/replaces:** Hardcoding business software (General Ledgers, CRMs, E-Signatures, and Inboxes) directly into the platform core/kernel.
* **The New Architecture & Mental Model:** The AVOS core is strictly a **pure, unpolluted microkernel substrate** (compute ladder, VFS, Git Artifacts, Gatekeepers, `ctx` SDK). All enterprise business systems are built as **First-Party Dogfooded Extensions** using the exact same public primitives available to external developers: a DO Facet SQLite Database (Micro-App) + a Canvas Viewport + a Dynamic Workflow + an auto-generated MCP v2 `/mcp` interface.
* **Key Invariant:** The platform core team builds enterprise tools using the public extension specification, proving platform completeness and keeping the kernel 100% decoupled from business logic.

#### 15. The 6 Dogfooded Enterprise Extensions Suite
* **`ext_ledger_core` (General Ledger):** Replaces QuickBooks. Double-entry debit/credit lines in DO Facet SQLite (`ledger.sqlite`), balanced nightly via Class 1 Company Workflows.
* **`ext_crm_core` (Sales & Pipeline):** Replaces Salesforce. Kanban canvas viewport, SQLite contact graph, and 70ms Jev AI lead scoring.
* **`ext_esign_core` (E-Signatures):** Replaces DocuSign. SHA-256 PDF hashing, single-use mobile signing links, and cryptographic audit certificates committed to Git Artifacts.
* **`ext_omnichannel_inbox` (Customer Support):** Replaces Zendesk. Unified conversation timeline in SQLite merging WhatsApp, Telegram, and Email.
* **`ext_commerce_hub` (Storefront & Fulfillment):** Replaces Shopify. Edge SSR storefront on Cloudflare Pages, inventory in DO SQLite, automated shipping labels.
* **`ext_payroll_core` (Disbursements & Royalties):** Replaces Gusto. Monthly Class 1 Workflows disbursing partner royalties via Stripe Connect Payouts or ACH.
* **Key Invariant:** All 6 systems are 100% modular and swappable; a company can replace `ext_crm_core` with a legal-specific CRM without touching the kernel.

#### 16. The Jev AI Quantitative Trading Desk & RiskGuard (`kind: "quant_desk"`)
* **This updates/replaces:** Allowing LLMs to execute financial orders or trading strategies via unvalidated text outputs.
* **The New Architecture & Mental Model:** Built as a dedicated project kind backed by `RiskGuardDO`. Strategies are formulated by LLMs but evaluated on historical tick data in R2 by a deterministic backtesting oracle. Live orders pass through Jev AI to verify drawdown boundaries and score market risk in 70ms before reaching broker APIs via Outbound Workers.
* **Key Invariant:** Hard stop-losses and position limits are mathematically enforced in SQLite; LLM prompts cannot override the risk engine.

#### 17. Mobile Emergency Kill-Switch (`STOP` Protocol)
* **This updates/replaces:** Requiring a user to log into an administrative web dashboard to halt a misbehaving or losing business.
* **The New Architecture & Mental Model:** The business owner can text `STOP` or `PANIC` to their WhatsApp/Telegram Executive Copilot at any time. This triggers an immediate, atomic platform freeze: all active workflows terminate, outbound API calls block, and open trading positions liquidate to cash within 500 milliseconds.
* **Key Invariant:** The emergency halt is a hardware-priority interrupt that bypasses all agent reasoning loops.

---

### SECTION 6: EXTENSION ARCHITECTURE, WORKFLOW CLASSES & NAMING

#### 18. Naming Taxonomy: Templates vs. Extensions vs. Daemons
* **This updates/replaces:** Ambiguous terms like "plugins" and "micro-apps" that conflated UI, databases, and background scripts.
* **The New Architecture & Mental Model:**
  * **Templates:** Turnkey, whole-space or whole-project blueprints (e.g., `tpl_lexpulse_legal_v1`, `tpl_dev_foundry_v1`).
  * **Extensions:** The modular add-on package format that developers install into projects.
  * **Gadgets:** User-facing interactive micro-apps with UI viewports and DO Facet SQLite databases.
  * **Durable Daemons (Active Services):** Background intelligence engines fusing a DO Facet SQLite database with a continuous Dynamic Workflow (e.g., Plandex Tree-Sitter code indexers, legal citation mappers).

#### 19. 3-Class Workflow Taxonomy
* **This updates/replaces:** Treating all workflows as generic background scripts without clear escalation or spend rules.
* **The New Architecture & Mental Model:**
  * **Class 1: Company Automations:** Root space-wide, business-critical pipelines (Stripe reconciliation, payroll, SLA monitors). Alert directly to the Founder's Telegram.
  * **Class 2: Vertical Extensions:** Project-bound workflows bundled by extensions (CI/CD test runners, AST indexers, document ETL). Alert to the Project Team Room.
  * **Class 3: Ephemeral Tasks:** Task-bound sagas spawned on-demand by agents (Repomix chunk runner, web scrapers). Report via compact inline Receipt Cards.

---

### SECTION 7: SCOPING, GOVERNANCE & MULTI-ASSISTANT COORDINATION

#### 20. Universal State Scoping (Actor ID Derivation)
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

#### 22. Multi-Assistant Collision Defense (Leases, Spectators, and RFCs)
* **This updates/replaces:** Multiple assistants jumping on the same bug or conflicting on architecture.
* **The New Architecture & Mental Model:**
  * **Atomic Task Leases (`SpaceDO.tasks` CAS):** First assistant to claim an error gets an exclusive 15-minute lease; siblings abort execution instantly, saving credits.
  * **Sibling Spectator Mode:** Non-claiming assistants monitor the active task and offer to review the resulting PR diff.
  * **Semantic Deduplication Gate:** Incoming prompts matching an active task (>0.85 cosine similarity) link the user to the existing branch.
  * **Sponsor Alignment Gate:** Contradictory architectural commands freeze execution and surface an RFC card in the Team Room before code is touched.

---

### SECTION 8: CUSTOMER BOTS & PLATFORM FOUNDRY

#### 23. Quarantined Customer-Facing Subagent Workflows
* **This updates/replaces:** Allowing public chat callers on WhatsApp or Telegram to speak directly to the main developer agent.
* **The New Architecture & Mental Model:** Main project agents are strictly internal software/support architects. Outside customers communicate exclusively with **quarantined, ephemeral Dynamic Workflow Subagents** using a restricted `CustomerBotContext`.
* **Key Invariant:** Customer bots have zero access to `Bash`, file-editing tools, Git Artifacts, or internal vault credentials, making prompt injection attacks against the infrastructure impossible.

#### 24. The Self-Hosting (Homoiconic) Developer Foundry (`tpl_dev_foundry_v1`)
* **This updates/replaces:** Maintaining two separate frontend applications (`apps/shell` for clients and `apps/partner-studio` for developers).
* **The New Architecture & Mental Model:** The developer portal is not an external website; it is an **AVOS Space Template (`tpl_dev_foundry_v1`) running inside the standard shell**. Developers use the platform to build the platform: authoring extensions, running conformance test suites, inspecting SQLite schemas, and tracking 40% royalties in a unified workspace.
* **Key Invariant:** The platform maintains exactly one frontend shell codebase; developer and client experiences differ only by the loaded space blueprint.

#### 25. The Generalization of `/workspace/` (Deliverables vs. Machinery)
* **This updates/replaces:** The assumption that Git Artifacts and `/workspace/` are strictly for programming source code.
* **The New Architecture & Mental Model:** `/workspace/` is the **Project Deliverable Canvas** regardless of file format. In legal projects, it holds contract suites (`.docx`, `.md`); in finance, it holds Excel models (`.xlsx`, `.csv`); in coding, it holds source code (`src/`). All executable agent machinery (skills, workflows, daemons) lives strictly in `/.avos/`.
* **Key Invariant:** Cloudflare Artifacts (Git for Agents) versions any file type; Pull Request cards adapt to show spreadsheet cell deltas or document redlines.

---

### Summary Checklist of All Integrated Decisions

```
┌──────────────────────────────────────┬──────────────────────────────────────────────────────────────────┐
│ Architectural Vector                 │ Final Production Mechanism                                       │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Action Space**                     │ **All-CLI:** `Bash(command)` with `$PATH` extending via `/.avos/bin/`│
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Runtime Routing**                  │ **Invisible Hypervisor:** Routes to V8, Workflows, or Container  │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Decision Sentry**                  │ **System 1 Jev AI:** 70ms non-generative decisions (WriteGuard)  │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Container Runtime**                │ **3 Backends:** In-Browser WebContainer ($0), CF Container, Local│
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Workflow Invocation**              │ **Terminal Commands:** `workflow run <file>` & `schedule --cron`  │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Visual Perception**                │ **On-Demand Vision:** `see <path>` CLI command (80% token cut)   │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Enterprise Software**              │ **Dogfooded First-Party Extensions:** Ledger, CRM, E-Sign, Inbox │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Developer Foundry**                │ **Self-Hosting Space Template:** `tpl_dev_foundry_v1` in Shell   │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **State Scoping**                    │ **Deterministic Actor ID Resolution:** `SPACE_WIDE` vs `PROJECT` │
├──────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ **Assistant Structure**              │ **Hierarchical:** 1 Space = 1 Assistant (Parent CEO -> Sub VPs)  │
└──────────────────────────────────────┴──────────────────────────────────────────────────────────────────┘
```
