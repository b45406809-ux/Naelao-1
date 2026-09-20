# Repomix hand-off for plan items 1–130

The repository cannot be packed faithfully into one 1,045,000-token prompt: the authoritative
source trail alone is larger than that before production code or tests are added. Use the thirteen
dependency-ordered packs below. They overlap intentionally at security, router, persistence and
shared-contract boundaries so each model turn can implement and verify a real vertical slice.

## Generate the packs

From the repository root:

```bash
node repomix/build-prompts.mjs
for config in repomix/batch-*.json; do
  npx --yes repomix@1.18.0 --token-budget 1000000 --config "$config"
done
```

Do **not** add `--compress`, `--remove-comments`, or `--remove-empty-lines`. Every configuration
uses XML, full source, repository-relative paths and `showLineNumbers: true`, which gives AI Studio
stable locations from which to generate unified diffs. Every config reads its tracked batch prompt
directly, so an individual `npx repomix` command works in a clean checkout without first creating
`.repomix-cache/authority-batch-*.md`. Pack outputs live under the ignored `repomix/outputs/`
directory because they are reproducible and very large.

## Manual AI Studio batch loop

1. Run the **Generate Repomix batch** workflow described below, or generate a pack locally with
   `npx --yes repomix@1.18.0 --token-budget 1000000 --config
   repomix/batch-01-foundation-storage.json`.
2. Download the workflow artifact. The XML already embeds the matching self-contained batch prompt
   as its Repomix instruction, and the prompt is also included separately for convenience.
3. Paste/upload the XML to Gemini AI Studio. Gemini is instructed to return one raw unified Git
   diff beginning with `diff --git`.
4. Download the response as `repomix/patches/batch-NN.patch` and commit that one file to the current
   accumulator branch.
5. The **Apply Gemini batch patch** workflow treats the upload as data rather than executable shell,
   checks and applies it with `git apply`, regenerates and validates the prompts, commits the code,
   and uploads the next batch XML and prompt. For batch 13 it emits a refreshed batch-13 pack so the
   final repository state can be audited.

If Gemini wraps the diff in a single `diff` Markdown fence, the applicator normalizes it. Do not
upload a `.sh` file: accepting an AI-generated executable would let model output run arbitrary
commands in GitHub Actions, whereas a unified patch is declarative, reviewable, and validated before
application.

## What prompts the model

`repomix/prompts/` contains one self-contained implementation prompt per batch. The build script
has already read the chronological design material and folds the final feature definition,
retained dependent constraints, production ingress/persistence expectations, and required
verification into each numbered item. The implementation model is explicitly told not to reread
or cite the planning archive. Each prompt requires complete unified diffs, deployment operations,
realistic verification, and an honest release ledger, and forbids ellipses, pseudo-code,
TODO-only stubs, UI placeholders, and success-only mocks.

The prompt compiler applies this chronology before the implementation model sees the prompt:

1. repository state is evidence, not authority;
2. `CLAUDE.md` is the older baseline;
3. expanded gaps and Appendix A1 supply relevant constraints;
4. linked conversation files are newer than `CLAUDE.md` and override it on conflict;
5. each `Origin & Transition` trail is read left-to-right, with its rightmost/final conversation
   decision winning.

The generated prompt contains the resolved result rather than the design journey. Earlier passages
are retained only when they supply implementation constraints on which the final feature still
depends; the finalized behavior remains normative if wording conflicts.

`Update the batches.md` is the newest architectural authority. `build-prompts.mjs` assigns each
reconciled change only to the batches that own its affected runtime, persistence, or user surface;
cross-cutting changes are repeated where a later batch must enforce the same invariant. In every
generated prompt, these changes explicitly override superseded plan text. `verify-configs.mjs`
checks that all 18 changes reach every intended prompt, while each paired JSON pack includes the
concrete implementation boundaries needed to act on them without pulling in unrelated subsystems.

## Automated sequential implementation

