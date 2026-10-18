# Project Bots and the Universal Agent OS — Product and Implementation Roadmap

**Status:** proposed implementation roadmap
**Prepared:** 2026-10-17
**Branch inspected:** `Mcbt5s-Backup-2`
**Inspected HEAD:** `4c6bc2785fbe28dcfd533962032050570d485096` (`feat: add scoped Gadget update and delete`)
**Scope:** project-bound proactive assistants, Space project stewardship, one autonomy model, extension composition and lifecycle, cost controls and FDE test economics, domain-neutral kernel/templates, and end-to-end product journeys.

This is a plan, not a claim that these features have been implemented. It captures the latest product direction from the user request and reconciles it with the current repository and the existing extension/reconciliation plans. Earlier product concepts that conflict with this direction (notably AVE versus Cowork as separate operating modes and domain-specific products as kernel features) are superseded here. Preserve existing user data and compatibility while migrating those concepts.

## 1. Product direction

Naelao is one AI operating system. The kernel provides durable agent execution, identity and authorization, workspaces, projects, collaboration, memory and knowledge, tools, schedules and events, extensions, audit, and metered resource control. People add purpose through project templates and composable extensions. A trading, legal-operations, support, research, or personal-assistant experience is a composition and policy profile, not a different OS or project kind.

A **Project Bot is the planner for its project**: the project-scoped counterpart of the Space Assistant, built on the same planner and worker architecture. It has a stable project identity, project-scoped knowledge and workspace, internal conversations/threads, routines, permissions, budget, and presence. A Space Assistant and Project Bot differ by scope and identity, not by planner architecture. Each is governed by Space policy; the Space Assistant can coordinate with a Project Bot through authorized internal project context, but their workspaces, threads, and capabilities are not implicitly shared. A Space with several projects can have several Project Bots.

**Clarification from the user (2026-10-18):** “Project Bot” names this same project-scoped planner when it is accessed through internal project channels or sessions/threads and can run proactively. It is not a distinct worker/sub-agent or a new planner tier. The project planner continues using the Space Assistant’s existing planner/worker topology. External customer-facing channel handlers remain separate extension principals; do not route them into Project Bot threads or planner context.

In implementation terms, **Project Bot is a product role/name for the existing project-scoped planner, not a second agent principal, runtime, or separately addressable bot service**. Its canonical identity comes from the project plus the existing project planner/agent identity. Internal project channels and sessions/threads are entry points to that planner. Proactivity is provided by routines/events that invoke the same planner through its normal internal path; it does not create a second conversation path or change how work is delegated. Store Bot-facing profile/presence metadata against the existing project/planner identity rather than creating a parallel Bot record unless repository evidence shows a required field cannot live there.

Project Bots are internal. Members access them through in-app project sessions/threads and any explicitly configured **internal** project channel. A Project Bot is never exposed as a customer-facing or public channel handler. Customer-facing messaging is served by a separate external extension handler with an external principal and narrowly granted data/actions; it cannot invoke the Project Bot planner, join internal threads, or inherit member permissions. A composed extension may provide both internal tools/workflows and an external channel surface, but the host keeps their principals, contexts, and grants separate.

A **Space Project Steward** is a platform-provided Space-wide extension installation. It runs in its own Space extension workspace, not the Space Assistant workspace. It periodically reviews authorized project journals and project metadata, prioritizes projects needing attention, and proposes the next useful action. It can flag apparent completion or inactivity and prepare a retirement review. It cannot autonomously delete project data or shut down a user’s running extensions. The Space Assistant or an authorized human reviews evidence and confirms pause/archive actions.

The public product surface should feel simple to nontechnical users:

- One assistant per Space for broad questions and cross-project coordination.
- A **Bots** roster for project specialists, each with a clear project label, state, next routine, last activity, and unread/approval indicator.
- Projects remain the place for project files, work, and configuration. Opening a project reveals its Bot, activity, routines, knowledge, extensions, and budget.
- One autonomy setting per assistant/Bot, with understandable choices and a short preview of what can happen. Advanced users can tune action classes, schedules, tools, spending, and approval rules.
- A Project Bot is the project planner: it plans and delegates through the same existing worker topology as the Space Assistant, within project scope. It may use authorized project workflows, SDK tools, Canvas, and Gadgets. An external channel handler is a separate extension principal and never becomes a route into either internal planner.

## 2. Repository findings and constraints

At the inspected commit the working tree was clean. The current code and plans establish these relevant facts:

