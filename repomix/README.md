# Repomix hand-off for plan items 1–130

The repository cannot be packed faithfully into one 1,045,000-token prompt: the authoritative
source trail alone is larger than that before production code or tests are added. Use the thirteen
dependency-ordered packs below. They overlap intentionally at security, router, persistence and
shared-contract boundaries so each model turn can implement and verify a real vertical slice.

## Generate the packs

From the repository root:

```bash
node repomix/prepare-authority-context.mjs
for config in repomix/batch-*.json; do
  npx --yes repomix@1.18.0 --token-budget 1000000 --config "$config"
done
```

Do **not** add `--compress`, `--remove-comments`, or `--remove-empty-lines`. Every configuration
uses XML, full source, repository-relative paths and `showLineNumbers: true`, which gives AI Studio
stable locations from which to generate unified diffs. Generated authority extracts and pack
outputs live under `.repomix-cache/`, which is intentionally ignored because they are reproducible
and very large.

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

## Verified pack sizes

Measured with Repomix 1.18.0 and the `o200k_base` tokenizer on this commit:

| Pack | Files | Tokens |
|---|---:|---:|
| 01 foundation/storage | 245 | 777,336 |
| 02 runtime/vault/CLI | 248 | 733,230 |
| 03 connectors/delegation | 224 | 798,613 |
| 04 agent/memory/context | 252 | 995,943 |
| 05 retrieval/citations/MCP | 204 | 717,547 |
| 06 threads/artifact concurrency | 272 | 948,133 |
| 07 task/provenance/presence | 235 | 840,228 |
| 08 model policy/air-gap/sleep | 227 | 887,897 |
| 09 canvas/extensions/widgets | 256 | 982,971 |
| 10 workflows/webhooks/scheduling | 258 | 843,082 |
| 11 voice/customer channels | 281 | 909,460 |
| 12 billing/export | 259 | 986,549 |
| 13 marketplace/distribution | 293 | 795,425 |

These are deliberately below the configured 1,000,000-token guard. Pack 04 is the tightest; if
the agent kernel grows, split items 39–42 from 43–46 rather than removing Memory OS or its tests.
