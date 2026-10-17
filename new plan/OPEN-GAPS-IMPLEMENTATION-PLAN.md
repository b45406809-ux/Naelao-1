# Remaining gaps implementation plan

Branch: `Mcbt5s-Backup-2`  
Status: implementation in progress; W1 is locally verified; W2 covers bounded text/PDF/DOCX, explicit raster-image OCR, and isolated scanned-PDF rendering before OCR; W3 includes locally verified, owner-confirmed Twilio number purchase using short-lived official rate-card quotes, with live account checks still open; W4–6 are partial; and W7 live acceptance is blocked on account configuration.
Basis: latest open-gap audit in `CONTINUATION-IMPLEMENTATION-PROGRESS.md`, reconciled against the current repository. Existing Foundry channel invocation, glossary, translation draft, model recommendations, owner voice, task-scoped email replies, and browser Web Push are present locally. Do not reopen them as missing features; their live/deployment checks remain open.

## Working rules

- Work through the workstreams in order. Before each implementation, search current code and tests again, read relevant repository instructions, and check later transcript amendments for the subsystem. The ledger records prior evidence, not blanket completion.
- Preserve cloud, private-machine, and local-model paths. Space placement, residency, and egress policy decide whether each provider can be used. Never add a forbidden cloud fallback.
- Verify vendor APIs and runtime support against current official documentation before relying on them. A public model catalog, sample repository, or model-authored proposal is not proof of entitlement, quality, pricing, or production readiness.
- Complete and test all locally possible work before asking for account settings, credentials, phone numbers, domains, or deployment access. Never put secret values in Git or chat.
- For each workstream, update this plan and `CONTINUATION-IMPLEMENTATION-PROGRESS.md` with changed files, migration/operator steps, test results, remaining blockers, and status. Commit and push the completed coherent work on `Mcbt5s-Backup-2`.

## Sequence

### 0. Composable FDE package model and mentor-bot vertical slice

**Status:** architecture audit documented in [`FDE-EXTENSIONS-AND-MICROAPPS-ARCHITECTURE.md`](./FDE-EXTENSIONS-AND-MICROAPPS-ARCHITECTURE.md). The SDK now has a strict composable bundle parser for Canvas/channel primitives, worker invocation roles and execution tiers, host-managed connection requirements, and explicit Knowledge publication declarations. This is a package contract only: installation/signing/runtime binding, provider onboarding, published Knowledge search, external session storage, and the mentor vertical slice remain open. The public channel dispatcher still does not make a production mentor knowledge bot.

1. Unify the canonical package model, SDK, compiler, installer and runtime records. The FDE manifest must compose Canvas/Gadget, worker or command, channel handler, workflow, knowledge sources and required connections without conflating execution tier with authority. **Partially implemented locally (2026-10-17):** the install trust boundary accepts/persists a versioned bundle and derives its validated channel declarations for runtime; an owner/admin Channels form installs channel-only bundles with server-granted `channel.invoke`; provider requirements are checked and surfaced. It rejects mismatched IDs and duplicate legacy channel declarations. Preserve legacy manifests through explicit versioned migration. Still needed: signed source artifact compiler, actual Canvas/Gadget/worker-role installers and upgrade/rollback path.
2. Build a host-managed provider connection lifecycle one verified provider at a time. **Partially implemented locally (2026-10-17):** bundle channels may reference a provider-matched connection requirement and owner/admin project channel UI surfaces its purpose/readiness using the current host link. Still needed: choose one verified provider and implement its actual authorization/configuration, encrypted credential lifecycle, webhook lifecycle, revocation and reconnect. Do not assume every provider uses OAuth. The extension never receives connector secrets or owns webhook transport.
3. Add owner-published, project-scoped Knowledge collections. Uploading a project file is private by default. A channel installation may query only named published collections through a bounded search API; retrieved content is marked untrusted and source-attributed. Planner upload and Mentor Console upload use the same canonical Knowledge route. **Implemented locally (2026-10-17):** migration 0104, owner/admin publication API, exact indexed-document allowlists, a service-only filtered search endpoint, project-page publication controls, strict bundle references to explicitly external collections, host retrieval of only those installation-declared collections, and `ctx.channel.answer({question})` using a restricted text-only reasoner. Planner/Canvas uploads still need to join the same publication flow; immediate revocation/archive/deletion need broader end-to-end coverage.
4. Add a public-channel principal and bounded optional conversation-session API. Use opaque server-derived subjects, project sharding, TTL, per-project/per-subject limits, retention and deletion. Do not expose member IDs, raw SQL, Gadget actor IDs, unrestricted project files, or one Durable Object per external phone number.
5. Compose the mentor Console (private Canvas), Gadget settings/review state, published Knowledge, WhatsApp connection, external text handler, and optional event workflow as one owner-reviewed project-template installation. Make disabled/unconnected/failed components visible; no implicit fallback to the planner.
6. Prove the vertical slice with distinct mentor/admin, project-member, external-student, disconnected and revoked principals. A student can only query published course material and their own explicitly enabled session state. External channel events cannot invoke member tools, internal planner, another student's state, private files, or cross-project data.

