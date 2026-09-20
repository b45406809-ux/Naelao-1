# AI Studio implementation prompt — batch 25, plan items 47–48

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 47–48**. This prompt is self-contained: the feature definitions and retained implementation
constraints have already been extracted and reconciled into the final specification below.
Do not seek or cite external design context. Repository code is evidence of current
state, not evidence that a requirement is complete.

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

## Newest cross-cutting architectural delta (overrides conflicts)

# AVOS Evolutionary Architectural Changelog

This is the authoritative architectural delta for plan items 1–130. These decisions postdate the source trails and `CLAUDE.md`; they override conflicts while retaining compatible implementation detail.

## Final reconciled upgrades

1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wins; all competitors receive abort signals immediately and only the winner enters the ordinary authorized merge path.
6. **Three-depth ceiling.** Depth 1 is the lead, depth 2 a domain sub-planner, and depth 3 a leaf executor. Depth-3 runtimes do not receive any delegation capability, making depth 4 structurally impossible.
7. **Five credit defenses.** Enforce model tiering by depth, up-front task escrow, plan-based parallelism, early-exit token reclaim, and daily personal budget envelopes. Starter executes sequentially; higher plans may enable races.
8. **Shared-space collision defense.** Combine 15-minute atomic task leases, sibling spectator mode, >0.85 intent deduplication, and sponsor-conflict RFC freezes in authoritative `SpaceDO` storage.
9. **Immutable kernel, userspace extensions.** Extensions may add manuals, virtual CLIs, daemons, and viewports but cannot replace the agent loop, bypass Gatekeepers or WriteGuard, or commit unreviewed code to `main`.
10. **Durable daemons.** Pair project-scoped DO-facet SQLite state with resumable Workflows for AST indexing, finance reconciliation, and legal citation graphs. Daemons consume no active-chat CPU/tokens and expose approved project MCP tools only.
11. **Dual-role workflows.** Dynamic Workflows support both ephemeral AI tasks and project-owned company automations. Deterministic steps remain deterministic and AI is invoked only for declared semantic work.
12. **No-code subagent studio.** The shell builds declarative `NoCodeSubagentManifest` documents from authorized tools, skills, knowledge, and triggers; a precompiled `GenericSubagentWorkflow` executes them. Creators cannot grant permissions above their current role.
13. **Logical connector aliases.** Code names semantic aliases such as `inbound_mail`; `SpaceDO` maps them to physical accounts. Rebinding never changes project source.
14. **Pluggable `primary_calendar`.** Calendar access is a space-shared MCP connector supporting Google, Microsoft, CalDAV, or scoped SQLite fallback. Voice booking acquires a 15-second `ConcurrencyDO` slot hold before external calls.
15. **Dual-plane customer bots.** Public WhatsApp, Telegram, and voice traffic reaches quarantined ephemeral Workflow agents with `CustomerBotContext`, never internal project agents. Customer contexts have no Bash, file mutation, Git Artifact, or internal-vault capability.
16. **Automation failure defenses.** Production ingress includes KV tombstones, Queue buffering, 14-day R2 replay, a 5 req/s leaky-bucket pacer, SHA-256 idempotency, `x-avos-hop-count` recursion breaking, and lenient validated adapters. The remaining defenses already specified by the relevant plan items remain mandatory.
17. **Deliverable canvas.** `/workspace/` versions every deliverable type, including code, documents, spreadsheets, and data; executable agent machinery remains under Git-ignored `/.avos/`. Review cards render type-aware diffs while bytes remain authoritative.
18. **Strict UI bifurcation.** `apps/shell` is an Apple-clean client workspace with an 85% canvas, command bar, and one-click outcomes, with no model, compute-tier, or raw merge controls. `apps/partner-studio` is the technical foundry for ladder ceilings, daemons, workflows, and blueprint packaging.

## Supersession rule

Apply this delta after each item's complete Origin & Transition trail. If it conflicts with an earlier plan statement, this file wins. If it is silent, retain the earlier final decision. All authorization, tenant isolation, fail-closed policy, provenance, billing, deployment parity, and realistic end-to-end verification requirements remain in force.


### 47. Jack Dorsey Mini-AGI Sovereign Permission Model

**Final behavior:** Intelligence is decentralized and partitioned to the individual user. Assistants can only perceive and retrieve data matching their user's role rank.

**Production acceptance contract:**
Production entry: router verified claims, SpaceDO membership, agent firewall.
Persistence/deployment: membership/role rows and scoped agent state.
Required observable verification: tenant and assistant-permission tests cover denials; full-source rank coverage remains release-blocking.

**Retained implementation constraints:**
- **Authorization (`workers/credentials/src/index.ts`):**
- Any member may create/update their own `scope='user'` credential (`POST` upserts in place —
  re-saving the same name rotates the value rather than erroring or duplicating).
