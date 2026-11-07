# Trust, security, and data lifecycle: a codebase research pass

**Purpose:** identify the next platform improvements at the boundaries where Naelao data, credentials, code, and actions cross trust domains. This is a research and design document only; no product code is changed.

**Repository inspected:** branch `Mcbt5s-Backup-2`, commit `c1326ce2`. This pass complements the workspace, runtime, and wider platform proposals. External platform claims were checked against primary documentation on 2026-11-07. Recommendations are proposals; risk statements labeled *inference* should be validated against deployed configuration and provider contracts.

## Executive view

Naelao already has strong primitives that many systems add late: tenant-scoped authorization, credential encryption and mediated use, egress policy, SSRF checks, redaction, effect receipts, tenant-aware erasure, extension signatures, and sandbox allocation accounting. The biggest remaining opportunity is to make trust boundaries and data lifecycle promises explicit end to end.

Four items deserve priority:

1. **Make deletion a tracked lifecycle, not a collection of successful delete calls.** The code can remove rows and R2 objects, but users need to know when live copies, provider recovery copies, logs, and restorable backups have reached their respective deletion states.
2. **Treat runtime and provider boundaries as explicit data transfers.** Show which data, credentials, residency, and egress permissions a run receives; preserve a receipt for the decision and resulting external action.
3. **Make signing and runtime provenance independently verifiable.** Signed extensions are a useful start; bind publisher approval, build inputs, compiled artifacts, sandbox images, and deployment to one verifiable chain.
4. **Turn security assumptions into adversarial acceptance tests.** Especially test cross-tenant identifiers, stale authorization after suspension, prompt-injected data exfiltration attempts, DNS changes between validation and connection, and deletion during retries.

These changes do not require a universal policy engine. Keep authorization at the resource owner, secrets in the credential service, canonical workspace mutation in the publication service, and runtime isolation in the provider. Standardize the evidence passed between them.

## 1. Data inventory and deletion receipts

### What exists now

- `workers/workflows/src/workflows/erasure-cleanup.ts` performs paginated D1, KV, and R2 cleanup. It deletes sandbox workspace blobs and records, space artifacts/repository/workspace prefixes, and other tenant-owned operational records while retaining selected financial and audit data.
- `workers/spaces/src/product-user-erasure.ts` checks tenant ownership, then deletes product user DO state before deleting the discovery roster row.
- Communication erasure deletes scoped records and related R2 message/learning objects with checked keys and cursors.
- Workspace and artifact history now have explicit storage records, so future erasure needs to include manifests, snapshots, staging blobs, publication receipts, and aliases.

These are strong foundations. They do not by themselves prove the full deletion lifecycle: the operation spans multiple services and buckets, some writes may be retried, and external providers control some copies and backup windows.

### Proposal: a deletion manifest per request

Create a durable erasure request manifest with a stable request ID, subject/resource scope, policy version, request time, and one task per data surface. A task identifies the owning service, exact tenant/resource key scope, expected count or byte range when measurable, state (`pending`, `running`, `deleted`, `retained_by_policy`, `provider_pending`, `failed`), last cursor, attempts, and evidence receipt. Keep the manifest free of erased content and minimize retained subject identifiers.

The workflow should:

1. Place the resource in a mutation barrier: revoke sessions and tokens, stop new provider operations, and mark it unavailable to ordinary reads.
2. Discover references from authoritative inventories rather than guessing object prefixes alone.
3. Delete in idempotent batches and save each cursor/receipt before advancing.
4. Retry transient failures; leave permanent or ambiguous failures visible and actionable.
5. Verify absence by querying each authoritative index and sampling object-head checks, without re-reading/logging content.
6. Emit a completion receipt that distinguishes immediate deletion from provider retention or legally retained accounting records.

