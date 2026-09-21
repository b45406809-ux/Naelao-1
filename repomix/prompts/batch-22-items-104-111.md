# AI Studio implementation prompt — batch 22, plan items 104–111

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Voice, executive, and quarantined customer channels**. This prompt is self-contained: the feature definitions and retained implementation
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


### 104. Native Duplex Telephony via `@cloudflare/voice`

**Final behavior:** Connects Cloudflare Calls (WebRTC SFU) directly to Workers AI Whisper STT, Llama 3.3, and edge TTS for sub-300ms phone desks.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 149. **A post-shipping pass over the SAME source list the 62-item plan came from
     (`long running.txt`, Google Drive) — it had been updated with fresh reports from live use
     AFTER those phases landed, so several items marked done were reported still broken. Ten real
     defects found and fixed, most of them the "fixed on one path, missed the other" class this
     file has now documented repeatedly.** Binary downloads corrupted (the knowledge worker read
     every response as text, so a PDF landed as mojibake — now reads bytes once and returns
     `encoding: "text"|"base64"`, refusing an oversized binary with 413 rather than truncating,
     since half a PDF is corrupt rather than
- The Gap The spec's voice calls require a phone number (VAPI phone_number_id) — users must receive a phone call to interact with the voice agent. For browser-based users, CF Realtime provides a WebRTC SFU running at CF edge (330+ PoPs, anycast) that routes browser audio directly to a VoiceDO WebSocket. The SFU WebSocket adapter (auto-reconnect as of May 2026) connects the browser's microphone stream to the VoiceDO's PCM input, eliminating the phone call requirement entirely for desktop/mobile web users.
- **Fix:**
- Shard: the router now calls `RATE_LIMIT_DO.idFromName(bucketKey)` directly — one DO per key
  instead of one DO for the whole platform. Token-bucket state per key is a single small row,
  so per-key DOs remove the chokepoint entirely and each key's traffic stays local to its own DO.
- Key: `claims?.sub ?? c.req.header("cf-connecting-ip") ?? "anonymous"` — `cf-connecting-ip` is
  set by Cloudflare's edge and cannot be spoofed by the client, unlike XFF.
- Prune: since a sharded DO now holds at most one key's row, `RateLimitDO` reschedules a DO
  alarm (`ctx.storage.setAlarm`) on every `/check` call (`IDLE_CLEANUP_MS` = 10 minutes) instead
  of extending it only on demand — the alarm
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 105. 24/7 AI Phone Receptionist Call Desk (`kind: "voice_agent"`)

**Final behavior:** Answers inbound phone calls, checks shared calendar availability, and commits appointments atomically, clamped strictly to Tier 1 Safe RAG.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the as
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- # 4. How the Entire Flow Works Together
Here is a real-world scenario demonstrating how these three features connect across the platform:
1. **Customer Inbound Voice Call (`kind: "voice_agent"`):**
   A client calls the clinic's phone number. The Cloudflare Calls edge agent answers, checks doctor availability, and books a 3:00 PM appointment for *"John Doe"*.
2. **Atomic Shared State Write (`SpaceDO`):**
   The voice agent writes to `space_calendar_events`. Instantly, `WsHubDO` broadcasts the event.
3. **Cross-Project Awareness (`doc_studio` & `ops_dispatcher`):**
   The clinic's doctor opens their **Document Studio (`doc_studio`)** workstation on desktop. The 3:00 PM appointment is already populated in their patient schedule panel.
4. **Voice-to-Text Dictation (`ComposerDock`):**
   The doctor clicks the 🎙️ **Voice Button** in chat and says:
   > *"Draft John Doe's clinical p
- ### Summary of What This Establishes:
1. **Vapi/Grok-Style Simplicity:** Complete visual and natural language control over greetings, system prompts, voices, interruption sensitivity, and business hours.
2. **Strict Telephony Guard:** The project explicitly requires an active phone line (1-click platform number or BYO Twilio) to receive/make calls.
3. **Automated Outbound Crons:** Workflows handle appointment reminder campaigns and lead follow-up calls automatically.
4. **Cross-Project Shared Calendar Integration:** Appointments booked over the phone commit atomically into **`SpaceDO` SQLite**, instantly visible to the doctor's document workstation and the founder's WhatsApp morning briefing.

### 106. Dual-Thread Voice Structure

**Final behavior:** Management Threads configure business hours and greetings. Call Session Threads hold audio recordings and sentiment summaries.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 71. **Project Journal, conversation memory + compaction, and the assistant/shell UI split are
    BUILT — and building them surfaced that the agent had NO conversation memory at all.**
    - **Project Journal** (`script-engine/project-journal.ts` + `prebuilt/project-journal.ts`).
      One `PROJECT.md` per project (`spaces/{id}/projects/{id}/PROJECT.md`, a SIBLING of
      `workspace/` so an ordinary file write can't spoof it): goal, standing instructions, status,
      todos, and a bounded log of what every agent did. Memory OS already shared L3/L4/L6 across a
      project and kept L5 private, but project STATE ("invoice.csv exists", "the payout task is
      done") was homeless, so two th
- Required Fix: Integrate Twilio Voice (or PagerDuty phone call) for CRITICAL-severity alerts: builder configures on-call phone number in notification preferences. On CRITICAL alert trigger: PagerDutyDO initiates Twilio voice call, reads alert summary via TTS ("Critical: Space customer-support is down. Error rate: 48%. Please acknowledge."). Call recipient presses 1 to acknowledge (silences further calls), 2 to escalate (calls backup number), 3 for runbook. Track voice_call_sent, voice_call_acknowledged, mean_time_to_acknowledge in on-call metrics. Builder can configure business hours → email only, after-hours → voice call. Enterprise: integrate with existing PagerDuty/OpsGenie instead of Twil
- **Fix — a wallet-specific role resolver, not a change to the generic one:** the generic
`resolveEndUserBusinessRole`'s root-is-`"member"` shortcut stays untouched (sessions, projects,
threads all still need it). New `resolveWalletAccessRole` (`business-auth.ts`) instead: for a
space with no `parent_space_id` (the product root), returns `null` — no product_end_user has any
legitimate wallet access there, full stop; for a business (child) space, delegates to the same
real `business_memberships` lookup as everything else, so a business owner/admin still reads
their OWN business's wallet exactly as before. Wrapped in a new
`requireBusinessMembershipForWallet` middleware (its own 5s-TTL cache, ke
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 107. Automated Outbound Telephony Reminder Workflows

**Final behavior:** Scheduled crons query tomorrow's bookings and dispatch automated confirmation calls, updating calendar state automatically.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- The Gap The billing handler calls await db.query('BEGIN'), await db.query('COMMIT'), and in the catch block await db.query('ROLLBACK'). DO SQLite (this.ctx.storage.sql.exec()) does not support explicit transaction control statements — each exec() call is automatically atomic and single-threaded within the DO. Sending 'BEGIN' as a standalone SQL statement is either a no-op or causes a parse error; the catch block's ROLLBACK then triggers a second error, leaving the handler in an unrecoverable state with partial billing data written.
- - `NaelaoAgentDO.settleRunBilling`: a new `NaelaoAgentDO.infraResourceTypeForTier(tier)` maps
  `ExecutionTier` 2-4 → `"isolate"`, 5 → `"container"` (Tier 1, in-process R2, is excluded — not a
  distinct CF resource, and `duration_ms` is always 0 there anyway). The infra-credit computation
  and recording now happens **before** the function's pre-existing `if (!tokensUsed) return;`
  early-out, not after — a pure script execution with zero LLM tokens (e.g. a scheduled
  `workflow.run` with no reasoning step) still consumes real isolate/container time and must not
  silently go unmetered just because it made no LLM call. Recorded via the same `/billing/usage`
  POST mechanism (`event_type: "i
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- ### 1. The Vapi-Style Voice Studio Architecture
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   VOICE AGENT PROJECT CANVAS (`apps/shell`)                           │
├───────────────────┬────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Telephony Line │ 🟢 **Live Number: +1 (305) 555-0199** [Verified & Active]                          │
│    (Required)     │ • Inbound: Enabled  │  Outbound: Enabled  │  Fallback: +1 (305) 999-1234 (Dr. Smith)   │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 2. Voice & Tone   │ • Voice Model: **Cartesia Sonic (Warm Female)**  │  Speed: **1.05x**               │
│                   │ • Greeting: *"Thank you for calling Miami Dental. How can I help you today

### 108. Native In-Composer Voice Dictation

**Final behavior:** WhisperFlow-style dictation in chat bar, capturing audio from browser microphone and transcribing via Workers AI Whisper for $0 compute.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- Required Fix Build a <VoiceInput> component: (1) Push-to-talk button: hold to record (releases to submit), or toggle mode (click to start, click to stop). Visual state: idle (microphone icon), recording (pulsing red circle + timer). (2) Waveform visualization: real-time audio level bar chart rendered on canvas (AudioContext analyser node). Shows user if microphone is picking up audio. (3) Real-time transcription preview: as the user speaks, partial STT results appear in a preview box above the button. (4) Transcription correction: after recording, the user can edit the transcription before submitting. (5) Error states: microphone permission denied (clear error with link to browser permission
- - **T2's real architectural prerequisite, resolved:** the shell's chat call path
  (`/spaces/:spaceId/sessions/:sessionId/agent/run`) had no concept of "which named agent" — it
  always addressed ONE DO instance per bare `sessionId`. Fixed at the source rather than adding a
  parallel endpoint: `/agent/run` now addresses `{sessionId}:{agentDefinitionId}` whenever an
  explicit `agent_definition_id` is given (unchanged, bare-`sessionId` addressing when it's
  absent — every existing single-agent session is unaffected). The new `/agent/mention-run`
  endpoint is a thin dispatcher on top of this, not a second reasoning path.
- **T3 scope note:** the soft/implicit lock-wrapping-every-R2-write id
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- # 3. Native Voice-to-Text in ComposerDock (WhisperFlow Style)
To give users a voice dictation experience (like Claude or WhisperFlow) in the chat bar, **`apps/shell` captures audio directly from the browser microphone and transcribes it at the edge using Workers AI `@cf/openai/whisper` for $0 compute cost.**
```
[ User presses Mic icon 🎙️ in ComposerDock and speaks ]
                          │
                          ▼ (Browser MediaRecorder captures 5s audio chunk)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. POST /api/voice/transcribe (To Cloudflare Router Worker)                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. RUN WORKERS AI WHISPER MODEL                                             │
│    `const res = await env.AI.run("@cf/openai/whisper", { audio: buffer })` │
├─────────────────────────

### 109. Private Executive Copilot Channel

**Final behavior:** An on-the-go Chief of Staff connecting the owner's personal WhatsApp/Telegram to the Space Assistant. Outside customers cannot reach this channel.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- Spec §05 (byte ~116k): *"One assistant per user per Space by default. Admin can raise
this limit."* The **company state is shared** and space-level — `SpaceDO` (members,
structure, billing) + `ProjectDO` workspaces (file **locks**, **version history**,
**real-time presence**, byte ~399k/§12) + threads + KB. Each user's assistant
(`assistants/{userId}/`, byte ~411k) is a personal chief-of-staff acting **on** that
shared company — it is **not** a private fork of the company. Two members' assistants do
not build two companies because they read/write the *same* `ProjectDO`. Coordination =
file locks + presence + **project deduplication** (admin's assistant broadcasts "this
already exists"). This
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- 190 - 192
We said user gets their own space/business assistant that they connect their own channels like WhatsApp or telegram etc should this also be there in non autonomous business templates the cowork templates
**YES, absolutely.** In fact, having WhatsApp and Telegram connected to non-autonomous / vertical cowork spaces is **one of your biggest competitive advantages over Harvey AI, Legora, and Claude Cowork.**
Products like Harvey AI or desktop Claude are **trapped on a desktop browser**. A lawyer walking into a courtroom, a doctor doing hospital rounds, an architect on a construction site, or an investment banker in a taxi cannot easily open a 15-inch laptop to check a document.
Giving every professional a **personal WhatsApp / Telegram channel to their firm's Cowork Space** turns the system into an on-the-go **Executive Chief of Staff**.
- 193 - 195
No in the venture templates channels are  for the owner is to access their assistant on WhatsApp telegram etc just like in vertical cowork but for connecting whatapp bots discord bots telegram bits etc like those customer service automations let's keep them under projects of kind=customer bots users can configure such projects to do customer service automations and even the execution ladder for these projects is lower to avoid security threats.
With this I realize there should be more project kinds besides customer bots and using plugins each will have different UI plus there should be project templates for each kind

### 110. Quarantined Customer-Facing Subagent Workflows

**Final behavior:** Main project agents are never customer-facing. Customer bots run as quarantined workflow subagents using restricted `CustomerBotContext`.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 140. **A ~62-item batch of live-use asks was planned and phased; Phase 1 (bug sweep + chat
     fidelity) is BUILT and deployed. Three of the reported "missing features" turned out to be
     DEAD CSS waiting for a component, and writing the test for one bug exposed a second, worse
     one underneath it.** Full plan (all 6 phases, decisions, deferred items):
     `/root/.claude/plans/gleaming-scribbling-pelican.md`; the user's own answers set the
     sequencing (bug sweep first), the billing model (hybrid personal-plan + business-subscription),
     channel scoping (both scopes, kind-gated UI) and project automations (build on
     `scheduled_jobs`/`event_triggers`, don't fork a second eng
- # naelao-workspace R2 bucket — agent filesystem and skills
spaces/
 {spaceId}/
 .skills/ # Space-level skills (Tier 2)
 {skill-name}/
 SKILL.md
 scripts/
 workflows/
 assistants/
 {userId}/ # Space Assistant filesystem
 cron-jobs.json
 skills/ # Assistant personal skills
 dynamic-tools/ # Self-authored Dynamic Worker tools
 channels/ # Channel configs (Slack, Discord, etc.)
 projects/
 {projectId}/
 workspace/ # Shared project workspace (ProjectDO manages locks)
 todo.md
 output/
 data/
 .versions/ # Version history (every file write)
 knowledge/ # Project knowledge docs
 workflows/ # Agent-authored Dynamic Workflows
 agents/
 {agentId}/
 workspace/ # Agent-specific workspace
 ski
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the as
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

### 111. Customer Conversation Telemetry & Parent Analytics Loop

**Final behavior:** Customer interactions store in SQLite. Parent agents periodically scan logs to extract bugs, compile sentiment, and alert on emergencies.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 140. **A ~62-item batch of live-use asks was planned and phased; Phase 1 (bug sweep + chat
     fidelity) is BUILT and deployed. Three of the reported "missing features" turned out to be
     DEAD CSS waiting for a component, and writing the test for one bug exposed a second, worse
     one underneath it.** Full plan (all 6 phases, decisions, deferred items):
     `/root/.claude/plans/gleaming-scribbling-pelican.md`; the user's own answers set the
     sequencing (bug sweep first), the billing model (hybrid personal-plan + business-subscription),
     channel scoping (both scopes, kind-gated UI) and project automations (build on
     `scheduled_jobs`/`event_triggers`, don't fork a second eng
- The Gap: Regulators and courts can issue data preservation orders requiring Naelao to produce specific builder or end-user data. No eDiscovery export capability exists. Manually extracting data from DO SQLite, R2, and Analytics Engine for a legal request would take days and be error-prone.
 Required Fix: Build eDiscovery export tool (admin-only): specify scope (builder_id, space_id, date_range, data_types). Workflow gathers: conversation history from ConversationDO, config history from SpaceDO, billing records from BillingDO, audit logs from AuditLogDO, Analytics Engine data. Packages into EDRM XML format (industry-standard eDiscovery format) or JSON. Signs package with platform private key
- **`workers/agents/src/do/NaelaoAgentDO.ts`**: new `run_traces` SQLite table (`ensureInit()`,
`PRIMARY KEY (run_id, seq)` — script-native runs mint their own `runId` with no `agent_runs` row
backing them, per the pre-existing gap that table only serves the legacy ReAct path, so this is
the first persisted-by-id record of a script-native run's existence). `persistRunTrace(runId,
tenantId, trace)` — unconditional SQLite insert (best-effort, swallows its own errors, same
"observability must never fail the run" posture as `logAgentActivity`), plus a best-effort
Analytics Engine mirror via `@naelao/tracing`'s `createTracer` when `env.ANALYTICS` is bound: one
root span (`script_loop.run`, run_id/te
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi

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