The earlier `@naelao/sdk/channel` `receive/send` API mismatch was corrected in the current follow-up: `ChannelAdapter` is now declarative and `ChannelHandlerModule` types the host-invoked restricted `run(args, ctx)` entrypoint. `parseExtensionBundle` now validates composable package declarations and rejects unknown fields, dangling primitive references, unsupported worker/runtime labels, invalid Knowledge exposure, and connection-secret fields. It does not compile artifacts, authorize installation, or bind declarations to runtime grants. The existing legacy customer-bot Knowledge tool is Space-wide and is not a safe substitute for a project collection grant.

### 1. Language preference and end-to-end language handling

**Status:** implemented and locally verified. Platform-member and product-end-user preferences are isolated, authenticated, editable/clearable, and carried to the planner; translation quality remains unverified and is not claimed.

1. Trace signed-in platform-member and product-end-user identities independently. Decide where each preference belongs based on the existing authenticated data model; do not trust an end-user ID supplied in a request body.
2. Add a validated, explicit preferred-language field and authenticated read/update API. `auto`/unset must remain distinct from a chosen locale. Reject malformed or unsupported tags; make clearing a preference possible. Keep per-product end-user settings isolated by product.
3. Thread that preference into planner context with clear precedence: an explicit instruction in the current turn wins; otherwise use the saved preference; otherwise preserve the incoming language. Language detection candidates must never silently become a stored preference.
4. Use local detection only as a candidate source. Handle mixed/code-switched input and short or unsupported text by preserving original wording or asking. Translation remains a labeled draft, never authorization or a silent change to names, amounts, dates, or consequential terms.
5. Keep the existing Cloudflare translation path denied for air-gapped Spaces. Do not claim translation quality verification without a human-reviewed evaluation set for supported language pairs.

**Acceptance:** API authentication and cross-user/cross-product isolation tests; preference round-trip/clear/invalid-tag tests; planner precedence tests; mixed-language, short-text and unsupported-language cases; cloud-egress denial tests for private Spaces; no detector result persisted without explicit user action.

### 2. Bounded binary email attachment reading

**Status:** bounded PDF, DOCX, and existing UTF-8 text extraction are locally verified. Explicit owner-enabled OCR covers task-owned PNG/JPEG images and scanned PDFs; PDF pages are rendered by a separately scoped Document Container before the existing OCR operation. Live Workers AI quality and Cloudflare container execution remain unverified.

1. Inspect current task alias, R2 object, and HMAC authorization checks and retain the exact `(tenant, Space, task, key, expiry)` boundary.
2. Compare maintained parsers against current Cloudflare Workers compatibility, bundle limits, active maintenance, and licensing. Current support covers bounded unencrypted PDFs and DOCX only. Do not execute macros, scripts, embedded links, or HTML.
3. Define strict compressed and extracted-byte, page, archive-entry, CPU/time, and recursion limits. Reject malformed, encrypted/unsupported, zip-bomb, or over-limit files with a useful status. Treat extracted text as untrusted input and preserve provenance to the original attachment.
4. Add OCR only behind a separate placement-aware provider contract and explicit egress checks. Keep it unavailable for air-gapped Spaces; never silently upload private attachments. Implemented for one raster PNG/JPEG image per action using a fixed Cloudflare Workers AI OCR model, explicit owner opt-in, 1 MiB/20 MP input limits, 1,024 generated-token cap, and 20 calls per rolling Space-day. It returns untrusted text and stores no image/OCR result. Scanned PDFs are first rendered in the isolated Document Container with a 1 MiB input, five-page, 2048-pixel edge, 5 MiB aggregate output, and bounded CPU/time limits.

**Acceptance:** real parser fixtures plus malformed/oversize/zip-bomb fixtures; extraction never escapes task ownership; no external fetches from document contents; private-space egress denial; production Worker dry run confirms bundle size. PDF/DOCX extraction and scanned-PDF rendering/OCR routes have local fixtures. OCR settings, image bounds, task ownership, fail-closed egress, and SQLite daily quotas are locally tested with a mocked AI response; live quality/provider checks are separate. Encrypted DOCX archives are rejected as malformed because the streaming parser exposes no portable encryption flag.