R2 lifecycle rules are useful for age-based expiry, but Cloudflare says objects are typically removed within 24 hours of expiration and existing objects may take longer after a lifecycle configuration change. Treat lifecycle as a backstop, not a synchronous erasure guarantee. R2 object deletion is strongly consistent, although cached copies may still be served. [R2 object lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

### The backup and restore wrinkle

Cloudflare SQLite-backed Durable Objects support point-in-time recovery to a point in the previous 30 days. That is valuable for recovery but creates a product and operations question: if an erased object is restored to a prior state, how does the restore process replay deletion tombstones before serving data? The recommendation is to maintain an erasure tombstone index outside the restored data set, replay it during recovery, and prohibit restored tenants from becoming readable until replay and verification finish. This is an architectural inference from the documented PITR window, not a claim that PITR itself violates erasure. [SQLite Durable Object storage and PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Cloudflare DO alarms and queues can deliver work at least once. Therefore cleanup tasks need idempotency and persisted cursors; the deletion manifest must remain authoritative after retries. (The existing code already guards repeated/missing cursors in key cleanup paths.)

### Provider and user semantics

Agent37's current public privacy policy says a deleted Cloud instance keeps a recovery copy for seven days before permanent purge, while account deletion is described on a 30-day schedule; its DPA describes immediate storage erasure with backups deleted after seven days. These are vendor statements and differ in phrasing by document, so Naelao should obtain a binding, account-applicable contract and present the exact instance-vs-account behavior to customers. Do not describe a provider delete API acknowledgment as physical backup purge. [Agent37 privacy policy](https://www.agent37.com/privacy), [Agent37 DPA](https://www.agent37.com/dpa)

**Failure modes to design for:** tenant deletion starts while a queue retry recreates an artifact; object listing misses an indexless orphan; a DO is restored to pre-delete state; the provider returns success before backup expiry; or the cleanup workflow expires after a partial batch. Keep tombstones and a reconciliation scanner until all applicable horizons have passed.

## 2. Tenant isolation as a verifiable path

Naelao's scope checks are distributed by design: request authentication, service binding, tenant/project lookup, DO identity, database predicate, R2 key, and audit receipt can live in different layers. A correct check at one layer does not prove the full path is scoped correctly.

### Proposal: build an isolation map and test its joins

For each high-value operation, document and test this chain:

`authenticated principal → authorized tenant/space/project → service identity → DO/database key → object/blob key → emitted receipt`

Use a typed, immutable scope object at internal boundaries containing tenant, space, optional project, actor, and run ID. Construct it from trusted authentication and ownership lookups, not from client headers alone. At every persistence boundary, use a predicate or object-key builder that requires that scope. At every cross-DO call, bind authorization to the target object's identity and operation. Audit receipts should store scope IDs and decision metadata, never bearer secrets or user file contents.

The purpose is not to duplicate authorization checks blindly; it is to make mismatched identifiers impossible to combine accidentally. Add negative tests that pair a valid tenant token with another tenant's project, filesystem, export key, branch, provider connection, and child DO ID. Also test deleted/suspended tenant state after a queued job or long-running session was admitted.

### Property-based and mutation tests

Add generated tests for path and identifier normalization: encoded separators, dot segments, Unicode normalization, case folding, trailing dots, duplicate query parameters, and boundary lengths. Mutate a valid scope tuple one field at a time and require denial before any side effect. For erasure and cleanup, inject a failure after each batch and replay the task; assert no cross-scope deletion and eventual convergence.

This follows OWASP's current GenAI risk guidance: prompt injection can target tool behavior and sensitive data, so user-provided or retrieved content cannot be treated as an authorization signal. A model instruction saying “use the other project's token” must remain ordinary untrusted input. [OWASP GenAI Top 10](https://genai.owasp.org/llm-top-10/), [OWASP Sensitive Information Disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/)

## 3. Secrets, outbound data, and consent

### Existing strengths

`workers/credentials/src/index.ts` makes the credentials service the plaintext egress boundary: callers identify credentials logically, outbound access checks scope and space policy, it validates destinations and redirects, records pending receipts for writes, blocks automatic replay after ambiguous dispatch, bounds payload/response sizes, and redacts returned secret strings. `packages/security/src/egress-policy.ts` uses exact host grants, rejects wildcards, limits scheme/port, and calls the SSRF check. `workers/agents/src/script-engine/vault-proxy.ts` runs DLP checks before proxying.

The product direction should preserve this narrow boundary as new workspace, browser, and provider integrations are unified. The workspace service should never become a secret transport or silently grant network access because a file can be read.

### Improve the meaning of “approved egress”

An approved hostname only answers *where* a request may go; it does not answer whether a specific data class may leave, for which purpose, or under which user's authorization. Add a compact outbound decision receipt with destination host, connector/action, data classification, policy version, run and actor, credential alias (not value), user approval basis, and request/result digests. Keep sensitive payload screening as defense in depth, not as a claim that arbitrary prompt-injected text can be perfectly classified.

For high-impact external actions, request approval against a digest of the action (destination, operation, relevant fields) and expire that approval quickly. If the payload changes after approval, require a new decision. Continue to require provider idempotency where supported and surface ambiguous outcomes rather than retrying. For low-risk read-only calls, policy can pre-authorize a narrow connector/action scope.

### Validate host resolution at connection time

The code authorizes an outbound URL and invokes the SSRF check before `fetch`, then repeats validation for redirects. *Inference / test target:* because the hostname is resolved again by the fetch stack, test whether DNS answers can change between validation and the actual connection. If the runtime/provider allows safe pinning, bind the validated IP while preserving TLS hostname verification; otherwise use a controlled egress proxy that resolves and connects as one operation. Test private, link-local, IPv4-mapped IPv6, CNAME chains, rebinding, and redirect chains. Do not claim a DNS rebinding vulnerability without demonstrating this path on the deployed runtime.

Workers' current platform limits include CPU/resource caps and bounded request sizes; use bounded egress timeouts, response ceilings, and cancellation so a stalled upstream does not hold execution or billing resources indefinitely. [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)

### User-facing trust controls

Before a run starts, show concise answers to: which runtime/provider will execute it; what workspace revision and credential aliases are available; whether network access is enabled and which hosts/actions are allowed; what data may be sent to external model/app providers; and any retention behavior that differs from Naelao's default. During execution, show approvals, external actions, blocked egress, and publication status as events with receipts. Keep the interface specific: “Sent repository files to provider X for task Y” is more useful than a generic “AI may use data” warning.

## 4. Supply chain and runtime provenance

Naelao has publisher signatures for extension releases in `packages/agent-sdk/src/extension-publisher-signatures.ts` and stores signature, key, revocation, host signature, and artifact digest data in `SpaceDO`. The source signature protects the canonical manifest and source artifacts; a separate host digest attests the compiled runtime artifacts. This is a good structure to extend.

### Proposal: verify a complete provenance chain

For each executable unit, record immutable digests and provenance for:

- source release and publisher key;
- dependency lockfile and build toolchain;
- build recipe and builder identity;
- compiled extension or sandbox image digest;
- runtime admission decision and provider-reported image identity;
- deployment release and rollback target.

Require policy to verify the digest at the point of execution, not only at upload. Key revocation should block new executions and identify already-running sessions that need drain/restart. Rotate publisher keys with overlapping validity and a signed revocation/transition record. Keep the private signing key outside normal application Workers and outside tenant-controlled runtime; use a dedicated signing service or offline release workflow. The extension key-pair generation code currently creates an extractable key pair so the public key can be exported; do not use that helper for production private-key custody without a deliberate key-handling design.

For container dependencies, generate an SBOM and provenance statement from the pinned source, lockfile, builder, and final OCI digest. Verify package and daemon version compatibility at CI and admission. A pinned version tells us *which* input was selected; provenance and signatures tell us whether the deployed output came from that input. Neither alone proves that the code is benign.

**Risks:** introducing attestations that are checked only in CI but ignored at runtime; changing publisher-key trust without revoking a compromised key; mutable tags resolving differently over time; or a compromised build identity signing malicious output. The chain needs independent verification, short authority scope, audit history, and a tested rollback/revocation playbook.

## 5. Logs, analytics, and support access

Data minimization should apply to telemetry as well as application data. Naelao's existing observer and audit requirements correctly exclude file contents. Extend that to prompts, credentials, request/response bodies, signed URLs, and low-entropy hashes that could reveal sensitive content. Prefer operation IDs, byte counts, provider/model identifiers, policy versions, status codes, and coarse error classes.

Create a field-level telemetry catalog with owner, purpose, retention, access group, and deletion behavior. Sample or aggregate high-cardinality metrics; keep detailed security receipts in bounded, access-controlled storage. Add an automated canary test: send unique synthetic secrets through a test run, then scan logs, traces, analytics, error captures, and support exports for raw and encoded forms. The test should fail deployment if values appear.

Support access should be time-limited and scoped to a tenant/resource, require a recorded reason and explicit customer approval where appropriate, and be auditable. Separate access to metadata from access to content. Break-glass operations should alert and expire automatically. These controls are particularly important for encrypted provider backups and customer-declared private workspace content.

## 6. Threat scenarios and acceptance criteria

Use these as a compact security research backlog. Each item is an experiment or requirement, not an assertion that the present code is vulnerable.

| Scenario | Required result |
|---|---|
| Prompt injection asks an agent to export another tenant's files or credentials | Authorization denies at the owning service; no content reaches egress; a content-free denial receipt is written |
| Tenant is suspended after a run is admitted but before external dispatch | Recheck blocks dispatch; no credential resolution or provider mutation follows |
| DNS answer changes from public to private between URL validation and socket connect | Connection is blocked by atomic egress resolution/pinning or controlled proxy; no request reaches private address |
| User deletes a project while jobs, alarms, or queue messages are retrying | Mutation barrier blocks recreation; cleanup manifest converges; retries cannot cross into sibling project data |
| R2 object is restored from cache or a DO is restored through PITR | Erasure tombstone is applied before reads; deleted data is not reintroduced to users or runtimes |
| Extension publisher key is compromised | Revocation blocks future admissions, records affected releases/sessions, and operators can roll back to a verified digest |
| Provider delete acknowledges, but recovery data remains for its contractual window | UI and API distinguish service deletion from backup purge date; no false claim of immediate irreversible purge |
| Sensitive value appears in a thrown exception or tool output | Response, logs, analytics, workflow state, and support bundle redact or exclude it |

Before broad launch, collect actual provider evidence for deletion SLAs, region placement, backup encryption, breach notification, subprocessors, and audit artifacts. Provider marketing pages are not a substitute for contracts, account-level settings, or observed deployment configuration.

## 7. Suggested order of work

1. **Inventory and promise:** publish a data-flow/retention map for each data class, service, provider, log, and backup. Define what “deleted” means for live storage, caches, backups, and legal retention.
2. **Deletion manifest:** extend current erasure workflows with per-surface receipts, tombstones, verification, provider-pending states, and restore replay. Start with project/workspace deletion.
3. **Threat tests:** add generated cross-tenant scope mutation tests and fault-injected erasure retry tests; verify suspension gates around provider dispatch.
4. **Egress decision receipts:** link approvals and data class to current credential-mediated outbound actions; test DNS resolution and redirects in the actual runtime.
5. **Supply-chain chain:** add signed provenance/SBOM and admission digest verification to extension and sandbox image paths; prove key revocation with a running and a not-yet-started session.
6. **User/operator surfaces:** show provider, egress, current data lifecycle, action receipts, and deletion progress. Add the synthetic-secret observability canary.

Measure correctness first: cross-scope disclosures and unauthorized side effects must stay at zero; deletion completion needs measurable convergence and no resurrection after recovery; telemetry canaries must remain absent. Then measure user trust signals, support burden, storage cost, and false-positive friction so added controls do not make routine work unusable.

## Sources

- Cloudflare [R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/), and [SQLite Durable Object storage/PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
- Cloudflare [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/).
- OWASP GenAI Security Project [Top 10](https://genai.owasp.org/llm-top-10/) and [Sensitive Information Disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/).
- Agent37 [Privacy Policy](https://www.agent37.com/privacy) and [Data Processing Agreement](https://www.agent37.com/dpa). These are vendor statements and must be checked against the applicable customer contract and enabled provider configuration.
