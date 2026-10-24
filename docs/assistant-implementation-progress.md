# Assistant communication and learning implementation

User-approved sequence; no live provider credentials are configured in this environment.

- [ ] Channel preferences, template defaults, onboarding and runtime enforcement.
- [ ] Persistent assistant email, inbox/drafts/send, owner command authorization.
- [ ] Scoped verification waits and browser delivery.
- [ ] Optional BYO/managed phone, calls/SMS/MMS and lifecycle billing.
- [ ] Browser/video demonstration learning, validation and schedules.
- [ ] Existing model pool capability and live-price validation.
- [ ] Cross-scope tests, production build checks and live provider acceptance.

Every completed step is committed to matching work and Mcbt5s-Backup-2 remote heads.

## Step 1 — channel defaults and preferences

Implemented SDK validation/resolution for the two assistant kinds; template export/import
preserves defaults without copying user overrides. Added scoped Space/project settings,
onboarding controls and a live host gate before assistant notification dispatch.
Verified SDK/blueprint tests (6), Spaces/Agents/Shell type checks and whitespace checks.
Next: persistent generic assistant identities, email inbox/drafts/sending, then verification.
Existing external channel ingress still needs integration with effective channel settings.

## Step 2 — mailbox and verification implementation (validation in progress)

Added migration 0130 for canonical Space-user / shared Project assistant identities, encrypted
inboxes and attachments, pagination, drafts, recipient-scoped standing send policy, verified
profile controller pairing and app-issued single-use command tokens. Matching From addresses
alone produce pending commands, never autonomous runs. Legacy hashed agent aliases migrate
lazily without changing valid addresses. Provisioning hooks seed identities on Space/project
creation when the email channel is enabled; missing domains report pending/configured status.

Added per-task verification waits and stable per-website aliases. Codes and confirmation links
are encrypted and redeemed only by the matching browser host/run/actor/connection. Worker
views redact account mail; authenticated owners can review their own originals. Secret-filling
browser sessions withhold screenshots until reopened; DOM receipts redact supplied values.
Added Space/private-user erasure and retention, byte/message ingress bounds and uncertain-send
reconciliation. Focused regression tests passed (41); Agents/Browser/Spaces/Provisioner/Shell type checks passed. Production Agents worker dry-run passed with unchanged container builds disabled (`--containers-rollout none`); the normal container rebuild ran out of Docker disk space, and only unused build cache was pruned. No live provider test was possible.
Next: commit this validated checkpoint, then implement optional BYO/managed calls/SMS/MMS,
browser/video demonstration skill lifecycle, and capability-aware current-model selection.

## Step 3a — optional assistant telephony (BYO checkpoint)

Added migration 0131 and scoped persistent phone bindings for personal Space assistants and
shared Project assistants. Apps supports storing scoped Twilio credentials, attaching an owned
number, explicit current-price rental quotes/purchases, call/SMS approval drafts, inbound SMS/MMS
metadata, DTMF, voicemail/transcription opt-in and a human transfer destination. New worker tools
and the `phone` CLI expose only inbox/draft/approved-send operations, never provisioning or policy
authority. Webhooks verify the official Twilio signature and provider account, active scope,
channel and egress policies. Paired caller numbers create pending commands, never automatic owner
runs. Concurrent submission claims and uncertain-outcome states prevent blind retries. Deleting
an assistant first detaches its BYO number and restores prior callbacks; it never silently releases
a customer's carrier number. Released/detached histories do not block future binding.

Fresh focused tests: 54 passed (communications, ingress, CLI and telephony primitives), including
20-way purchase races, 30-way sends, 20 duplicate ingress callbacks, signature rejection, changed
channel policy, pagination ties and erasure. Agents and Shell type checks and the production Agents Worker dry-run passed. No live carrier calls were made.

Still open in the phone phase: managed-number prepaid billing/renewal/usage settlement; interactive
planner-backed calls; inbound media download and outbound MMS; SMS website-verification waits;
reconciliation UI and full call/number cleanup/retention. Managed numbers deliberately report
unavailable, and the existing WhatsApp carrier account is never implicitly charged. Calls in this
checkpoint speak an approved message; the UI/manual do not claim interactive AI conversations.
Next: complete these phone paths, then browser/video demonstrations and model capability selection.

## Step 4 — capability-aware worker selection

Worker tasks can declare bounded media/context requirements. Selection uses fresh public
OpenRouter card evidence (modalities, tools, context), passed through to System One and exposed
in `agent.list_models`; unsupported/stale candidates cannot satisfy a visual/video task merely
because their name sounds capable. This only narrows the existing owner-configured price-filtered
pool; provider/payer, subscription admission, pinned economy ceiling and private/local routing
remain enforced. A single eligible model is now selected correctly even when System One exists.
Requirements are signed into the delegation contract, persisted with worker sessions and restored
on resume, then rechecked against fresh evidence at child admission. Capability gaps fail clearly
without silently buying a frontier model or widening the pool. No model was added automatically.
Fresh validation: Agents type check and 24 focused model-catalog/routing/delegation tests passed.
No live provider inference/latency benchmark was run (no configured provider credentials).

## Step 5a — browser demonstration skills and video draft safety

Added private per-author/per-assistant-workspace semantic demonstration skills, separate from
Space-shared executable scripts. Website accounts can record/pause/discard actions and save a
reviewable draft with a final success assertion. Typed values become parameters; stored handles,
literal secrets, credential-field recording, arbitrary code and terminal commands are refused.
Replay resolves fresh, unique role/name targets before every action and uses the normal browser
operations/grants/approvals. Actual replay plus final assertion produces validation evidence;
a separate authenticated Apps action explicitly enables that tested digest. Workers cannot enable
their own drafts. Interrupted replays stay held for review; repeat calls in the same run reuse a
saved completion instead of doing the work again. Apps exposes review, enable, disable and delete.
Erasure also covers learning data even when the author never provisioned a mailbox.

Replaced the old video-to-executable-selector path with scoped semantic drafts. Video reads now
check workspace paths, delegated file grants, type, declared/actual byte size and a 20 MiB limit.
Generated actions do not store demonstrated input values. Syntax checks no longer claim that a
video or trace was verified. A configured multimodal analyzer is still required: production does
not currently wire one, so uploaded-video interpretation reports unavailable rather than claiming
it watched the file. Source videos remain the user's workspace files; no new raw recording copies
are created by this path.

Fresh validation: 69 focused communication/model/learning/CLI tests passed, including 30-way draft
creation, cross-user/project isolation, changed and ambiguous targets, missing assertions, private
input parameterization, enable gating, real interpreter replay, digest tampering and no blind replay.
Agents and Shell type checks and the production Agents Worker dry-run passed.
Still open: configured production video/frame analyzer and its metering, schedule UX, reconciliation
of interrupted demonstrations, and sharing/promoting a reviewed private demonstration explicitly.

## Step 6 — credit forwarding regression found during phone billing preparation

Fixed the existing end-user credit proxy dropping idempotency_key before ProductUserDO, which
could double-charge a retried agent run despite the DO's own deduplication. Added bounded debit
request parsing and positive integer/retry-key validation. Balance, debit, reservation and monthly
refresh routes now reject a signed token for a different tenant; root resolution also rejects
cross-tenant parent references. Existing credit test setup used a removed commerce endpoint and
silently seeded no balance; fixtures now seed the actual DO directly without restoring commerce.
Fresh tests: 40 passed, including 30 concurrent repeated debit requests charging only once,
malformed requests and cross-tenant mutation rejection. Spaces type check passed. This does not
activate managed carrier resale or introduce a wallet.