| Area | Current evidence | Planning consequence |
|---|---|---|
| Project identity and templates | Project agent templates are curated behavioral/tool configurations in `workers/agents/src/agent-templates.ts`; generic project templates and bootstrap live under `workers/agents/src/launchpad/project-templates.ts`. | Make the project-scoped planner the Project Bot, reusing the same planner/worker architecture as the Space Assistant. Do not add a second planner architecture or domain-specific project kind. |
| Project autonomy | Agent templates expose suggested autonomy; existing run gates, approval paths, execution ceilings, and capability controls exist in several layers. | Map these to one user-facing autonomy model and one canonical policy evaluator; do not equate a UI slider with authorization. |
| Proactive execution | Project journals, automation, durable workflows, and channel heartbeat paths exist, but current heartbeat behavior is distributed and includes legacy customer-bot concepts. | Consolidate new Project Bot routines onto a durable, event-aware scheduler while preserving planner/worker topology and old integrations during migration. |
| Spend controls | `SpaceDO` contains per-project daily spend caps, reservation/settlement tables, and run settlements. `NaelaoAgentDO` has channel/run gates. | Reuse the authoritative reservation path; add install, external subject, and run-class budgets plus unit-cost metering. Do not depend on a UI-only cap. |
| Extension composition | `new plan/FDE-EXTENSIONS-AND-MICROAPPS-ARCHITECTURE.md` documents versioned composed project bundles with Canvas, Gadget, channels, and some workflow support. Exact installation/role/primitive scoping is already partly enforced. | Extend the manifest/compiler/install/runtime contract rather than inventing parallel extension kinds. |
| External channel safety | Public handlers use a restricted external principal and do not receive planner/member tools, raw credentials, or general project access. Knowledge publication is explicit and channel data is isolated. | Preserve this trust boundary. Add instance and external identity routing without turning an external contact into a Space member. |
| Provider lifecycle and package trust | The extension plan says provider connection declarations are not yet full per-install OAuth/credential records; current release HMAC/digests prove host acceptance/integrity, not publisher identity. | Explicitly implement OAuth/credential lifecycle, asymmetric publisher identity, revocation, and runtime signature verification. |
| Canvas and Gadget | Project Canvas/Gadget runtime isolation and project-member Gadget operations exist; Canvas-to-Gadget actions are still open. | Add mediated actions through declared host capabilities; no arbitrary SQL or cross-install reads. |
| Inbox | Owner inbox, bounded reply, scoped export/deletion and pause behavior exist; assignment and complete integration remain open. | Add assignment/escalation with install- and project-scoped authorization and durable event history. |
| Product taxonomy/UI | `spaces/page.tsx` currently renders AVE and Cowork modes and vertical labels; domain-specific template text remains. `docs/ui-feature-inventory.md` includes historical vertical/mode requirements. | Treat the latest user direction as product policy. Migrate labels and templates in place; the generated inventory is not authority to preserve superseded mode distinctions. |
| Legacy customer-bot implementation | Code remains in project configuration, routes, worker paths, and UI, including `CustomerBotAutomation`; historical notes explain how it evolved. | Do not delete these paths abruptly. Stop adding customer-bot project/planner concepts. Migrate supported public-channel behavior into isolated external extension handlers, which remain separate from internal Project Bot planners; retire legacy UI/data only after compatibility and data migration. |
| Runtime topology | Existing Planner/worker topology is user-directed to remain as is. | A Project Bot is another scope-bound use of this same planner/worker architecture. Do not replace or fork it. New schedules/routines wake the authorized planner through existing internal entry points. |

Evidence sources in the repo include `new plan/TRANSCRIPT-CROSS-SOURCE-RECONCILIATION.md`, `new plan/FDE-EXTENSIONS-AND-MICROAPPS-ARCHITECTURE.md`, `new plan/CONTINUATION-IMPLEMENTATION-PROGRESS.md`, `workers/spaces/src/do/SpaceDO.ts`, `workers/agents/src/do/NaelaoAgentDO.ts`, `workers/agents/src/agent-templates.ts`, `workers/agents/src/launchpad/project-templates.ts`, and `apps/shell/src/app/p/[slug]/(shell)/spaces/page.tsx`. Verify these paths again immediately before implementation; the code may change.

## 3. Product object model and boundaries

Use these concepts consistently in UI, manifest, APIs, logs, and billing:

1. **Space Assistant** — the existing general-scope planner for one Space. It can coordinate across projects according to Space-level grants. It has its own assistant workspace and internal conversation.
2. **Project Bot** — the product role/name of the existing planner for one project, using the same planner/worker architecture as the Space Assistant with project scope, workspace, grants, internal threads, and routines. It is not an additional runtime or customer-facing channel bot.
3. **Project** — stable project identity, files/Knowledge, journals, tasks, activity, members, templates, installed extensions, and lifecycle.
4. **Extension package** — versioned composition of primitives, not a synonym for one primitive. Its manifest needs stable IDs and declarations for workers/roles, workflows, Canvas, Gadgets, channels, scripts, required connections, Knowledge grants, events, data retention, runtime/resource envelope, and upgrade/migration behavior.
5. **Installation instance** — a particular installation of a package in a Space or project, with its own credentials, bindings, state namespace, limits, enabled/paused state, and version. One package can have multiple instances.
6. **Invocation principal** — Space Assistant planner, Project Bot planner, project member, trusted internal service, or external extension principal. The principal determines access; the package name and caller-supplied IDs do not. External subjects are never members or planner principals.
7. **Routine** — durable scheduled or event-triggered work owned by an assistant/Bot/extension, with trigger, timezone, internal delivery target, budget, approval class, version, pause/expiry policy, and run history. Public channel delivery is an external extension action under its own grant.
8. **External identity** — provider-specific identity verified by the host and mapped to an installation and opaque external subject key. It is distinct from Naelao account identity and must never inherit internal member roles.

Workspace scopes remain separate: project planner workspace; Space Assistant workspace; and an isolated workspace per Space-wide extension installation. Project Bot and Space Assistant use the same planner/worker architecture but do not share workspace or thread state by default. No shared mount is implied by common Space membership. Data crosses a boundary only through a host-validated API/grant or an explicitly published artifact.