`run-phase.mjs` executes the selected batches in numeric order. For every phase it regenerates the
current Repomix pack, rotates through comma-separated Gemini API keys and models on quota/transient
failure, validates and applies an AI-produced unified diff, supports bounded continuation turns,
runs the configured verification command, and commits the phase before generating the next pack.
Responses and patches are retained in ignored `.phase-runs/` for debugging.

The `Implement full plan with rotating AI models` workflow runs all 13 phases in one job by
default, pushes an accumulator branch, and opens a pull request. Configure the repository secret
`GEMINI_API_KEYS` as one key or a comma-separated rotation. Workflow inputs can restrict the phase
range, model list, continuation ceiling, and verification command.

Each run has a 1,000,000-token hard budget, leaving roughly 45,000 tokens for the AI Studio system
prompt and generated diff. If a future source file pushes a batch over budget, Repomix exits
non-zero rather than silently truncating it. Run `npx --yes repomix@1.18.0 --config <config>
--token-count-tree 5000` to find the growth; move a cohesive subsystem to an adjacent batch rather
than excluding its authorization, persistence, configuration, or tests.

## Batch boundaries

1. **Items 1–19 — foundation/storage:** hierarchy, project isolation, Artifact Git, execution ladder, workspace synchronization and container lifecycle.
2. **Items 20–24 — runtime/vault/CLI:** runtime SDK, vault injection, WriteGuard, virtual CLI interception and safe CLI synthesis.
3. **Items 25–38 — connectors/delegation:** logical connector scoping, reauthorization, capability delegation, skills, prompt catalogues and outbound DLP.
4. **Items 39–46 — agent/memory/context:** the universal kernel, prompt/firewall, planner-worker execution, layered memory, thread isolation, fact gating and compaction.
5. **Items 47–54 — retrieval/citations/MCP:** sovereign role filtering, Cohere ingestion, grounded hybrid search, authenticated citations, project MCP and both managed OAuth brokers.
6. **Items 55–60 — threads/artifact concurrency:** four thread tiers, lossless solo promotion, SHA-256 CAS, distributed locks, trusted PRs and safe rebases.
7. **Items 61–70 — task governance/provenance/presence:** leases, spectators, intent/RFC gates, deliberation and alerts, cryptographic provenance, model races, reconnect-safe presence and invoker actors.
8. **Items 71–75 — model policy/air-gap/sleep:** certification, LoRA ownership, local inference, physical egress denial and terminal project teardown.
9. **Items 76–87 — canvas/extensions/widgets:** display modes, seven project canvases, extension/gadget/daemon host, project MCP exposure, MCP-UI, generated widgets and workflow classes.
10. **Items 88–103 — workflows/webhooks/scheduling:** subagent topology, workflow compilation, authenticated buffered ingress, replay/idempotency/circuit breaking, crons and calendar locking.
11. **Items 104–111 — voice/customer channels:** native telephony, voice project threads, reminders/dictation, the executive channel and quarantined customer automation/telemetry.
12. **Items 112–119 — billing/export:** credit metering, subscriptions, budgets, wallet economics, venture export, scrubbing, compilation and marketplace security gates.
13. **Items 120–130 — marketplace/distribution:** recipes, template pricing, commissions and cycle ledgers, price floors, graduation, partner portal and market radar.


After each batch, run its included tests plus the complete typecheck/config-parity suites. Feed the
next pack the committed result, not an uncommitted patch, so its directory tree and line numbers
describe the actual accumulator branch.

## Pack-size guard

All 13 configurations are exercised with Repomix 1.18.0 and the `o200k_base` tokenizer. Both GitHub
Actions workflows pass `--token-budget 1000000`, so a growing pack fails rather than producing a
silently truncated hand-off. Use `--token-count-tree 5000` to identify growth and move a cohesive
subsystem to an adjacent batch rather than removing its authorization, persistence, configuration,
or tests.