### 3. Customer telephony provisioning and ingress

**Status:** locally verified for importing, binding, signed Twilio ingress, consented customer calls, bounded cost/duration/concurrency admission, disabling, release, stale-call reconciliation, and an explicitly confirmed paid number purchase flow. Owner settings expose credential verification, read-only availability search, import, listing, disable, release, and quote-then-buy. The quote uses Twilio's current country/number-type monthly rate and candidate's inbound rate, rechecks availability and rates immediately before purchase and verifies rates afterward; it is a short-lived estimate, not inventory reservation or a guaranteed locked provider price. Live Twilio account/PSTN checks remain open; provider-specific and Cloudflare AI charges are not live verified.

1. Keep customer phone agents separate from owner voice calls and the Lead Planner session. Inspect the existing voice turn adapter, channel gateway, customer-bot authorization, and `twilio` catalogue entry.
2. Verify current official Cloudflare Agents voice documentation and the selected telephony provider's official APIs. Determine whether Cloudflare voice can be extended directly for PSTN or whether a provider adapter is required. Do not infer that WebSocket voice means PSTN number provisioning.
3. Define a provider-neutral lifecycle: owner/admin creates or imports a number, confirms region/capabilities/cost, explicitly binds it to one customer agent/Space, verifies webhook signatures and timestamps, handles replay/idempotency, rotates/unbinds, and deletes the number. Provisioning must be explicit and auditable. The owner UI searches current availability and supports import, quote, explicit purchase confirmation, binding, disable, and release. Purchase quotes expire after three minutes, hold monthly-budget capacity, and require a separate owner confirmation; the provider price is rechecked before and after purchase. Twilio's documented monthly rate is country/number-type based, so the displayed amount is not a locked or guaranteed per-number quote; price changes trigger release or an explicit unresolved state.
4. Add ingress controls before enabling public traffic: per-number and per-Space concurrency/duration/spend caps, abuse throttles, tenant isolation, call termination, retention/recording consent policy, and truthful unconfigured/error states. A phone caller must never gain planner owner authority. Implemented locally: the monthly spend cap accounts for quoted Twilio number and inbound-minute costs; Workers AI billing remains account-billed and is bounded here by call duration, turns, and response size, not by a verified dollar reservation. Scheduled reconciliation confirms stale calls against the account-scoped Twilio Call resource before settling; provider failures leave reservations in place for a later retry.
5. Implement a provider adapter only after the lifecycle contract and verified provider API are settled. Keep number purchase and live calls disabled when credentials or verified numbers are absent.

**Acceptance:** signed webhook/replay/tenant-isolation tests; authorization and binding-denial tests; call-start/end/failure and cost-limit tests; mocked adapter contract tests explicitly labeled as mocked. Router test verifies owner-scoped telephony paths reach Agents; search tests cover query bounds, voice filtering, and provider failure; purchase tests cover explicit confirmation, changed-price rejection, replay denial, air-gap denial, ambiguous provider outcomes, and owner resolution. Live number provisioning and calls require provider credentials, a verified number, and account configuration after local checks pass.

### 4. Model capability, entitlement, modality, and cost routing

**Status:** partially implemented and locally verified on 2026-10-15. Fresh catalog evidence, Space-key isolation, exact OpenRouter usage pricing, project-cap reservation on script/legacy/channel paths, personal-credit reservation on script and legacy interactive paths, builder day/week/month quota holds on script and legacy interactive paths, fail-closed image modality admission on script runs, and propagation of the selected Space model into scheduled/webhook/customer-channel wakes are enforced. Model activation runs an explicit owner-confirmed, fixed one-token request using the selected Space key and activates only on success. Owner/admin per-channel selection of a built-in model now applies to inbound and scheduled customer-channel replies; modality-specific dispatch beyond image denial and provider-specific entitlement remain open.