## 4. Project Bot and Space Steward behavior

### 4.1 Project Bot lifecycle

Create, configure, pause, resume, archive, and restore a Project Bot through the owning project. Project creation may provision the project planner identity with no autonomous schedule and no enabled external-channel route. The user starts by opening an internal project session/thread, selecting a template, or asking the Space Assistant to create/configure the Project Bot. The Project Bot can handle an internal one-off task, saved routine, project event, or approved delegated workflow.

The project planner, presented in the product as its Bot, has:

- stable project and existing planner/agent IDs, a name/avatar/role description, and canonical internal project threads plus optional task/run threads; do not mint a second principal ID solely for the Bot label;
- project-only default files, Knowledge, journal, and memory, with separately reviewed Space-wide grants where needed;
- a policy profile, tool/capability grants, execution ceiling, model/effort policy, schedule, internal notification target, and budget;
- visible status (idle, running, awaiting approval, paused, blocked by budget/connection, failed) and activity timeline;
- pause/resume controls that immediately fence off new starts and safely handle in-flight work; cancellation behavior depends on the runtime’s side-effect certainty.

The Project Bot **is** the project planner, not a worker under a separate project planner and not a parallel bot runtime. Invoke/configure the same planner architecture and internal entry points used by the Space Assistant with the project’s verified scope and policy. It uses the existing worker topology for delegated work. Attribute planner decisions, worker runs, internal sessions, and extension actions separately in the audit trail. A public extension handler is never routed through this planner.

### 4.2 Routine scheduler

Build on a durable event/schedule service (use the current Durable Workflow/event infrastructure where it fits). Do not use a constantly polling model heartbeat as the default. Support calendar schedules in the user’s timezone, one-shot times, project events, and bounded “check periodically” requests. A due routine wakes the Project Bot planner through its normal internal invocation path, with project identity and grants verified by the host. Persist schedule definition version, next due time, pause state, and idempotency key. Missed ticks coalesce by policy; do not launch a backlog of stale heartbeats after downtime. A busy Bot does not get overlapping routine runs unless a declared routine explicitly allows safe concurrency.

Each planner run has a bounded invocation, deadline, input snapshot/pointers, capability snapshot, spend reservation, execution record, result/exception, and internal delivery status. Retry only idempotent or host-deduplicated work; never blindly retry an uncertain side effect. If the planner delegates a public reply, that reply is a distinct extension action with its own identity, budget, and delivery record. Provide “Run now” as a preflight/test path and show its budget consumption.

Use cadence windows, jitter, event deduplication, change detection, cooldowns, quiet hours, maximum attempts, and model-free pre-checks when available. A routine should stop or report “nothing changed” without manufactured work. Scheduler health, skipped/capped jobs, last success and next run must be visible to the owner.

### 4.3 Space Project Steward extension

Provision a named, platform-maintained Space-wide extension installation (for example, **Project Steward**) per Space through the normal extension lifecycle. It runs in an isolated Space extension workspace with a dedicated minimal grant. Its read access is explicit and read-only: project status, journal summaries, due dates/tasks, recent project activity, extension run/health summaries, and selected owner-published project facts. It does not mount all project files or read external user conversations by default.

Two-stage design:

1. Deterministic collection computes project facts (staleness, due work, unresolved approvals, recent failures, apparent completion, active external service/connection, spend/health). This is auditable and cheap.
2. A model may rank candidates and explain evidence, uncertainty, and suggested next work. Its output is advisory, validated against a typed schema, and cannot mutate project or install lifecycle state.

The Steward may propose a routine for a particular Project Bot, suggest an owner check-in, flag likely completed/obsolete projects, identify extensions with no recent successful use, and prepare an impact summary. It must show the source events and confidence. It cannot create high-autonomy schedules, move funds, contact external users, archive/delete projects, or shut off a live extension without explicit policy-authorized confirmation.

Lifecycle state machine proposal: `active → review suggested → owner/Space Assistant decision → paused (reversible) → archived`. Keep project deletion and data retention as distinct, explicit operations. When a project is paused, identify all scheduled jobs, provider bindings, public routes, running workers, and extension instances; present effects and allow selective pause. Keep evidence and a restore path. The Space Assistant can answer/triage the review request, but confirmation must still be attributable to an authorized user or a narrowly defined, pre-approved owner policy. No model self-approves the Steward’s own recommendation.

### 4.4 Bots navigation

Add a stable **Bots** destination near the Space Assistant chat and Projects navigation. It lists project planners across projects visible to the member, but only displays actions permitted by project membership. Search/filter by project, status, unread activity, approvals, and routine. Label each as an internal Project Bot and show its project scope in the list and thread header. Opening a Bot resolves through stable Space/project/Bot IDs and an authorized server lookup. Public customer conversations remain in the separate extension inbox and must not appear as Project Bot threads.

Project pages remain authoritative for project data and settings; the Bots roster is the cross-project doorway. Deep links must survive refresh and history navigation. Space switching must never preserve another Space’s project Bot, cached transcript, or selection. Mobile uses a compact list/detail route; keyboard users can navigate and operate controls without drag-only affordances.

## 5. One autonomy model

Replace AVE/Cowork as competing operating modes with one assistant/product and one understandable autonomy control. A user-facing choice could be:

- **Ask me first** — analyze, search, draft; ask before external or irreversible actions.
- **Handle approved tasks** — execute selected low-risk actions and workflows; approvals for configured action classes.
- **Run within limits** — proactive routines and selected actions under explicit time, tool, recipient, and spend limits; escalates outside the envelope.
- **Custom** — advanced action-by-action policy and capability configuration.

Names and number of stops should be validated with real users. There is no mode switch that changes project type, assistant identity, planner/worker topology, or kernel. Templates may select a safe starting point but disclose every grant and limit before enabling it.

Autonomy is a policy compiled to server-side grants, not an instruction in a system prompt. Evaluate on every tool/action execution using verified principal, project, install, target, risk class, connection, current user approval, budget, and policy version. Revocation takes effect on subsequent operations. Sensitive actions require a fresh approval tied to the exact operation/input and expire on change. A UI slider cannot grant capabilities unavailable to the principal.

Keep distinction between:

- **Autonomy:** what the agent may do without asking.
- **Capability:** what it could do if policy permits.
- **Execution tier:** where/how code runs.
- **Template:** initial configuration.
- **Extension:** installed composition.

## 6. General-purpose kernel and domain offerings

### Keep in the kernel

Identity, Spaces, projects and membership; conversation/agent identities; project/Space/extension workspace isolation; planner/worker topology; durable workflows/scheduler/events; model gateway and inference policy; execution tiers and sandbox boundaries; tools/capability authorization; project files/Knowledge and explicit publication; bounded SQLite/Gadget storage; extension manifest/install/version/revoke; provider connection vault; audit/inbox; resource metering, budgets, billing gates, export and deletion.

### Ship as templates and extensions

Market Reader, Business Wallet, customer support/sales flows, trading workflows, legal intake and document review, agency delivery packs, scheduling automations, channel bots, CRM dashboards, compliance checklists, research pipelines, sector-specific connectors and specialized Canvas experiences. Naelao may curate and dogfood first-party packages, but they use the same SDK, manifest, authorization, onboarding, usage record, publication, and rollback paths as FDE packages.

Do not abruptly remove working wallet, marketplace, or vertical code. First identify which pieces are genuinely generic kernel primitives (e.g. a budget ledger) and which are product-specific experiences. Keep generic billing/accounting primitives in the kernel; move their domain-branded UI and workflows into optional extensions/templates. Migrate existing spaces with no data loss, preserve URLs/API compatibility during transition, and remove obsolete AVE/Cowork wording from the customer path. The existing docs/inventory should be annotated as historical or updated after the migration contract is approved.

## 7. FDE extension authoring and operational lifecycle

### 7.1 Developer mental model

Teach six orthogonal questions in Foundry rather than ask developers to choose a single “extension type”:

1. Who invokes this? Space Assistant planner, Project Bot planner, project member, scheduled event, trusted internal service, or a separate external extension handler.
2. What does it contain? Worker role, workflow, Canvas, Gadget, channel adapter, scripts, connection declarations, Knowledge source.
3. Where does it run? Existing execution tier, with a bounded resource envelope.
4. What can it read/change? Typed capabilities, resource grants, project/installation scope, and approval classes.
5. Who pays and what is bounded? Per-run/period limits, owner budget, external user limits, storage and provider usage.
6. How is it installed and maintained? OAuth/setup, migrations, health, upgrades, rollback, uninstall, retention.

The SDK should generate a human-readable capability and cost summary from the same canonical manifest compiled by the host. Unknown fields/capabilities fail closed. Build validation and permission checks must not rely on package README prose.

### 7.2 Complete extension package

The canonical package/release needs:

- stable package, publisher, version, primitive and installation-instance identities;
- entry points and invocation principals, worker/workflow bindings, Canvas/Gadget/channel/script declarations;
- execution tier constraints, timeouts, concurrency, max memory/CPU where supported, storage quotas, network destinations and egress policy;
- least-privilege data grants and explicit Knowledge publication/consumption rules;
- provider connection type, scopes/purpose, callback requirements, reconnect/revoke path (never secret material);
- external identity/session strategy, isolation keys, retention and deletion contract;
- budgets and usage meters by run, model/inference, CPU/compute duration, storage, provider actions and outbound messages;
- idempotency and side-effect declarations, retry/compensation behavior, health checks and event subscriptions;
- schema/data migration plan, compatibility range, upgrade and rollback notes;
- publisher signature, artifact hashes, build provenance, revocation and support/security metadata.

The host verifies signature against the registered publisher trust key, artifact digest, canonical manifest, capability policy, and revocation state at install and every runtime load. Keep host acceptance attestation separate from publisher identity. Signing keys can rotate; revocation and compromised-version handling must stop new execution without destroying user data.

### 7.3 Provider connections and external customer identity

Implement provider-specific installation connection records, not tokens inside packages. For OAuth providers: host-controlled redirect, state/CSRF, PKCE where provider supports it, verified callback, encrypted at-rest token and opaque handle, required scopes, owner/installer association, refresh health, least-privilege sharing, reconnect, revoke, delete, and audit. Webhooks need signature verification, replay protection, tenant/install routing and idempotency. WhatsApp onboarding must state whether the deployed provider path is Meta Embedded Signup or a hosted Business Solution Provider (such as Twilio); do not pretend the two token/webhook lifecycles are identical. Non-OAuth providers use their supported credential method with equivalent host custody and rotation UX.

