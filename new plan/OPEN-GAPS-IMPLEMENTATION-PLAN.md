# Remaining gaps implementation plan

Branch: `Mcbt5s-Backup-2`  
Status: implementation in progress; workstreams 1–3 are locally verified, workstreams 4–6 are partial, workstream 5's encrypted test-set vault and lifecycle are locally verified, and workstream 7's live acceptance is blocked on account configuration.
Basis: latest open-gap audit in `CONTINUATION-IMPLEMENTATION-PROGRESS.md`, reconciled against the current repository. Existing Foundry channel invocation, glossary, translation draft, model recommendations, owner voice, task-scoped email replies, and browser Web Push are present locally. Do not reopen them as missing features; their live/deployment checks remain open.

## Working rules

- Work through the workstreams in order. Before each implementation, search current code and tests again, read relevant repository instructions, and check later transcript amendments for the subsystem. The ledger records prior evidence, not blanket completion.
- Preserve cloud, private-machine, and local-model paths. Space placement, residency, and egress policy decide whether each provider can be used. Never add a forbidden cloud fallback.
- Verify vendor APIs and runtime support against current official documentation before relying on them. A public model catalog, sample repository, or model-authored proposal is not proof of entitlement, quality, pricing, or production readiness.
- Complete and test all locally possible work before asking for account settings, credentials, phone numbers, domains, or deployment access. Never put secret values in Git or chat.
- For each workstream, update this plan and `CONTINUATION-IMPLEMENTATION-PROGRESS.md` with changed files, migration/operator steps, test results, remaining blockers, and status. Commit and push the completed coherent work on `Mcbt5s-Backup-2`.

## Sequence

### 1. Language preference and end-to-end language handling

**Status:** implemented and locally verified. Platform-member and product-end-user preferences are isolated, authenticated, editable/clearable, and carried to the planner; translation quality remains unverified and is not claimed.

1. Trace signed-in platform-member and product-end-user identities independently. Decide where each preference belongs based on the existing authenticated data model; do not trust an end-user ID supplied in a request body.
2. Add a validated, explicit preferred-language field and authenticated read/update API. `auto`/unset must remain distinct from a chosen locale. Reject malformed or unsupported tags; make clearing a preference possible. Keep per-product end-user settings isolated by product.
3. Thread that preference into planner context with clear precedence: an explicit instruction in the current turn wins; otherwise use the saved preference; otherwise preserve the incoming language. Language detection candidates must never silently become a stored preference.
4. Use local detection only as a candidate source. Handle mixed/code-switched input and short or unsupported text by preserving original wording or asking. Translation remains a labeled draft, never authorization or a silent change to names, amounts, dates, or consequential terms.
5. Keep the existing Cloudflare translation path denied for air-gapped Spaces. Do not claim translation quality verification without a human-reviewed evaluation set for supported language pairs.

**Acceptance:** API authentication and cross-user/cross-product isolation tests; preference round-trip/clear/invalid-tag tests; planner precedence tests; mixed-language, short-text and unsupported-language cases; cloud-egress denial tests for private Spaces; no detector result persisted without explicit user action.

### 2. Bounded binary email attachment reading

**Status:** bounded PDF, DOCX, and existing UTF-8 text extraction are locally verified. OCR remains open and is not attempted by the attachment reader.

1. Inspect current task alias, R2 object, and HMAC authorization checks and retain the exact `(tenant, Space, task, key, expiry)` boundary.
2. Compare maintained parsers against current Cloudflare Workers compatibility, bundle limits, active maintenance, and licensing. Current support covers bounded unencrypted PDFs and DOCX only. Do not execute macros, scripts, embedded links, or HTML.
3. Define strict compressed and extracted-byte, page, archive-entry, CPU/time, and recursion limits. Reject malformed, encrypted/unsupported, zip-bomb, or over-limit files with a useful status. Treat extracted text as untrusted input and preserve provenance to the original attachment.
4. Add OCR only behind a separate placement-aware provider contract and explicit egress checks. Keep it unavailable for air-gapped Spaces; never silently upload private attachments.

**Acceptance:** real parser fixtures plus malformed/oversize/zip-bomb fixtures; extraction never escapes task ownership; no external fetches from document contents; private-space egress denial; production Worker dry run confirms bundle size. PDF and DOCX local parser fixtures pass. Live OCR/provider checks are separate; encrypted DOCX archives are rejected as malformed because the streaming parser exposes no portable encryption flag.

### 3. Customer telephony provisioning and ingress

**Status:** locally verified for importing, binding, signed Twilio ingress, consented customer calls, bounded cost/duration/concurrency admission, disabling, and release. Owner settings now expose credential verification, import, listing, disable, and release. Direct number search/purchase UI and live Twilio account/PSTN checks remain open; provider-specific and Cloudflare AI charges are not live verified.