1. Audit exact model selection, BYOK resolution, Gateway/AI REST routes, model allowlists, billing settlement, local discovery, and air-gap policy. Keep planner and worker selection authorization separate.
2. Define a normalized capability record with source and freshness for text/image/audio/video input/output, tool calling, context size, and token pricing. Missing or stale fields mean unsupported/unknown, not inferred support.
3. Verify key-specific entitlement using an official provider operation or a narrowly scoped inference preflight. Public catalog presence alone cannot activate a model. The current activation button explicitly warns that the selected provider key may be charged and asks the owner to confirm a fixed one-token request; it sends no user content or platform fallback key. Never use inference as a hidden paid probe.
4. Add bounded routing that accounts for actual modality, context, tool requirements, Space policy, model-specific price, and user/Space caps. Before paid execution, estimate the request from known usage/prices and fail closed when cost or entitlement cannot be determined. Record actual usage separately from estimate.
5. Add explicit owner/admin preferences and advisory FDE/worker recommendations only after available capability data supports them. Keep recommendations distinct from automatic selection; require owner approval for activation. Local/private models must remain eligible under policy and cloud must not be used as a forbidden fallback.

- Implemented 2026-10-15: owner/admin channel settings can select a finite allowlisted built-in model per connected channel or inherit the Space model. The Agents API checks membership, active status, model policy, and egress policy. Inbound dispatch resolves the channel override; scheduled drains fan out by enabled channel and filter each Durable Object queue by channel. Corrupt/stale override values fail closed. Migration 0099 adds the nullable override. This does not implement audio/video routing.

**Acceptance:** table-driven modality and entitlement tests; stale/unknown catalog denial; exact BYOK tenant/key boundaries; price-estimate and over-cap denial; provider failure with no forbidden fallback; local/private route tests; audit of activation actor and model evidence. Live key entitlement remains provider-dependent. Per-channel override tests cover selection, corrupted-value fail-closed behavior, and migration replay.

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

**Fresh local checkpoint (2026-10-17):** Spaces, Agents, Notifications, and Billing Wrangler dry-runs pass on `Mcbt5s-Backup-2`; Agents builds all three configured containers. See the timestamped acceptance log for tool versions, bundle sizes, and the existing Wrangler warnings. This does not change the live acceptance status.

Run only after code and local integration checks are complete. No secret belongs in this file or Git.

- Apply deployed D1 migrations 0093 through 0101 in order and verify replay-safe schema state; verify the current SpaceDO and ProductUserDO migration versions after deployment.
- Configure an owned Cloudflare Email Routing ingress domain and verified sending domain, then test inbound task replies and outbound delivery.
- Configure Web Push VAPID public/private/subject values on Notifications Worker environments; test subscription, delivery, unsubscribe, and expired endpoint cleanup.
- Configure any selected voice/model/LoRA provider bindings only after the corresponding implementation gates pass; validate Twilio credentials, verify/import a controlled number, test signed call/consent/status callbacks, verify spend caps and release cleanup, and deliberately omit a completion callback to verify scheduled provider reconciliation.
- Confirm live provider behavior, residency/egress policy, rollback, and monitoring. Record each result as live, mocked, dry-run, blocked, or unrun.
- Configure and preserve a stable `SPACE_ARCHIVE_KEY` before production archives; verify a restore across a deploy using the same key and verify the R2 object references remain available.

**Acceptance:** every external check has a timestamp, target environment, test identity, result, and cleanup status; no item is marked passed from a dry run or mock.

### 8. Final completeness pass

After all workstreams above are complete, compare each remaining task in `CONTINUATION-IMPLEMENTATION-PROGRESS.md` with the implementation and its acceptance evidence. Search source amendments for corrections before closing any item. Re-run focused integration suites and restart/replay/failure tests. Mark each item `implemented and locally verified`, `live verified`, or `blocked` with a precise dependency; do not use an unqualified “complete.”

## Final local acceptance and remaining dependencies (refreshed 2026-10-17)

The provider-independent implementation pass and final local audit are complete. Fresh verification on the current branch:

- `corepack pnpm --filter @naelao/agents-worker test`: 93 files, 381 tests passed after the W3 purchase slice.
- `corepack pnpm --filter naelao-spaces test`: 40 files, 116 tests passed.
- `corepack pnpm --filter @naelao/shell typecheck`: passed.
- `corepack pnpm --filter naelao-spaces exec vitest run src/infra-migrations.test.ts`: passed with migration 0101; the complete ordered D1 replay is covered by that suite.

Remaining items require a verified runtime/provider contract or external account configuration; no local implementation is being represented as live acceptance:

- **W2 scanned-PDF OCR:** bounded page rendering is implemented in the isolated Document Container and locally verified; the Agents route enforces task ownership, owner opt-in, egress policy, input/page/output limits, and quota before OCR. Focused route tests and Agents typecheck passed in the 2026-10-17 W2 refresh. Cloudflare container runtime and live OCR quality remain unrun. This supersedes the earlier `unpdf` limitation; no Worker-side canvas renderer is used.
- **W3 paid Twilio number purchase:** local owner-confirmed purchase is implemented using current official country/number-type monthly pricing and per-number inbound rates, with three-minute budget holds, provider rechecks, replay protection, cleanup, and ambiguous-result recovery. Twilio's published rate is not a guaranteed locked price or reserved inventory. Account-specific billing, live provisioning, PSTN and reconciliation checks still need an owner-configured account and controlled number.
- **W4 audio/video worker dispatch:** text/image request construction is bounded and dynamic models are checked against fresh modality evidence; audio channel inputs are transcribed through their existing explicit ingress path. There is no verified generic audio/video request format shared by the supported providers and local tunnel, so unsupported media must not be sent by guessing. Provider-specific key entitlement is tested only by explicit owner-requested model preflight.
- **W5 platform-run adapter evaluation/training:** imported-adapter lifecycle, encrypted test set, provenance/consent and owner-attested scoring are implemented. No verified provider execution/training compatibility API is available; platform scoring and training submission remain disabled.
- **W6/W7 live archive acceptance:** multipart restart, encryption, rotation and restore have local/mock evidence. Cross-deployment R2 durability, production D1/Worker state, email domains, Web Push credentials, live model/telephony behavior, and rollback/monitoring require the configured Cloudflare/provider accounts and deployment authority.

The 2026-10-17 continuation refreshed local evidence for W2–W7. W2–W6 code verification and the W7 Wrangler package results are recorded in the dated continuation entries and deployment acceptance log. The latest W7 dry-runs pass; the account-dependent items above remain open.

Do not reopen completed local workstreams merely because a live integration is unconfigured. Record any future live check as live, mocked, dry-run, blocked, or unrun with its target and timestamp.

## W3 quote-and-purchase implementation update (2026-10-15)

This later update supersedes the earlier W3 statement above that number purchase remained disabled. The purchase path is now enabled only through a short-lived owner/admin quote and explicit confirmation; it reports current rate-card values, reserves the monthly rental amount against the Space cap, rechecks price and availability before purchase, and checks returned number identity and current rates afterward. Rate-card data does not guarantee the final provider charge. A price/persistence mismatch triggers provider release; ambiguous provider outcomes keep the quote in `processing` and its budget held until the owner imports the number or confirms after account inspection that no purchase occurred.

Official sources checked: Twilio [Phone Numbers Pricing](https://www.twilio.com/docs/phone-numbers/pricing), [Voice Pricing](https://www.twilio.com/docs/voice/pricing), and [IncomingPhoneNumber resource](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource). The code uses country/number-type monthly prices and the documented raw snake_case inbound-price response, and no longer assumes an undocumented `price` property on imported numbers.

## Communications strategy update (2026-10-15)

- Twilio remains the default paired WhatsApp transport and the current owner-confirmed PSTN number provider. An owner may optionally configure Meta Cloud API directly per Space using its WhatsApp Business phone-number ID and access token. The per-Space choice takes precedence over the platform Twilio sender. Meta may charge per business-to-user message; there is no product promise of a free 1,000 service conversations. Current send/media Graph API version defaults to `v26.0` and can be configured for future version changes.
- Cloudflare Realtime SFU is not yet integrated into Naelao's voice pipeline. Its documented responsibilities require application signaling, identity/authorization, and backend credentials; its pricing page lists $0.05/GB egress after the shared 1,000-GB monthly allowance. Thus a browser WebRTC path could reduce telecom dependence but is not guaranteed to cost $0, does not issue PSTN numbers, and is not presently an implemented click-to-call product path.
- Telnyx and Africa's Talking are not integrated. Their official documentation could not be verified through this environment's network proxy, so the plan does not repeat asserted pricing or coverage figures. Keep Twilio as the easy default; add carrier adapters only after validating current country availability, pricing, regulatory and webhook contracts.
- OCR remains the task-scoped email PNG/JPEG prebuilt operation described in the progress log, not a generic tool available to all workers. Scanned-PDF OCR remains open pending a bounded Worker-compatible page renderer.

Official docs reviewed: [Cloudflare Realtime SFU overview](https://developers.cloudflare.com/realtime/sfu/index.md), [SFU setup](https://developers.cloudflare.com/realtime/sfu/get-started/index.md), [SFU pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/index.md), [Cloudflare AI audio example](https://developers.cloudflare.com/realtime/sfu/examples/ai-audio/index.md), [Meta WhatsApp send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages), and [Meta WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).