For public bots, map provider tenant/phone/channel → installation instance → external subject → conversation/session. Derive opaque subject identifiers server-side, encrypt any contact details, and never accept a customer-supplied project, installation, or user ID as proof of access. Multiple bot instances may share one verified provider account only through explicit routing rules. Provide conflict detection, test messages, identity/session revocation, retention, export/delete workflows, and account-level rate ceilings.

### 7.4 Canvas, Gadget, and workflows

Canvas is a composition surface, not a privileged shell. Let an FDE build a collaborative board where planner-assigned workers appear as actor IDs/cursors and make scoped operations. The SDK/host should offer a Canvas session API with operation schemas, per-run role identity, project/install binding, ordering/deduplication, actor visibility, rate limits, immutable run attribution, and explicit conflict policy. Canvas code cannot forge a worker identity or send arbitrary commands.

Canvas-to-Gadget writes use named host actions generated from the Gadget schema/extension declarations; the host checks project, installation, active run, worker role, operation, row-level policy, quota, and approval before applying. No raw SQL, arbitrary migration, or cross-instance access. Record audit and return a typed result.

Visual workflow authoring compiles to the same durable workflow definition and SDK/runtime path as code-authored workflows. Offer validate/preview, static permission/cost graph, test input, dry run, checkpoints, human approval nodes, retries/timeouts, version pinning, and rollback. A workflow is owned by the package/install and can be edited only by authorized FDE/admin roles; never let an external channel user mutate it.

### 7.5 Inbox and assignment

Promote the current owner inbox into an install-scoped operations queue: unassigned, assigned, awaiting customer, awaiting owner approval, failed/uncertain provider effect, resolved. Provide team assignment, internal notes, response templates, escalation, SLA/age, ownership transfer, conflict-safe claiming, audit trail, and pause/close behavior. Enforce exact project+installation scope at every query/mutation. Separate external-visible replies from internal notes. Keep an ambiguous provider-send state from being resent until reconciled.

## 8. Abuse, spend, and reliability controls

External users should not spend the Space owner’s balance without the owner choosing a policy. Before any inference or provider action, apply an atomic admission/reservation check against a hierarchy:

`platform safety → Space plan/budget → project budget → extension installation budget → provider/channel budget → external subject budget → per-run ceiling`.

Controls include:

- period and daily hard caps, per-user fair-use caps, rate/concurrency windows, maximum turns/tokens/output, attachment size/type limits, and storage/session TTL;
- max workflow steps, retries, tool calls, CPU/runtime, browser/network usage and outbound messages per run;
- owner-selected policy for public users: fixed allowance, paid/subsidized, invite-only, human support handoff, or disabled; do not default to uncapped “generic chatbot”;
- declared audience and supported topic scope plus user-facing purpose statement; provide polite off-scope answer, rate-limiting, block/escalate paths. Off-topic policy should not be an unauditable model-only classifier and must not deny legitimate requests unpredictably;
- preflight estimate or “may use up to” budget, balance/limit notice, owner alerts at configurable thresholds, and safe stop/resume/reset;
- idempotent reservations and reconciliation of usage after failure; hard-cap state visible in bot/inbox, no silent charge to a different wallet;
- abuse signals (bursting, repeated prompt injection, spam, anomalous token use) with appeal/unblock and evidence logs.

Budget exhaustion is a product state: tell owner and (if appropriate) the external user what is blocked, when it resets, and how the owner can change it. Never auto-enable overage. Provider charges outside Naelao metering are separately disclosed.

## 9. FDE test economics, plans, and packaging

Create an isolated Foundry test environment that runs the same compiled release and policy checks as installation with synthetic identities/data and mocked providers by default. Developers can allocate their subscription-included **development credit budget** to their own tests; enforce max spend per test, daily/monthly cap, runtime/concurrency limits, synthetic customer quotas, and cleanup TTL. Production/customer credentials and customer balances cannot be used as test inputs. Live-provider tests require explicit owner connection and a visible narrow spend limit. Test artifacts must be labeled and separated from production analytics.

Capture an immutable metering event for each run/action with package/version, installation, Space/project, principal class, routine/run ID, tier, model/provider, input/output and token counts where available, duration/CPU, storage delta, connector calls, retries, and actual billable unit. Store price/rate version and usage provenance. Report:

- observed cost distribution (median, p95, max and sample count) by use case and execution path;
- per-run versus per-minute/compute-second versus per-message/session/provider fees, explicitly separating metered cost from subscription allowance and third-party charges;
- test-sample limits, representative assumptions, confidence and missing meters;
- a recommended plan/tier and price floor as an advisory simulation; FDE/publisher sets the retail offer, platform validates allowed pricing and margin policy.

Do not let an AI estimate be the accounting record. Derive recommendations from actual metering and versioned price tables; use a model only to summarize usage patterns and explain trade-offs. Require minimum representative runs and warn when high-percentile cost is poorly known. Stop unbounded routines by default and surface cost ceilings in extension listings and install previews.

## 10. Nontechnical journeys and scenario coverage

These journeys should be used as design reviews and end-to-end test narratives. Every flow must work without repository access or knowledge of OAuth terminology.