1. Keep customer phone agents separate from owner voice calls and the Lead Planner session. Inspect the existing voice turn adapter, channel gateway, customer-bot authorization, and `twilio` catalogue entry.
2. Verify current official Cloudflare Agents voice documentation and the selected telephony provider's official APIs. Determine whether Cloudflare voice can be extended directly for PSTN or whether a provider adapter is required. Do not infer that WebSocket voice means PSTN number provisioning.
3. Define a provider-neutral lifecycle: owner/admin creates or imports a number, confirms region/capabilities/cost, explicitly binds it to one customer agent/Space, verifies webhook signatures and timestamps, handles replay/idempotency, rotates/unbinds, and deletes the number. Provisioning must be explicit and auditable. Current local implementation supports importing an existing Twilio number and explicitly releasing it. The owner UI now surfaces this lifecycle; searching and purchasing a new number remain open.
4. Add ingress controls before enabling public traffic: per-number and per-Space concurrency/duration/spend caps, abuse throttles, tenant isolation, call termination, retention/recording consent policy, and truthful unconfigured/error states. A phone caller must never gain planner owner authority. The current monthly spend cap accounts for quoted Twilio number and inbound-minute costs; Workers AI billing remains account-billed and is bounded here by call duration, turns, and response size, not by a verified dollar reservation.
5. Implement a provider adapter only after the lifecycle contract and verified provider API are settled. Keep number purchase and live calls disabled when credentials or verified numbers are absent.

**Acceptance:** signed webhook/replay/tenant-isolation tests; authorization and binding-denial tests; call-start/end/failure and cost-limit tests; mocked adapter contract tests explicitly labeled as mocked. Router test verifies owner-scoped telephony paths reach Agents, and owner settings expose credential, import, disable, and release operations. Direct search/purchase UI remains open. Live number provisioning and calls require provider credentials, a verified number, and account configuration after local checks pass.

### 4. Model capability, entitlement, modality, and cost routing

**Status:** partially implemented and locally verified on 2026-10-15. Fresh catalog evidence, Space-key isolation, exact OpenRouter usage pricing, project-cap reservation on script/legacy/channel paths, personal-credit reservation on script and legacy interactive paths, builder day/week/month quota holds on script and legacy interactive paths, fail-closed image modality admission on script runs, and propagation of the selected Space model into scheduled/webhook/customer-channel wakes are enforced. Model activation now runs an explicit owner-confirmed, fixed one-token request using the selected Space key and activates only on success. Per-channel model overrides and modality-specific worker dispatch beyond image denial remain open.

1. Audit exact model selection, BYOK resolution, Gateway/AI REST routes, model allowlists, billing settlement, local discovery, and air-gap policy. Keep planner and worker selection authorization separate.
2. Define a normalized capability record with source and freshness for text/image/audio/video input/output, tool calling, context size, and token pricing. Missing or stale fields mean unsupported/unknown, not inferred support.
3. Verify key-specific entitlement using an official provider operation or a narrowly scoped inference preflight. Public catalog presence alone cannot activate a model. The current activation button explicitly warns that the selected provider key may be charged and asks the owner to confirm a fixed one-token request; it sends no user content or platform fallback key. Never use inference as a hidden paid probe.
4. Add bounded routing that accounts for actual modality, context, tool requirements, Space policy, model-specific price, and user/Space caps. Before paid execution, estimate the request from known usage/prices and fail closed when cost or entitlement cannot be determined. Record actual usage separately from estimate.
5. Add explicit owner/admin preferences and advisory FDE/worker recommendations only after available capability data supports them. Keep recommendations distinct from automatic selection; require owner approval for activation. Local/private models must remain eligible under policy and cloud must not be used as a forbidden fallback.

**Acceptance:** table-driven modality and entitlement tests; stale/unknown catalog denial; exact BYOK tenant/key boundaries; price-estimate and over-cap denial; provider failure with no forbidden fallback; local/private route tests; audit of activation actor and model evidence. Live key entitlement remains provider-dependent.

### 5. LoRA consent, evaluation, and lifecycle

**Status:** locally implemented and verified for imported adapters, consent/provenance, encrypted versioned test-set storage, version/sample-count-matched owner-attested evaluation, approval, rollback, revocation, and deletion; owner/admin Settings controls expose lifecycle and vault operations. The interface accurately describes evaluation as owner-attested. A platform-run evaluation harness remains unavailable because no verified provider adapter execution contract is configured. Provider training remains disabled and live adapter compatibility is unverified.

1. Verify current official Workers AI fine-tuning/adapter support and the exact compatible base-model/adapter contract. Do not assume that accepting an adapter identifier proves compatibility or availability.
2. Model an explicit lifecycle: draft, consent/data eligibility check, training or external import, evaluation, owner approval, active, revoked, and deleted. Record Space, base model, provider evidence, data provenance, purpose, evaluator, and timestamps.
3. Require affirmative consent and a documented lawful basis before data enters a training job. Default to no cross-Space data. Exclude secrets, credentials, and protected content; support revocation and data deletion. Keep training and inference egress governed by Space placement policy.
4. Add evaluation gates against a versioned, consented test set, regression thresholds, and rollback to the prior model. Do not publish or activate an adapter from a successful training response alone.
5. If the currently supported provider has no verified training API, implement manifest validation, consent/provenance, evaluation record, and lifecycle controls for imported adapters, and leave training submission disabled with an explicit reason. Do not invent a vendor endpoint.

