# Batches 01–04 phase integration audit

The integration journey in `tests/integration/phase-01-sovereign-runtime.test.ts` exercises the canonical contracts in order: concealed project authorization, signed capability verification and WriteGuard, invisible tier selection, normalized ArtifactFS mutation, and reasoning-complete turn checkpoint. Its negative journey verifies private-project concealment, unsigned destructive-write denial, host-only outbound credential injection, and serialized nested-payload DLP.

## Authority re-audit

* Batch 01 IDs 1–19: traced in `BATCH_01_CHECKLIST.md`; backend migration and metadata failures are fail closed.
* Batch 02 IDs 20–24: traced in `BATCH_02_CHECKLIST.md`; encoded mutations and scoped JIT persistence are covered.
* Batch 03 IDs 25–38: traced in `BATCH_03_CHECKLIST.md`; connector tenant scope, depth ceiling, and nested egress are covered.
* Batch 04 IDs 39–46: traced in `BATCH_04_CHECKLIST.md`; immutable prompt boundaries, direct firewall enforcement, DAG ordering, and worker budget are covered.

No new TODO, placeholder, mock production handler, credential, generated Repomix output, or client-controlled infrastructure selector was introduced. Production adapters remain responsible for Cloudflare binding I/O; shared contracts now fail before those side effects.

## Production wiring follow-up

The shared contracts are now called by the production `ScriptToolSurface` inside `NaelaoAgentDO`, not only by SDK tests: destructive `Bash` calls are checked immediately before dispatch against the original human, project, expiry, and HMAC. MCP Hub resolves durable tenant-scoped connector aliases and applies serialized DLP immediately before both provider and direct MCP egress. Migration `0075_phase1_runtime_security.sql` supplies durable alias, capability-nonce, and versioned scoped virtual-CLI registries. The shell renders explicit fail-closed cards for WriteGuard and DLP denials.