| Persona and scale | Start → successful outcome | Key failure/edge cases to cover |
|---|---|---|
| Personal user | Create a Space, start with empty or suggested setup, ask Space Assistant for help, create a project and Bot, add selected files, choose “ask first,” later enable a quiet-hours routine. | No template required; no surprise schedule, spend, external sharing, or workspace access. Explain memory and deletion. |
| Family/home organizer | Share a home project with named members, create household routine, connect calendar/service as owner, assign which Bot may see it. | Children/guest roles, revoked member, private personal project, shared connection ownership and notifications. |
| Solo freelancer | Pick a generic project template, upload client materials, ask project Bot to prepare a draft, approve outbound action, see time/cost and handoff. | Client work separation, budget cap, wrong client/project link, owner approval and export. |
| Small business owner | Install first-party/FDE extension (support, bookings, marketing), review scope/cost, connect WhatsApp or Telegram, publish selected FAQs, test as customer, launch. | OAuth incomplete/expired, wrong phone/account, duplicate webhook, abuse/off-topic traffic, customer asks for human, disconnect and clean uninstall. |
| Trading mentor | The internal Project Bot planner can explain approved mentor knowledge in project sessions and use member-authorized Canvas/workflows. A separate public messaging extension handles student FAQs with exact published collections and per-student limits; its external handler cannot access the Project Bot or internal threads. The internal planner may delegate an allowed operation to a worker after review. | Student never gains member tools or private files; no trading/order action by public handler; broker connection and live trading require independent explicit grants, limits, legal review and confirmation. Canvas, workflows and Bot share bundle identity without sharing trust principal. |
| Finance team | Generic project plus finance extension for document intake/reconciliation/reporting; project Bot prepares, flags anomalies, and routes approval. | Tenant/ledger isolation, dual approval for payments, immutable trace, correction/reversal, limits and audit retention. No claim that a template makes the customer compliant. |
| Legal practice | Project per matter/client, matter-specific Bot, exact document grants, approved draft workflows, review queue. | Ethical wall across matters, confidentiality, source attribution, privilege-aware retention, jurisdictional review, never imply legal advice or auto-send filings. |
| Agency/consultancy | Reuse templates for multiple client projects; install separate package instances and provider credentials per client; run monthly reports. | No shared tenant data by package, per-client quotas, staff offboarding, upgrade compatibility and export/uninstall. |
| Enterprise | Central owner sets policy/catalogue and spend envelopes; teams create projects/Bots from approved templates; SSO/RBAC/audit/retention control extensions and connections. | Least privilege, tenant/regional boundaries, policy inheritance/override explainability, key rotation, signed release revocation, disaster recovery and bulk lifecycle APIs. |
| FDE/developer | Build package through guided Foundry, test synthetic and selected provider flows, inspect cost profile and grants, sign/publish version, install into own project, staged upgrade/rollback. | Incomplete samples, mock/live mismatch, expensive tail, vulnerable dependency/artifact, revoked publisher, migration failure, test/production credential confusion. |
| Space steward/manager | See portfolio summary, projects requiring attention, evidence, likely completed work and extension inactivity; confirm pause/archive or dismiss. | Incomplete journal, ongoing external obligation, seasonal project, paused owner, uncertain AI score; no autonomous deletion or hidden shutdown. |

Domain-specific packs should be dogfooded across more than finance/legal/trading: education/coaching, healthcare administration (careful claims/privacy), ecommerce, logistics, construction, software teams, nonprofits, creators, research, and personal life. These are package validation personas, not new kernel project kinds. High-stakes regulated execution needs domain counsel and provider/legal review before launch; policy templates are not compliance guarantees.

## 11. Implementation sequence and commit gates

The user’s standing delivery preference is to checkpoint successful work in focused commits and push each accepted slice so progress is not lost. For implementation, work serially by phase, inspect each diff, run the stated checks, update the progress ledger, then commit and push that slice. Do not rewrite or reset existing refs. Never report a push unless confirmed by remote status.

### Phase 0 — Contract and inventory

- Re-read repository instructions and current plans/transcript reconciliation; record the latest direct user decisions and contradictions.
- Map current project/Bot/assistant records, policy evaluators, routine/heartbeat entry points, budget reservations, extension schema/runtime, credential tables, inbox, template catalog and UI routes.
- Mark obsolete AVE/Cowork/customer-bot concepts and their data/API dependencies; identify first-party domain experiences to migrate.
- Output: ADR/data flow diagrams, migration inventory, open decisions, baseline tests. No user data/schema deletion.

**Gate:** every requirement maps to a current component or explicit new component; no planner-topology change.

### Phase 1 — One language and autonomy policy

- Settle product terminology and user-tested autonomy labels.
- Define canonical policy object/version, action risk classes, grant inheritance, approval record and revocation semantics.
- Adapt existing template suggestions and server gates through a compatibility adapter; show one autonomy control in Shell.
- Remove AVE/Cowork segmentation from new user journeys and replace domain-tagged copy with template capabilities/labels. Keep legacy stored values readable.

**Gate:** tests show every UI choice compiles to server-verified policy; a low-privilege template cannot gain tools from a slider; old templates still load.

### Phase 2 — Project Bot identity and navigation

- Add any needed Bot-facing profile metadata and conversation/routine association to the existing project/agent identity; do not add a separate Bot principal or planner runtime.
- Add Bots roster/detail route, activity/state, stable IDs, project scope display, approval queue and responsive keyboard navigation.
- Add tests for multiple Bots, member isolation, URL refresh/history, switch Space/project, archived project, and stale cache/data rejection.