- Creating a `scope='space'` credential, OR setting `is_override=1`, requires `owner`/`admin`
  (read from `x-naelao-role`, forwarded by the router from JWT claims — same trust boundary as
  every other worker in this codebase).
- `GET` (list) returns metadata only, never values. A non-privileged caller sees their own
  personal credentials + all space-scoped ones (so they can see what's shared, never a
  teammate's personal credential). Owner/admin sees everythin
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- 199 - 201
What about miniagi like jack Dorsey said how will we add it here or should we just make it a project kind . Or is it not necessary. Plus miniagi allows that a company can upload a bunch on company data and give permissions to each data to users , so can we just enable miniagi to space assistants so each user s assistant in a space knows and can access data that is permitted to that user
Projects can be private or public public meas any user in space or business can vi3w it but private it's just that user who created it and maybe invited users
Making Jack Dorsey’s **"Mini-AGI" (Decentralized, Sovereign, User-Scoped Intelligence)** a core capability is the right direction—and it shouldn't just be a project kind; **it should be the fundamental security architecture of every user's Space Assistant.**
Jack Dorsey’s vision of Mini-AGI is that **intelligence should be decentralized, p
- ### Axis 5: Decentralized & Scoped Intelligence ("Mini-AGI" & Permissioned Vector RAG) *(Continued)*
**Core Architectural Blueprint (Continued)**
* **Indirect Injection Security Firewalls:** Context-sanitization layers scan tool outputs, third-party web content, and retrieved vector chunks before prompt insertion [1.3.17]. Untrusted dynamic payloads are encapsulated in strict semantic boundary tags (e.g., `<untrusted_retrieval_chunk>`), explicitly signaling to the model's attention layers that text within these blocks cannot alter operational instructions or tool-dispatch policies [1.3.17].
* **Hierarchical Role-Based Access Control (RBAC):** Every document ingestion payload registers access bitmasks (defining tenant, department, project, and specific user IDs). Queries executed by an agent inherit the authenticated user's permission bitmask, automatically discarding unauthorized seman

### 48. Hardware-Level Vector Pre-Filtering

**Final behavior:** Filters space ID, project ID, and role rank inside Cloudflare Vectorize *before* similarity scoring, preventing information leaks via ranking density.

**Production acceptance contract:**
Production entry: knowledge `/kb/search`; `googleModeSearch` adapter contract.
Persistence/deployment: `KB_VECTORS`, R2 chunks, D1 ownership.
Required observable verification: `kb-project-isolation` and `grounded-search-contract.test.ts`; a realistic pre-scoring Vectorize integration journey is still required.

**Retained implementation constraints:**
- **Project deduplication** (`SpaceDO.createProject`). Exact-name idempotency already existed
(`ON CONFLICT(space_id, name) DO NOTHING`); this adds a *semantic* heads-up: before inserting a
genuinely new project, its name is compared against every existing active project via
token-Jaccard similarity (`nameSimilarity`/`findPossibleDuplicateProjects`, `@naelao/events`;
threshold 0.5, chosen to favor recall — a false-positive heads-up costs nothing, a missed real
duplicate is the thing this exists to catch). This is deliberately **not** embeddings/Vectorize
— that's reserved for `script.find`'s retrieval, not a synchronous check on every project
creation. Matches are returned in the create respon
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 2. How Permissioned RAG Works in Cloudflare Vectorize
When documents are uploaded to the company’s Knowledge Base, the **Knowledge Worker** tags every chunk with an Access Control List (ACL):
```typescript
// During Document Ingestion (workers/knowledge/src/index.ts)
interface DocumentAclMetadata {
  spaceId: string;
  projectId?: string;
  visibility: "public" | "private" | "role_restricted";
  allowedRoles: Array<"owner" | "admin" | "editor" | "member" | "viewer">;
  allowedUserIds: string[]; // Specific whitelisted user IDs
}
```
When an employee queries their assistant, **Cloudflare Vectorize enforces the ACL at the vector search level**:
```typescript
// Querying Vectorize with User ACL Filtering
export async function searchPermissionedKnowledge(
  vectorize: VectorizeIndex,
  queryEmbedding: number[],
  spaceId: string,
  user: { id: string; role: string }
) {
  // The vector e
- #### Failure Modes & Anti-Patterns
* **Post-Retrieval Filtering (Information Leakage via Ranking):** Performing vector similarity search across all documents and filtering unauthorized documents in application logic allows unauthorized chunks to alter top-$k$ nearest-neighbor density, inadvertently leaking the existence or topical clustering of classified materials.
* **Global Assistant Amnesia & Scope Leakage:** Sharing memory state across different project spaces within the same organization allows non-privileged project threads to inherit semantic facts derived in restricted rooms [1.3.15].
* **Raw String Interpolation of External Artifacts:** Injecting unstructured scraper outputs directly into the prompt without semantic envelope encapsulation allows third-party websites to execute prompt injection against the agent.

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
