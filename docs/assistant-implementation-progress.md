# Assistant communication and learning implementation

User-approved sequence; no live provider credentials are configured in this environment.

- [ ] Channel preferences/defaults/onboarding: settings and outgoing gates implemented; legacy channel ingress still open.
- [x] Persistent Cloudflare assistant email, inbox/drafts/send and owner command authorization.
- [x] Scoped email/SMS verification waits and private single-use browser delivery.
- [ ] Optional BYO/managed phone, calls/SMS/MMS and lifecycle billing.
- [ ] Browser/video demonstration learning, validation and schedules.
- [x] Existing model pool capability and live-price validation.
- [ ] Cross-scope tests, production build checks and live provider acceptance.

Every completed step is committed to matching work and Mcbt5s-Backup-2 remote heads.

## Step 1 — channel defaults and preferences

Implemented SDK validation/resolution for the two assistant kinds; template export/import
preserves defaults without copying user overrides. Added scoped Space/project settings,
onboarding controls and a live host gate before assistant notification dispatch.
Verified SDK/blueprint tests (6), Spaces/Agents/Shell type checks and whitespace checks.
Next: persistent generic assistant identities, email inbox/drafts/sending, then verification.
Existing external channel ingress still needs integration with effective channel settings.

## Step 2 — mailbox and email verification implementation

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

## Step 7 — private SMS website verification

Migration 0132 adds SMS transport to task-bound verification waits. Phone verification requires an
active SMS-capable binding, phone-channel availability, explicit owner opt-in, a website connection
owned by that same actor in the exact workspace, and an exact sender allowlist. A partial unique
index serializes pending verification across websites sharing one number; ambiguous/expired codes
never become a successful verification. The existing single-use browser fill path consumes codes
only for the matching run/actor/account, with current channel and binding policy checked again.
Worker inbox reads redact both matched verification messages and code-like unsolicited messages;
the authenticated owning human can review originals. They never become pending owner commands.
Added phone.verification tools and an opt-in control. Focused regression tests passed (40), and
Agents/Shell type checks passed. No real SMS was sent or received. Phone carrier acceptance for
individual websites remains provider/site-specific.


## Full Agents suite and integration follow-up

Ran all 168 Agents test files: initially 796 passed / 19 failed. Re-ran the six failing files in
an isolated checkout of pre-change commit 38a2ddda: the same 19 tests failed there. They reference
removed curated personas/templates, legacy attachment routes, earlier prompt layers and obsolete
worker groups. Added explicit communication and demonstration tool bundles to System One's
selection, and the default assistant profile now actually includes their built-ins. Custom workers
still receive only configured tools. Updated the worker-group regression to assert the previously
removed customer/foundry tools are not granted, while checking the new related tool bundles.
Focused combined tests now pass (85). The other pre-existing failures remain open; no removed
business functionality was restored to satisfy stale expectations.

Also hardened late UI results across assistant/Space changes: inbox reads and pagination,
owner-command review, website discovery and recording-save results cannot populate a newly
selected scope. Added carrier receipt/number reconciliation controls. An uncertain phone action
still requires provider verification and a new approval before retrying.

Remaining implementation is explicit: managed phone billing/renewal and spending settlement;
interactive planner-backed telephone conversations; inbound media retrieval and outbound MMS;
production multimodal video analysis with normal metering, workflow scheduling/reconciliation;
optional AgentMail provider wiring; email attachments/downloads and configured email event rules;
full legacy-channel ingress policy gating; and live provider/deployment acceptance. Offline
checks do not certify these remaining capabilities or a production deployment.

Final full-suite rerun: 799 passed, 17 pre-existing failures across five files (816 tests total).
The pre-change isolated checkout reproduced all 19 original failures; the worker-group assertions
are now green. Final Agents/Shell type checks and the production Agents Worker dry-run passed.
No live deployment, carrier call/message, or provider inference was performed.

Final retry review also bound demonstration replay journals to the durable task/root invocation,
skill digest, website connection and declared parameter values (hashed, never stored as literals).
Different inputs in one task no longer reuse an unrelated completion; the same invocation retried
under a new run attempt cannot blindly repeat an interrupted replay. Focused phone/learning tests
passed (20) after this correction. Early negative carrier reconciliation is held for two minutes
to avoid racing an in-flight provider request; a positive receipt is verified against the account.

## Phone history retention follow-up

Added bounded 30-day private phone event/draft cleanup and 35-day ingress-counter cleanup to
scheduled communication maintenance. Uncertain carrier actions and pending purchase outcomes
are retained for reconciliation. Shared command-inbox bodies retain their existing retention
owner. Every deleted object key is checked against the exact assistant namespace. The focused
phone regression suite and Agents type check passed. The larger implementation list above is
still open; this change does not activate managed telephony or live provider acceptance.

## Kernel boundary correction

Removed the built-in inbound assistant greeting for newly connected phones. Inbound calls are
rejected until an owner/template workflow supplies a greeting; Apps now exposes that configuration.
Existing configured greetings are preserved. Phone tests (14) and Agents/Shell type checks passed.
This is only a boundary correction: the fixed menu and legacy customer voice runtime still need
migration to extension handlers. Managed billing, interactive voice/MMS, production video analysis,
scheduling, remaining integrations and live acceptance remain unfinished and are not certified.