**Gate:** user opens the existing project-scoped planner through internal project channels/sessions/threads and the Space Assistant through Space sessions; routines wake that same project planner through the normal internal entry point. Both use the same planner/worker architecture but enforce distinct scope, workspace, and permissions. No duplicate Bot principal/runtime is created, and external customer-channel traffic cannot enter either planner directly.

### Phase 3 — Durable routines and portfolio stewardship

- Consolidate schedule/event run registration, locking/deduplication, budgets, run history, pause/resume, missed-tick coalescing, delivery, quiet hours and failure surfaces.
- Add Project Steward as a platform extension instance with typed read-only summary grants; rank/flag using deterministic measures plus optional advisory model.
- Add reversible project/installation retirement review workflow and confirmation UX; no auto-delete or model self-approval.

**Gate:** event and scheduled runs are bounded, idempotent, attributable, spend-reserved and observable; steward cannot mutate protected state; pause fences future run starts.

### Phase 4 — Metering and abuse budgets

- Expand atomic reserve/settle from project totals to install/subject/provider/run quotas.
- Establish canonical usage event schema and versioned cost rates across inference, execution tiers, storage and connectors.
- Implement owner caps and public-user limits, off-topic handling/handoff, alerts, budget exhaustion, reconciliation.
- Keep business wallet/consumer credit/Space plan concepts distinct in the accounting ledger and UI; explicitly show payer.

**Gate:** concurrency tests prove budgets cannot be raced around; every charged/un-charged external request has a traceable decision; injected failures reconcile without double charge.

### Phase 5 — Extension contract, publishing trust, and runtime lifecycle

- Canonicalize manifest/SDK compiler across worker roles, workflows, Canvas, Gadget, channels, scripts, connections, knowledge, event and data declarations.
- Register publisher identity and key lifecycle; asymmetric signature and full artifact verification at install, upgrade and runtime load; revocation behavior.
- Add install health, version compatibility/migrations, staged rollout, rollback, uninstall/retention and per-instance identity.
- Complete a single package manifest example and reference SDK across internal and external principals; preserve external quarantine.

**Gate:** tampered/mismatched/revoked package cannot install or run; previous signed version can be restored without mixing state or grants.

### Phase 6 — Credential lifecycle, channel routing, and inbox

- Implement the chosen provider connection from setup through token vault, webhook verification, refresh/reconnect, revoke and uninstall. Slack OAuth and Telegram bot-token setup exist. WhatsApp now has verified Meta system-user-token setup, WABA app subscription, a shared signed webhook, per-phone-number installation routing, and local credential revocation; this is an interim admin setup path, not Meta OAuth. Confirm Meta Embedded Signup or an approved BSP against deployment credentials and provider account before replacing the manual setup path.
- Add many-instance routing and opaque external subject identity with tests for contact collision, multiple bots, multiple sessions, expired authorization, duplicate event and revoked link.
- Complete inbox assignment/escalation and event/send uncertainty reconciliation.

**Gate:** external handler cannot access planner tools, member identity, unpublished knowledge, another installation’s session, or provider token; reconnect and uninstall leave no active route/secrets.

### Phase 7 — Canvas/Gadget collaboration and visual workflows

- Add role-bound Canvas action SDK and actor/cursor/event stream; keep existing planner/worker topology.
- Add typed Gadget schema-derived operations and server authorization per action.
- Add visual editor/compiler, test mode, dry run, cost/capability preview, checkpoint, approval and error recovery.

**Gate:** multiple workers can collaborate on a Canvas through approved SDK operations; unauthorized Canvas/Gadget operation and cross-install scope attempts fail; actions appear in audit.

### Phase 8 — Foundry economics, templates, and first-party dogfood

- Add synthetic-data test projects and capped developer credits with mock provider default; permit separately capped live test connections.
- Report measured resource profiles and confidence; recommend, never auto-select, plan/pricing.
- Convert one useful set of domain experiences into first-party packages using public SDK path; candidate pilot: generic support/education, then trading mentor knowledge FAQ with no financial execution.
- Replace legacy vertical mode picker with one template catalogue and filters. Preserve existing project records, configurations, URLs, wallets/ledgers, and extension IDs through adapters/migrations.

**Gate:** an FDE can build, test, understand grants/cost, sign, install, operate, upgrade and rollback a useful composed extension without custom host code. Dogfood package receives no privileged behavior unavailable to third-party packages except explicit platform service grants.

### Phase 9 — Reliability, security and staged release

- Run unit/integration tests by principal and tenancy boundary; property/fuzz tests on manifest, signatures, OAuth state, routing IDs and quota concurrency.
- Exercise scheduler restart/failover, provider timeout/ambiguous send, quota exhaustion, stale cache, archive/restore, package rollback, secret rotation, data export/deletion.
- Conduct threat-model and external security review for public channels, tool composition, credential custody, signatures and marketplace.
- Roll out behind flags to internal/test Spaces, then opt-in customers. Publish supported provider/runtime matrix and known limits. Monitor wrong-scope attempts, budget leakage, missed jobs and unexpected billing.

**Gate:** no launch until no cross-scope access, uncapped public spend, secret exposure, unverified code execution, or unrecoverable package migration remains open.

## 12. Test and acceptance matrix