**Acceptance:** scope/consent denial tests, lifecycle transition tests, adapter/base-model mismatch tests, deletion/revocation behavior, evaluation threshold and rollback tests, air-gap denial tests, migration replay tests. Live compatibility requires a provider account and an actual supported adapter.

### 6. SQLite retention, archive, export, and restore

**Status:** owner/admin message-retention previews and holds, encrypted bounded R2 snapshots, scoped archive checks, persisted multipart chunk resumption, a previous-key rotation ring, per-archive rewrap, resumable owner/admin batch rewrap, retryable request identities, and merge-restore are locally implemented. Workstream remains partial because live R2 durability/account behavior is unverified.

1. Inventory each SpaceDO table, ownership, deletion behavior, backups, and schema version. Separate audit/legal retention requirements from product conversation retention; do not apply a generic TTL to all rows.
2. Define owner-visible per-Space retention settings and a dry-run preview that reports affected records/bytes. Require explicit policy selection for destructive deletion. Preserve necessary billing/security audit records under their own published retention rules.
3. Implement a versioned export manifest with Space identity, schema/migration version, checksums, object references, and timestamps. Encrypt archives at rest, enforce tenant-scoped object keys, and prevent cross-Space restore.
4. Make archive and restore resumable/idempotent with integrity verification, migration compatibility checks, and a tested rollback path. Keep active SQLite state canonical until restore verification succeeds.
5. Add quota forecasts and configurable warning thresholds from measured bytes; do not invent monetary pricing or claim archival savings without current account pricing evidence.

**Acceptance:** migration replay; export/import round trip; corruption and checksum failure; interrupted/restarted archive; duplicate replay; cross-Space denial; dry-run vs actual retention; retention exception tests; no hard deletion before a valid archive where archive policy requires one. Cloudflare R2 live durability/account checks remain separate.

### 7. Deployment and external acceptance checklist

**Status:** local migration/integration checks and Worker dry-runs are recorded in [`DEPLOYMENT-ACCEPTANCE-LOG.md`](./DEPLOYMENT-ACCEPTANCE-LOG.md). Live D1/Worker deployment, domains, VAPID, Twilio, model providers, and deployed R2 archive continuity remain unrun because this task has no production account configuration.

Run only after code and local integration checks are complete. No secret belongs in this file or Git.

- Apply deployed D1 migrations 0093 through 0098 in order and verify replay-safe schema state; verify SpaceDO migrations v72–v77 and ProductUserDO migration v4 after deployment.
- Configure an owned Cloudflare Email Routing ingress domain and verified sending domain, then test inbound task replies and outbound delivery.
- Configure Web Push VAPID public/private/subject values on Notifications Worker environments; test subscription, delivery, unsubscribe, and expired endpoint cleanup.
- Configure any selected voice/model/LoRA provider bindings only after the corresponding implementation gates pass; validate Twilio credentials, verify/import a controlled number, test signed call/consent/status callbacks, and verify spend caps and release cleanup.
- Confirm live provider behavior, residency/egress policy, rollback, and monitoring. Record each result as live, mocked, dry-run, blocked, or unrun.
- Configure and preserve a stable `SPACE_ARCHIVE_KEY` before production archives; verify a restore across a deploy using the same key and verify the R2 object references remain available.

**Acceptance:** every external check has a timestamp, target environment, test identity, result, and cleanup status; no item is marked passed from a dry run or mock.

### 8. Final completeness pass

After all workstreams above are complete, compare each remaining task in `CONTINUATION-IMPLEMENTATION-PROGRESS.md` with the implementation and its acceptance evidence. Search source amendments for corrections before closing any item. Re-run focused integration suites and restart/replay/failure tests. Mark each item `implemented and locally verified`, `live verified`, or `blocked` with a precise dependency; do not use an unqualified “complete.”

## Current next action

Workstreams 1–2 are locally verified. Workstream 3 has locally verified number import/calls/disable/release and owner UI for credentials, import, list, disable, and release; direct number search/purchase remains open, so W3 is partial. Workstream 4 remains partial: owner-confirmed key/model preflight is implemented, while per-channel model overrides and modality-specific dispatch beyond fail-closed image admission remain open. Scheduled, webhook, and customer-channel wakes honor the configured Space model and fail closed for dynamic models without fresh evidence. Workstream 5 has an encrypted Space-scoped test-set vault and only accepts evaluation records that match a stored set version and full case count; actual model scoring remains blocked on a verified provider execution contract. Workstream 6 has persisted multipart state, key rotation, and a resumable owner/admin bulk rewrap workflow; live R2 checks remain open. Continue remaining provider-independent W3/W4 work, then perform the final completeness audit. Live acceptance remains unrun. Never mark external checks passed from local tests.
