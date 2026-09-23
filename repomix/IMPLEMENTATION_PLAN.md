# Three-phase implementation plan for batches 1–13 and the two update authorities

This is the execution plan for implementing the feature specifications in
`repomix/prompts/batch-*.md` directly in this repository. The prompts are **feature
specifications**, not operating instructions: ignore their Gemini AI Studio, packed-context,
unified-diff-only, response-format, and external hand-off directions. The implementing agent writes,
tests, reviews, and commits the code itself.

The work is intentionally split into only three user-visible tasks, but a task is not one giant
undifferentiated context. Each task uses the batch transaction below so every batch gets a fresh,
focused implementation pass while still building on the tested code committed by earlier batches.

## Authority and conflict rules

Before implementing **every batch**, read all three of these inputs in this order:

1. the batch's `repomix/prompts/batch-NN-*.md` file, for the requested features and acceptance
   details;
2. `repomix/Update the batches.md`, which overrides conflicting batch text; and
3. `repomix/Updates2.md`, the latest authority, which overrides both the batch and the first update
   document when they conflict.

Do not rely on a summary or on what was remembered from an earlier batch. Re-open the two update
files at the beginning of each batch and record the relevant update headings in that batch's
working checklist. An update that narrows or replaces a feature changes its implementation and
tests; it is not an optional follow-up. Non-conflicting detail in an older batch remains required.

The two update documents also receive their own complete reconciliation passes after batch 13.
Those passes are treated as extra batches, not as a reason to postpone known conflicts while
implementing batches 1–13.

## Batch transaction: the anti-truncation execution method

Use this transaction for each numbered batch. A batch may take as many internal iterations as it
needs, but it may not be reported complete until every step succeeds.

### 1. Rehydrate from the accumulator

Start from the current checked-out branch and inspect the code and tests as they exist **after** all
previous batch commits. Read repository instructions and the current schema, bindings, package
boundaries, migrations, generated contracts, and related tests. Never implement against a stale
Repomix output or an imagined pre-batch tree.

Create a private checklist containing every numbered item in the batch prompt. For each item list:

- affected runtime, persistence, API/contract, authorization, UI, observability, deployment, and
  test surfaces;
- relevant headings from both update documents;
- pre-existing implementation that can be safely extended rather than duplicated; and
- objective acceptance evidence, including failure-path and isolation tests.

This checklist is a completeness ledger, not a substitute for code.

### 2. Implement vertical slices, one item at a time

For each item, make the smallest coherent **production** slice through all required layers. A slice
is incomplete if it adds only types, a UI shell, an in-memory happy-path mock, a TODO, or an
unwired service. Add real migrations and indexes, runtime bindings, authorization checks,
idempotency/concurrency behavior, configuration, telemetry, error behavior, and user surfaces when
the specification calls for them.

Before editing shared code, re-open its current version. Earlier items and batches are allowed to
change shared files; the current working tree is always the source of implementation truth. Reuse
canonical types and services instead of creating parallel abstractions. After each item, run its
focused tests and inspect the diff for accidental regressions before loading the next item's
specification. This bounded item loop prevents one feature's detail from displacing another while
preserving incremental integration.

### 3. Audit the whole batch rather than stopping after the first milestone

After all item slices are written, start a fresh audit pass from the batch prompt—not from the
implementation notes. Check every item line by line against the code. Search for unwired exports,
placeholder data, permissive defaults, missing negative paths, skipped migrations, absent bindings,
and UI controls that do not reach production handlers. Exercise cross-item interactions and tenant,
project, role, secret, egress, replay, race, retry, and rollback boundaries that the batch affects.

If agents are available, use them only as bounded, read-only reviewers for separate concerns such
as security, persistence, UI accessibility, and test coverage. Keep one writer responsible for the
accumulator so parallel agents cannot overwrite shared files or implement incompatible contracts.
The writer must verify every review finding in the current tree; reviewer output is evidence, not
authority.