Every feature test should specify principal, Space, project, installation, resource, policy version, expected capability, and expected audit event. Minimum suites:

- Project Bot creation, multiple bots, direct link/refresh/history, member roles, archive/restore, Space switching, project workspace/Knowledge isolation, collaboration with Space Assistant.
- Autonomy policy at every level; prohibited tool call, approval before/after argument changes, revoked connection/grant, updated policy during long workflow, no privilege from prompt/template text.
- Routine timezone/DST, missed ticks, duplicate event, concurrent claim, busy Bot, quiet hours, pause/cancel/restart, budget cap, no-op, notification failure, uncertain external side effect.
- Steward input freshness, deterministic flags, model malformed/unsupported output, low confidence, no journal, active/seasonal projects, no self-approval, extension still serving users, dismiss/snooze/confirm and full restore.
- Extension manifest and SDK type tests; signed artifact tamper/key rotation/revocation, version upgrade migration failure/rollback, multiple named installs/state isolation.
- OAuth state/CSRF/replay/scope mismatch/refresh/revoke, connection health, webhook signature/replay/routing, multiple provider identities and instances, contact data privacy.
- External abuse: budget race, per-subject/installation caps, off-topic and prompt injection, spam, media limits, blocked/deleted subject, unpaid quota, graceful handoff; verify no inference is sent after reservation denial.
- Canvas worker actor spoofing, event ordering, operation grant, Gadget cross-project/install/row boundary, stale tab and concurrent mutation.
- Inbox assignment race, handoff/reopen, internal note never in external payload, failure/uncertain send not resent, exact-install export/delete.
- Metering joins, price version change, missing provider meter, retry duplicate, estimate confidence, developer sandbox cap, production credential rejection and cleanup TTL.
- UX tests across personal, family, solo, small business, enterprise and FDE journeys; mobile/responsive, keyboard, screen reader labels, clear unconfigured and unavailable states.

## 13. Open decisions to close in Phase 0

1. Should a project provision a Bot record automatically at project creation, or create one on first chat? Recommendation: provision a lightweight default identity with zero autonomous privileges and no schedule, then invite configuration.
2. Does the “every Space comes with a Steward extension” mean every existing and new Space gets a visible platform-managed installation? Recommendation: yes for new Spaces; migrate existing Spaces in a staged opt-in/preview rollout, with visible status and no hidden background cost.
3. What does “full autonomy” authorize? Recommendation: it does not waive provider, financial, destructive, external-messaging, or compliance-specific confirmation unless a separate explicit bounded grant exists.
4. Which first provider path is deployable for WhatsApp (Meta Embedded Signup versus Twilio/BSP), and what ownership model applies to the provider account?
5. What rate card and credit conversion are authoritative for local runtime tiers, external provider charges, and developer sandbox usage? Until this is answered, report raw units and observed metered credits without promising customer prices.
6. Which domain packs should be first-party dogfood examples, and which become public marketplace releases only after review?
7. Define data retention/consent defaults by channel and jurisdiction with qualified legal review; the technical plan must not guess regulatory retention rules.

## 14. Research notes

Research was checked on 2026-10-18. These are product-pattern references, not evidence that Naelao should copy another product’s internals.

- Grok’s official automation announcement describes schedule and email triggers, timezone-aware schedule options, “run now,” saved per-run conversations/history, notifications, templates, and pause/resume/edit/delete. Useful patterns: create a routine from chat or UI, make each run inspectable, offer a bounded test run, and make pause obvious. [Automations in Grok](https://x.ai/news/grok-automations)
- xAI’s design article describes a persistent Bot roster and visible presence/activity; its routine section says work can begin on schedules or events and puts routine/run history in the Bot’s primary interface. Useful pattern: treat persistent agents as destinations with responsibility and activity, not as a hidden cron list. [Designing Grok Bot for a world of persistent agents](https://x.ai/news/designing-grok-bot)
- Grok Bot product overview positions named agents as persistent teammates. Treat the exact feature set as vendor-specific and fast-changing. [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- Hermes documentation differentiates a session heartbeat (same conversation/context, idle-only) from durable cron (fresh isolated session, persistent schedule, many jobs); its Bot Mode is a roster/UI over persistent profiles, and routines are surfaced beside the Bot conversation. Useful pattern: distinguish “continue watching in this conversation” from “run a durable self-contained job,” and make routine pause/status discoverable. [Hermes Bot Mode](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/bot-mode.md), [Hermes heartbeats](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/heartbeat.md), [Hermes scheduled tasks](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md)
- Grok’s workflow announcement emphasizes task decomposition, isolated focused contexts, verification phases, saved/resumable progress, and usage visibility. Naelao already has its own planner/worker topology; borrow the observability and resumability principles only, not the architecture or vendor-stated agent limits. [Workflows in Grok Build](https://x.ai/news/workflows)

### Inferred design lessons

Persistent Bots benefit from a roster, but activity should be truthful and scoped (a connected scheduler is not the same as an active run). Routines should show their schedule, last/next run, result, and pause control. Background work needs durable state and idempotency, while conversational “keep an eye on this” belongs to the relevant Bot/session. A project portfolio caretaker should be a visible, permissioned extension that proposes with evidence; it should not behave as an invisible janitor. These are design inferences from the product patterns above and the repository’s existing isolation, scheduler, extension, and spend foundations.