### 4. Pass the batch gate and checkpoint it

Run focused tests throughout implementation, then run the repository's formatting/lint,
typechecking, complete test, and build checks at the batch boundary. Also run configuration parity,
migration, deployment-binding, and generated-contract checks relevant to changed packages. Do not
weaken, skip, delete, or replace a failing test merely to obtain green output. Fix the root cause,
rerun the failure, and rerun the batch gate.

Commit the completed batch as an atomic checkpoint. The next batch begins from that commit and
repeats the authority reads and discovery; it is never given a frozen context captured before the
checkpoint. Within a user-visible phase, continue automatically through every assigned batch—do
not stop after a subset to announce that the rest will be done later.

### 5. Definition of complete for a phase

A phase is complete only when:

- every listed batch has its own reconciled checklist, production implementation, tests, audit, and
  commit;
- all batch and full-suite gates pass on the final accumulator;
- migrations and deployment/configuration changes are present and reproducible;
- no known required item is represented only by a stub, TODO, mock, or release note;
- security and tenant/project isolation have negative tests, not only success-path tests; and
- a final phase-wide integration audit finds no regression in previously completed batches.

Token or context pressure is not a completion condition. When nearing a limit, persist a factual
handoff ledger (completed item IDs, exact changed files, test results, and remaining checklist),
start a fresh internal context from the current branch, and continue the **same task**. Do not return
a partial-success final response.

## Task 1 — Core substrate and sovereign agent (batches 1–4)

Implement these batches sequentially:

1. **Batch 01, items 1–19 — foundation and storage.** Build hierarchy and project isolation,
   generalized Artifact-backed `/workspace/`, `/.avos/` machinery separation, execution tiers and
   invisible hypervisor, synchronization, container backends/lifecycle, branching, time machine,
   and reasoning-aware history.
2. **Batch 02, items 20–24 — runtime, vault, and CLI.** Build the canonical runtime context, vault
   and outbound-secret boundary, WriteGuard/Jev preflight, all-CLI interception, scoped/extensible
   `$PATH`, and safe just-in-time CLI synthesis on the batch-01 substrate.
3. **Batch 03, items 25–38 — connectors, capabilities, and skills.** Build logical aliases and
   scopes, reauthorization, capability delegation and depth enforcement, public-channel stripping,
   ephemeral grants, turn routing, skill learning/catalogues, pipelines, and outbound DLP.
4. **Batch 04, items 39–46 — universal agent, memory, and context.** Build the one sovereign
   `NaelaoAgentDO`, executive-cabinet delegation, fast-actor versus durable-workflow routing,
   immutable kernel/firewall, planner-worker execution, layered memory, thread isolation, fact
   gating, and compaction.

Phase integration gate: prove a request can travel from an authorized user through the universal
agent, capability and WriteGuard boundaries, CLI/hypervisor selection, ArtifactFS mutation, and Git
checkpoint while forbidden cross-space, secret, and egress paths fail closed.

## Task 2 — Knowledge, collaboration, governance, and policy (batches 5–8)

Begin only from Task 1's tested accumulator and implement:

5. **Batch 05, items 47–54 — retrieval, citations, and MCP.** Implement sovereign role filtering,
   pre-filtered vectors, bitmask/envelope enforcement, ingestion and hybrid retrieval, authenticated
   citations, stateless inter-project MCP, and managed OAuth without bypassing Task 1 boundaries.
6. **Batch 06, items 55–60 — threads and Artifact concurrency.** Implement the allowed persistent
   thread tiers for parent agents, lossless solo promotion, SHA-256 OCC, distributed locks, trusted
   inline PR review, and safe staleness/rebase behavior for generalized deliverables.
7. **Batch 07, items 61–70 — task governance, provenance, and presence.** Implement atomic leases,
   spectators, semantic deduplication, sponsor RFC freezes, deliberation and alert ownership,
   immutable provenance, plan-clamped SR-EEO races with early cancellation, reconnect-safe presence,
   and invoker-attested split actors.
8. **Batch 08, items 71–75 — model policy, air gap, and sleep.** Implement certification and
   vertical whitelists, private LoRA ownership, local inference, physically enforced egress denial,
   and terminal project teardown while retaining auditable state.

Phase integration gate: prove retrieval cannot cross role or project boundaries, simultaneous
assistants cannot duplicate or corrupt a task, losing speculative workers are cancelled and
metered, provenance survives thread and branch operations, and air-gapped execution makes no
network or managed-model call.

## Task 3 — Product surfaces, automation, channels, economics, and final updates

Begin only from Task 2's tested accumulator and implement:

9. **Batch 09, items 76–87 — canvases, extensions, and widgets.** Implement progressive client and
   developer modes, domain canvases, the immutable-kernel/userspace-extension boundary, gadgets,
   durable daemons, tree-sitter indexing, MCP/MCP-UI exposure, generated widgets, and workflow
   taxonomy.
10. **Batch 10, items 88–103 — workflows, webhooks, and scheduling.** Implement ephemeral verb-like
    subagents, slim contexts and the three-depth ceiling, workflow durability, the complete ingress
    failure-defense chain, crons, shared calendar aliases, slot locks, receipt cards, and the
    capability-clamped no-code studio.
11. **Batch 11, items 104–111 — voice and customer channels.** Implement duplex telephony, call-desk
    projects, voice threads, reminder workflows, dictation, the executive channel, and the
    quarantined customer plane with telemetry—without Bash, Git, internal files, or vault access.
12. **Batch 12, items 112–119 — billing and export.** Implement credit metering, plans, per-user
    envelopes, escrow and depth-tier economics, autonomous-business controls, export and scrubbing,
    blueprint compilation, and security/sandbox gates.
13. **Batch 13, items 120–130 — marketplace and distribution.** Implement recipes and customer
    automations, the two-tier marketplace, pricing exclusivity, commissions, cycle ledgers and
    quotas, price floors, graduation, the self-hosted developer foundry, referrals, and market radar.

Then perform the two explicitly requested extra batches:

14. **Update reconciliation A — `Update the batches.md`.** Re-read the entire file, map all 18
    changes to concrete production code and tests across batches 1–13, and implement or correct
    every missing, partial, or superseded behavior. Verify especially topology, runtime
    bifurcation, SR-EEO/credit defenses, collision controls, extension immutability, durable
    daemons, no-code subagents, logical connectors/calendar, customer-plane quarantine, the
    13-point automation defense suite, generalized deliverables, and UI bifurcation.
15. **Update reconciliation B — `Updates2.md`.** Re-read the entire latest document and repeat the
    code-and-test trace against all 25 changes. This final authority pass must correct any remaining
    conflict, with particular attention to the all-CLI action space and namespaces, invisible
    routing/Jev checks, workflow and vision commands, three container backends and state migration,
    conformance harness, dogfooded extensions and STOP protocol, state scoping, hierarchical
    assistants, quarantined customer bots, developer-foundry template, and `/workspace/` versus
    `/.avos/` separation.

Phase integration gate: run end-to-end journeys for each project kind and both UI modes; extension,
daemon, webhook, schedule, and voice failure paths; customer-bot quarantine; budget exhaustion and
marketplace ledger invariants; export/import and scrub guarantees; container migration; emergency
STOP; and a final authority trace showing each of the 18 plus 25 update entries has implementation
and test evidence.

## Final delivery

Only after all three tasks and fifteen batch transactions are complete, run the clean-checkout
installation, lint, typecheck, full tests, build, migration/config parity, and end-to-end suites.
Review the cumulative diff for accidental generated files, credentials, debug bypasses, disabled
checks, and unrelated changes. Deliver one final report that lists completed batches, migrations and
operational changes, exact commands and results, and any genuine environmental limitation. Do not
describe an unimplemented item as future work; resolve it before final delivery.
