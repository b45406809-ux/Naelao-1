# AI Studio implementation prompt — batch 11, plan items 104–111

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Voice, telephony, private channels, and customer automation**. This prompt is self-contained: the feature definitions and retained implementation
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
     since half a PDF is corrupt rather than smaller); the Sub-agents panel queried the space-wide
     assistant DO while a spawn records into the session's own DO, so it was structurally always
     empty; `thread.create` still produced "Session not found" (the spaces-worker session proxy
     derived `end_user_id` for only one of the two caller shapes); the Compact button hit a route
     that ran space-wide maintenance and never touched the session it was invoked from; `effort`
     capped its own ladder at the model's native reasoning-level count, so `ultra` was rejected on
     models that could serve it; the personal-plan checkout still went LS-first after the Whop
     cutover; `thread.send_message` rendered as the assistant apparently answering its own
     question (now a collapsible on-behalf card, paired to the reply that follows it); the
     project-thread page was unusable on a phone; and the agent had no way to see which models or
     agent templates existed (`agent.list_models`, plus four free-tier Gemini models added to the
     catalogue).
     - **The two reported chat bugs were both about the SERVER transcript, and had separate root
       causes.** A reload discards every scrap of client state, so anything wrong after a reload is
       wrong in the database. *"I got a reply but when I reload it's gone"*: `NaelaoAgentDO` wrote
       the answer back with `void` — a promise still pending when a DO handler returns may never
       run, so the write raced the response (the same class as item 136's `recordWakeFailure`).
       Awaited now; safe because `writeAgentAnswerToSession` already swallows its own errors, so it
       still cannot turn a successful run into a failed one. *"the reload duplicate is still
       there"*: `POST /messages` was not idempotent and `apps/shell`'s `apiFetch` retri
- The Gap The spec's voice calls require a phone number (VAPI phone_number_id) — users must receive a phone call to interact with the voice agent. For browser-based users, CF Realtime provides a WebRTC SFU running at CF edge (330+ PoPs, anycast) that routes browser audio directly to a VoiceDO WebSocket. The SFU WebSocket adapter (auto-reconnect as of May 2026) connects the browser's microphone stream to the VoiceDO's PCM input, eliminating the phone call requirement entirely for desktop/mobile web users.
- **Fix:**
- Shard: the router now calls `RATE_LIMIT_DO.idFromName(bucketKey)` directly — one DO per key
  instead of one DO for the whole platform. Token-bucket state per key is a single small row,
  so per-key DOs remove the chokepoint entirely and each key's traffic stays local to its own DO.
- Key: `claims?.sub ?? c.req.header("cf-connecting-ip") ?? "anonymous"` — `cf-connecting-ip` is
  set by Cloudflare's edge and cannot be spoofed by the client, unlike XFF.
- Prune: since a sharded DO now holds at most one key's row, `RateLimitDO` reschedules a DO
  alarm (`ctx.storage.setAlarm`) on every `/check` call (`IDLE_CLEANUP_MS` = 10 minutes) instead
  of extending it only on demand — the alarm only actually fires once a DO has seen no traffic
  for the full idle window, at which point it clears its own `buckets` table. No sweeper needed.
- Preserved exactly: token-bucket math (capacity = 2× per-minute limit, refill = limit/60 per
  second), the 120/min default, fail-open on error, and the `X-RateLimit-*` response headers.

### 105. 24/7 AI Phone Receptionist Call Desk (`kind: "voice_agent"`)

**Final behavior:** Answers inbound phone calls, checks shared calendar availability, and commits appointments atomically, clamped strictly to Tier 1 Safe RAG.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 118. **Real streaming, and the agent now TALKS between tool calls — item 117's two stated
     limitations are both closed.** The user's correction was structural, not cosmetic: Claude Code
     has no hardcoded "tools then one final answer" shape; the model streams as it generates,
     speaks to the user as many times as it decides to, and stops when it judges the job done. Two
     of those three were genuinely missing here.
     - **The reasoning call is now streamed** (`stream: true` + `stream_options.include_usage`,
       new `parseUniversalStream` in `shared/ai-client.ts`). The hard part is that a tool call
       arrives as JSON *fragments* — `{"say":"Let me ch` — so `JSON.parse` is unusable until the
       final chunk, which would defeat the point. New `partialJsonString(buffer, key)` walks the
       buffer by hand and returns whatever of a value has arrived, unescaped, whether or not the
       closing quote has been seen (stopping at a half-arrived `\` or `\uXXXX` rather than emitting
       a character the next chunk replaces). Streaming is **opt-in per call** via a new
       `Reasoner.decide({onDelta})`: an interactive chat passes it, a cron wake / channel drain /
       sub-agent does not, so those keep the cheaper non-streamed path and cannot regress.
     - **Mid-run replies are a first-class tool parameter, not incidental prose.** Item 117
       captured text a model *happened* to attach beside its tool call — but under
       `tool_choice:"required"` many providers suppress free text entirely, so that source is
       unreliable exactly where reliability matters most (the small open-weight models a free-tier
       business runs on). `run`/`distill`/`patch` now each declare a **required `say`**, so it
       comes back through the provider's own constrained decoding every time, and it streams — the
       user reads the sentence before the tool it describes has started. `DECISION_INSTRUCTIONS`
       gained a paragraph telling the model to write it as speech reflecting what it just learned,
       never a stock phrase; the existing "not on a short leash" paragraph absorbed the
       conversation framing (keep going as long as the goal needs, `answer` when YOU judge it met).
     - **Growing text needed a new checkpoint kind.** New `LiveCheckpoint = TraceStep + {partial,
       answer_preview}` (`script-engine/types.ts`) — deliberately NOT on `TraceStep` itself, which
       is the durable record. `NaelaoAgentDO.recordLiveProgress` u
- On D1 or SpaceDO SQLite, multi-statement manual transactions via separate .query() calls are not supported — D1 requires db.batch([...stmts]) for atomicity, and SpaceDO SQLite uses this.ctx.storage.sql.exec() which auto-commits each statement. The BEGIN/COMMIT/ROLLBACK calls will either throw or execute as no-ops. The three statements (writing token_usage, space_usage_monthly, space_credits) run non-atomically. A crash between steps 2 and 3 deducts from the monthly total without deducting from the balance, causing silent billing inconsistency with no recovery path.
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the assistant's own base grant, exactly as the clamp's SpaceDO doc always
  specified.
- **Read-only enforcement** (`ScriptEngineEnv.effectiveRole` + `ScriptToolSurface`, the `maxTier`
  structural precedent): `"viewer"` (which is also what `read_only` maps to server-side, even for
  a project owner) refuses `script.create/update/delete`, every STORED script (arbitrary
  agent-authored code is assumed mutating — fail closed), and any prebuilt op not on the explicit
  read-safe allowlist in the new `script-engine/assistant-access.ts` (`READ_SAFE_PREBUILT_OPS` —
  small and explicit like wallet.ts's credential-name list; a new prebuilt op is write-gated until
  consciously classified). `script.read`/`script.find` and read ops (read_file, knowledge.search,
  wallet.balance, project.list, ...) still work.
- **Approval-policy intersection** (`resolveAssistantApprovalPlan`, pure + unit-tested): `yolo`
  now fully applies only for system wakes (no `x-naelao-role` — the autonomous operation the owner
  configured it for) and owner/admin callers (who could self-authorize any gated action anyway);
  every other verified caller role — editor/viewer builders, `product_end_user`, `agent` API keys,
  and unrecognized roles (fail closed) — downgrades to the always_ask posture
  (`gate_unless_listed` + the policy's own `auto_approved_actions`).
- **Two escape hatches closed while wiring:** (1) `POST /agents/:agentId/script/run` (the worker's
  script-first entrypoint, whose own doc says "owner-initiated calls arrive with the usual
  JWT-derived headers") silently DROPPED `x-naelao-user-id`/`x-naelao-role` when forwarding to the
  DO — so not just the clamp but also handleScriptRun's per-caller billing branches could never
  apply to runs entering there; both headers are now forwarded (the ro
- ### The `kind: "voice_agent"` Definition in `business-feature-kinds.ts`:
```typescript
export const VOICE_AGENT_KIND: BusinessFeatureKind = {
  kind: "voice_agent",
  label: "Voice Telephony & Call Desk",
  description: "24/7 AI voice phone receptionist powered by Cloudflare Calls and WebRTC.",
  singleton: false,
  minCreationRole: "admin",
  autoProvisionable: true,
  viewportComponent: "VoiceAgentCanvas", // Call dashboard + real-time waveform
  allowedLadderTiers: [1, 2],           // Safe RAG + Calendar tools only
  domainSystemPrompt: `You are a professional Voice Receptionist speaking over a live phone call.
Rules:
1. Speak in short, conversational sentences (1-2 sentences max per turn).
2. Do not use markdown, emojis, or bullet points in your speech output.
3. Check calendar availability and confirm bookings immediately.`
};
```
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
   > *"Draft John Doe's clinical pre-assessment chart for his 3:00 PM appointment."*
   Workers AI Whisper transcribes it in 300ms, and the AI medical agent begins co-drafting the file immediately.
- ### Summary of What This Adds:
1. **Space-Wide Shared Calendar & State:** Hosted in `SpaceDO` SQLite; ensures that appointments, leads, and customer states are shared seamlessly across all project workstations without data silos.
2. **`kind: "voice_agent"`:** Deploys 24/7 AI phone receptionists using Cloudflare Calls (WebRTC) and Workers AI with zero external server infrastructure.
3. **Built-in Voice Dictation:** Adds native WhisperFlow-style voice-to-text directly inside the chat composer dock powered by Cloudflare's free edge Whisper model.
B7t since we have space wide mcp connector there is no need that means every project has access to the same mcp calendar. But we have to let agents know difference between space shared connector vs space wide user connect vs project specific
Establishing a clear **3-Tier Connector Scope Model** prevents cross-user account bleed and ensures the agent never books a public customer onto a founder’s personal calendar by accident.
By annotating tool definitions with explicit **Scope Provenance**, the agent immediately understands whether a tool acts on behalf of the **Whole Company**, a **Specific Human Member**, or a **Single Project Container**.
- #### Module 4: Outbound Campaigns & Scheduled Crons
The project allows scheduling automated outbound phone calls using **Tier 3 Dynamic Workflows & Crons**:
* **24-Hour Appointment Confirmation:** At 10:00 AM daily, a Cloudflare Workflow queries `SpaceDO.space_calendar` for tomorrow's appointments and calls each patient:
  > *"Hi John! This is Miami Dental calling to confirm your 3:00 PM appointment with Dr. Smith tomorrow. Can you make it?"*
* **Lead Follow-Up Calls:** Automatically triggers an outbound call 5 minutes after a lead submits a web form.
- #### Way 2: Chatting with the Agent in a Management Thread
Because our agent uses the **Claude Code REPL engine**, a user can open the project management thread and type [1.1.2]:
```
User:
"Set our greeting to 'Hello, thanks for calling Apex Law. How can we direct your call?'.
Add a rule that if someone mentions 'personal injury', transfer them immediately to
Sarah at +1-555-0144. Also schedule a cron every Monday at 9 AM to call our active case leads."
```
The agent executes `voice_desk.configure` and updates the project's **`voice_agent_config.json`** in the SQLite virtual filesystem in **1 turn**:
```typescript
// workers/agents/src/script-engine/prebuilt/voice-desk.ts
export interface VoiceAgentProjectConfig {
  telephony: {
    phoneNumber: string;
    carrier: "twilio" | "plivo" | "cloudflare_calls";
    transferFallbackNumber?: string;
  };
  voice: {
    provider: "cartesia" | "deepgram" | "elevenlabs";
    voiceId: string;
    speed: number;
    bargeInSensitivity: "low" | "medium" | "high";
    greeting: string;
  };
  prompt: {
    systemPrompt: string;
    businessHours: string;
    emergencyRules: string;
  };
  tools: {
    enableCalendarBooking: boolean;
    enableKbFaqSearch: boolean;
    enableCallTransfer: boolean;
  };
  scheduledOutboundCampaigns?: Array<{
    name: string;
    cron: string; // e.g. "0 10 * * *"
    leadSource: "space_calendar" | "leads_csv";
    scriptName: string;
  }>;
}
```
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
      done") was homeless, so two threads would each redo the other's work. Read ON DEMAND via
      `project_journal.read` — never injected per call, which is what lets it hold real detail.
      Bounded by entry count AND rendered bytes; overflow folds into a dense archive
      (Mastra Observational Memory's shape) rather than truncating. Summarisation is optional:
      LLM when wired, deterministic rollup when not — losing a completed action to a summariser
      outage would defeat the point. Scoping is structural (project comes from the run, never an
      argument). Both assistant profiles instruct: read before working, log after acting.
    - **The agent had no conversation memory.** Confirmed by reading `GatewayReasoner.decide()`:
      the payload carried goal + snapshot + candidates + this run's own steps, and NOTHING else.
      No history at all — so it could not resolve "do that again", could not answer "what did we
      decide", and re-asked what the user had just said. The context-usage meter (§A1.27) was
      measuring a transcript the model never received. New
      `script-engine/conversation-context.ts` carries recent history bounded by tokens and message
      count, walking backwards so the newest message can never be the one evicted; a single huge
      message is truncated (and says so) rather than evicting everything else.
    - **Compaction is explicit, never silent.** Claude Code's own has the documented failure mode
      the user described: after a compact the assistant treats anything absent from the summary as
      never having happened. So the payload itself carries a `notice` (not just the system prompt)
      saying the history is compacted, how many messages are missing, and to run
      `conversation.search` rather than guess. `DECISION_INSTRUCTIONS` says the same.

- Required Fix: Integrate Twilio Voice (or PagerDuty phone call) for CRITICAL-severity alerts: builder configures on-call phone number in notification preferences. On CRITICAL alert trigger: PagerDutyDO initiates Twilio voice call, reads alert summary via TTS ("Critical: Space customer-support is down. Error rate: 48%. Please acknowledge."). Call recipient presses 1 to acknowledge (silences further calls), 2 to escalate (calls backup number), 3 for runbook. Track voice_call_sent, voice_call_acknowledged, mean_time_to_acknowledge in on-call metrics. Builder can configure business hours → email only, after-hours → voice call. Enterprise: integrate with existing PagerDuty/OpsGenie instead of Twilio.
- **Fix — a wallet-specific role resolver, not a change to the generic one:** the generic
`resolveEndUserBusinessRole`'s root-is-`"member"` shortcut stays untouched (sessions, projects,
threads all still need it). New `resolveWalletAccessRole` (`business-auth.ts`) instead: for a
space with no `parent_space_id` (the product root), returns `null` — no product_end_user has any
legitimate wallet access there, full stop; for a business (child) space, delegates to the same
real `business_memberships` lookup as everything else, so a business owner/admin still reads
their OWN business's wallet exactly as before. Wrapped in a new
`requireBusinessMembershipForWallet` middleware (its own 5s-TTL cache, kept separate from the
generic role cache so the two resolvers' answers for the same `(spaceId, endUserId)` key can never
cross-contaminate) — applied in place of `requireBusinessMembership` on all three end-user-reachable
wallet read routes: `GET .../projects/:projectId/wallet/{balance,history}` and the consolidated
`GET /spaces/:spaceId/wallet`. Every non-`product_end_user` caller (builder JWT roles) is
unaffected, per the file's existing additive-only convention.

### 107. Automated Outbound Telephony Reminder Workflows

**Final behavior:** Scheduled crons query tomorrow's bookings and dispatch automated confirmation calls, updating calendar state automatically.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 138. **Answering the stop hook's exact challenge — a genuine, comprehensive end-to-end proactive-
     autonomy test, not just quota-chasing — proved three previously-unverified capabilities live
     and found one more real, currently-unfixed defect worth stating precisely rather than papering
     over.**
     - **Multiple autonomous heartbeat wake-ups, spaced ~100s apart, unattended, exactly as asked
       ("secs or few mins apart").** Fired the on-demand tick sweep three times with a real ~100s
       gap between each, doing nothing in between — the loop woke on its own schedule each time
       (`enqueueAgentTicks`, the same function the hourly production cron calls) with no manual
       intervention beyond the sweep trigger itself. All three landed real `run_failed` activity
       rows at the right cadence, proving the WAKE mechanism is genuinely periodic and unattended,
       independent of what the reasoning call inside each wake then did.
     - **`llama-3.1-8b-instant` has a SMALLER Groq TPM ceiling (6000) than the 70B model (12000)**
       — the opposite of the reasonable assumption that a cheaper model gets more headroom. Its
       413 ("Request too large... Limit 6000, Requested 8749") is correctly classified
       `rate_limited` by `classifyFailure`'s existing body-pattern match, and correctly NOT
       retried (`retryDelayMs` only fires on 429/503 — a payload permanently over a fixed ceiling
       cannot be fixed by waiting, so declining to retry is right, not a gap).
     - **Confirmed `onProgress` — and therefore streaming — is now wired into EVERY dispatch, not
       just interactive ones**, traced by reading `handleScriptRun`: `buildLiveProgressReporter`
       (item 133's durable live-trace persistence) is unconditional, so `deltaReporter` always
       returns a function and `streaming = typeof input.onDelta === "function"` is true for a
       heartbeat wake exactly as much as a chat message. This matters because it's what put a
       Groq-specific defect on the SAME code path a heartbeat run reaches.
     - **A real, currently open finding, left unfixed on purpose: Groq's own server-side schema
       validator rejects the model's object-shaped `params` against the `type:"string"` schema
       item 135 introduced to fix Gemini** (`tool call validation failed: parameters for tool run
       did not match schema: errors: [\`/params\`: expected string, but got object]`), on BOTH
       the streamed attempt and its non-stream
- The Gap The billing handler calls await db.query('BEGIN'), await db.query('COMMIT'), and in the catch block await db.query('ROLLBACK'). DO SQLite (this.ctx.storage.sql.exec()) does not support explicit transaction control statements — each exec() call is automatically atomic and single-threaded within the DO. Sending 'BEGIN' as a standalone SQL statement is either a no-op or causes a parse error; the catch block's ROLLBACK then triggers a second error, leaving the handler in an unrecoverable state with partial billing data written.
- - `NaelaoAgentDO.settleRunBilling`: a new `NaelaoAgentDO.infraResourceTypeForTier(tier)` maps
  `ExecutionTier` 2-4 → `"isolate"`, 5 → `"container"` (Tier 1, in-process R2, is excluded — not a
  distinct CF resource, and `duration_ms` is always 0 there anyway). The infra-credit computation
  and recording now happens **before** the function's pre-existing `if (!tokensUsed) return;`
  early-out, not after — a pure script execution with zero LLM tokens (e.g. a scheduled
  `workflow.run` with no reasoning step) still consumes real isolate/container time and must not
  silently go unmetered just because it made no LLM call. Recorded via the same `/billing/usage`
  POST mechanism (`event_type: "infra_credits"`) the existing `llm_tokens` recording already uses,
  for **every** run with a measurable tier+duration regardless of caller role (pure observability
  — this is deliberately broader than the enforcement gate below). Also emits a new Analytics
  Engine data point (`infra.execution.completed`, `packages/analytics-schema`'s versioned slot
  layout, `tenant_id` in `indexes[0]`, best-effort try/catch matching every existing call site).
- `ScriptRunWorkflow`'s `execute-script` step and `AgentTaskWorkflow`'s `run-agent` step (the two
  steps that dispatch real work — not the trivial DO status-update steps in either workflow,
  which aren't metered) gained real `Date.now()` wall-clock bracketing where **none existed
  before** (confirmed during the earlier exploration pass: zero `Date.now()` calls in either
  file). A new shared `reportWorkflowStepInfraUsage()` (`workers/agents/src/workflows/
  report-infra-usage.ts`) posts `resourceType: "workflow_step"` usage — Workflow classes share the
  agents worker's plain `Env` (`workers/agents/src/env.ts`), not `NaelaoAgentDO`'s own
  `internalHeaders()`/`BILLING_WORKER` wiring, so this needed a small standalone equivalent rather
  than a DO method; `Env` gained `BILLING_WORKER?: Fetcher` (the binding already exists in
  `wrangler.toml` under the `naelao-billing` service — it was just missing from this particular
  shared TypeScript interface, a real but narrow gap).
- ### 1. The Vapi-Style Voice Studio Architecture
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   VOICE AGENT PROJECT CANVAS (`apps/shell`)                           │
├───────────────────┬────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Telephony Line │ 🟢 **Live Number: +1 (305) 555-0199** [Verified & Active]                          │
│    (Required)     │ • Inbound: Enabled  │  Outbound: Enabled  │  Fallback: +1 (305) 999-1234 (Dr. Smith)   │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 2. Voice & Tone   │ • Voice Model: **Cartesia Sonic (Warm Female)**  │  Speed: **1.05x**               │
│                   │ • Greeting: *"Thank you for calling Miami Dental. How can I help you today?"*      │
│                   │ • Interruption Sensitivity: **High (Instant Barge-in on speech)**                  │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 3. Shared State   │ • Connected Calendar: **[ Space-Shared Clinic Calendar (SpaceDO) ]**              │
│    & Knowledge    │ • Booking Rules: 30-min slots, 15-min buffer, Business Hours: 9 AM - 6 PM          │
│                   │ • Knowledge Grounding: Auto-indexes FAQs, Accepted Insurances & Fee Schedule Docs │
├───────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ 4. Outbound Crons │ • ⏰ **Scheduled Reminder Calls:** `cron: "0 10 * * *"` (Daily at 10 AM)          │
│    & Campaigns    │ • Trigger: Auto-calls tomorrow's booked clients for 1-minute confirmation voice call│
└───────────────────┴────────────────────────────────────────────────────────────────────────────────────┘
```
- #### Module 4: Outbound Campaigns & Scheduled Crons
The project allows scheduling automated outbound phone calls using **Tier 3 Dynamic Workflows & Crons**:
* **24-Hour Appointment Confirmation:** At 10:00 AM daily, a Cloudflare Workflow queries `SpaceDO.space_calendar` for tomorrow's appointments and calls each patient:
  > *"Hi John! This is Miami Dental calling to confirm your 3:00 PM appointment with Dr. Smith tomorrow. Can you make it?"*
* **Lead Follow-Up Calls:** Automatically triggers an outbound call 5 minutes after a lead submits a web form.
- ### Summary of What This Establishes:
1. **Vapi/Grok-Style Simplicity:** Complete visual and natural language control over greetings, system prompts, voices, interruption sensitivity, and business hours.
2. **Strict Telephony Guard:** The project explicitly requires an active phone line (1-click platform number or BYO Twilio) to receive/make calls.
3. **Automated Outbound Crons:** Workflows handle appointment reminder campaigns and lead follow-up calls automatically.
4. **Cross-Project Shared Calendar Integration:** Appointments booked over the phone commit atomically into **`SpaceDO` SQLite**, instantly visible to the doctor's document workstation and the founder's WhatsApp morning briefing.

### 108. Native In-Composer Voice Dictation

**Final behavior:** WhisperFlow-style dictation in chat bar, capturing audio from browser microphone and transcribing via Workers AI Whisper for $0 compute.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 129. **Investigated the reported "no credits dialog with 5000 credits" bug thoroughly — all four
     distinct billing gates were confirmed HEALTHY for the account at investigation time; most
     likely a timing issue, not a live code bug. Plus three real, independently-reported UI/UX
     gaps, all fixed: mobile sidebars unreachable, the Message/text-tab button missing from the
     composer dock, and the verification email carrying no usable link.**
     - **Credits-dialog investigation.** Read-only (zero LLM cost, via a temporary service-bound
       worker mirroring items 128/62's own established technique) checks against all FOUR
       distinct `insufficient_credits`/`quota_exceeded` sources in `NaelaoAgentDO.enforceRunGates`
       + the org-level pre-dispatch quota check in `index.ts`: the granted personal balance
       (`5000` credits, intact), Test 1's project wallet (`balance_cents: 996`, `credited_cents:
       1000` — funded, not empty), and the org's monthly `llm_tokens` quota (`enterprise` tier,
       200,000,000 limit, `166,745` used this month) — all healthy, none would trigger the
       dialog. Also audited every code path for a Gemini/Groq/CF PROVIDER-level failure (a 429/
       rate-limit/quota-exhaustion from the LLM itself, mid-run) ever being mislabeled with one
       of the four billing `error_code`s — found none: those already route through the SEPARATE
       `classifyFailure`/`FailureKind` system (`quota_exhausted`/`rate_limited`/
       `model_unavailable`) into `InterruptedRunCard`'s self-heal flow, never `UpgradeDialog`.
       Confirmed the live shell IS running the exact deploy carrying the error_code fix
       (`e089dbaf`, `environment:"production"`). Conclusion: if the dialog is seen again, it is
       very likely a real gate genuinely firing at that moment (the account has real, separate
       state per gate) rather than a mislabeling bug — capturing the EXACT message text next time
       narrows it immediately, since each of the four has distinct wording. Temporary read-only
       worker deleted immediately after use, same discipline as item 128.
     - **Mobile sidebars were completely unreachable — root cause: the CSS was already ported
       from the mockup but nothing in React ever wired it up.** `packages/ui/src/styles.css`
       already carried `#sidebar.mobile-open`/`.mobile-topbar`/`.mobile-backdrop` (ported earlier
       from `apps/launchpad/src/index.html`'s own off-canvas-drawer pattern) — but no
- Required Fix Build a <VoiceInput> component: (1) Push-to-talk button: hold to record (releases to submit), or toggle mode (click to start, click to stop). Visual state: idle (microphone icon), recording (pulsing red circle + timer). (2) Waveform visualization: real-time audio level bar chart rendered on canvas (AudioContext analyser node). Shows user if microphone is picking up audio. (3) Real-time transcription preview: as the user speaks, partial STT results appear in a preview box above the button. (4) Transcription correction: after recording, the user can edit the transcription before submitting. (5) Error states: microphone permission denied (clear error with link to browser permission settings), no audio detected (prompt to check microphone).
- - **T2's real architectural prerequisite, resolved:** the shell's chat call path
  (`/spaces/:spaceId/sessions/:sessionId/agent/run`) had no concept of "which named agent" — it
  always addressed ONE DO instance per bare `sessionId`. Fixed at the source rather than adding a
  parallel endpoint: `/agent/run` now addresses `{sessionId}:{agentDefinitionId}` whenever an
  explicit `agent_definition_id` is given (unchanged, bare-`sessionId` addressing when it's
  absent — every existing single-agent session is unaffected). The new `/agent/mention-run`
  endpoint is a thin dispatcher on top of this, not a second reasoning path.
- **T3 scope note:** the soft/implicit lock-wrapping-every-R2-write idea from the original sketch
  (`project:{id}:file:{path}` around every Tier-1 `r2-workspace` write) was NOT built — soft
  locking stays exactly what the existing `lock` prebuilt already offers, opt-in per script.
  Wrapping ALL R2 writes automatically would be a real behavior change to a heavily-used prebuilt
  outside this pass's scope; flagged as a possible follow-up, not silently added.
- **V scope note:** agent-run-lifecycle and `approval.resolved` broadcasts were NOT wired — the
  former needs a broader pass through `NaelaoAgentDO`'s run lifecycle hooks, the latter needs
  `HITLApprovalDO` to carry `space_id` in its own rows (today it's only addressed by `spaceId`,
  never stores it). A frontend WS client (`apps/shell`/`apps/dashboard` subscribing per-space via
  a short-lived signed WS-URL param, the same browser constraint Phase 6's SSE stream already
  solved) was also not built — the backend fan-out (`broadcastSpaceEvent`, wired into project
  create/update, the exclusive-mode lock transition, presence heartbeats, and
  `approval.requested`) is real and tested; a live UI consumer is the next increment.
- **P — Composio + Pipedream connector providers — the one remaining phase.** Extend whatever
  table backs registered MCP servers in `workers/mcp-hub` with
  `connector_provider: 'direct'|'composio'|'pipedream'`; a Composio/Pipedream-backed connector
  stores only that provider's own opaque connection reference (never the underlying OAuth token)
  and routes `ctx.mcp.call`/`mcp-connector` calls through the provider's execute-action API
  server-side — the script-native "6 ops only" contract (the established architecture ground rule #8) is unchanged;
  this is more connector inventory behind the same surface, never a new agent capability class.
  Needs real `COMPOSIO_API_KEY`/`PIP
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
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. INSTANT TRANSCRIPTION INSERTION                                          │
│    The transcribed text automatically types into the chat message box!      │
└─────────────────────────────────────────────────────────────────────────────┘
```
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
   > *"Draft John Doe's clinical pre-assessment chart for his 3:00 PM appointment."*
   Workers AI Whisper transcribes it in 300ms, and the AI medical agent begins co-drafting the file immediately.
- ### Summary of What This Adds:
1. **Space-Wide Shared Calendar & State:** Hosted in `SpaceDO` SQLite; ensures that appointments, leads, and customer states are shared seamlessly across all project workstations without data silos.
2. **`kind: "voice_agent"`:** Deploys 24/7 AI phone receptionists using Cloudflare Calls (WebRTC) and Workers AI with zero external server infrastructure.
3. **Built-in Voice Dictation:** Adds native WhisperFlow-style voice-to-text directly inside the chat composer dock powered by Cloudflare's free edge Whisper model.
B7t since we have space wide mcp connector there is no need that means every project has access to the same mcp calendar. But we have to let agents know difference between space shared connector vs space wide user connect vs project specific
Establishing a clear **3-Tier Connector Scope Model** prevents cross-user account bleed and ensures the agent never books a public customer onto a founder’s personal calendar by accident.
By annotating tool definitions with explicit **Scope Provenance**, the agent immediately understands whether a tool acts on behalf of the **Whole Company**, a **Specific Human Member**, or a **Single Project Container**.

### 109. Private Executive Copilot Channel

**Final behavior:** An on-the-go Chief of Staff connecting the owner's personal WhatsApp/Telegram to the Space Assistant. Outside customers cannot reach this channel.

**Production acceptance contract:**
Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests.

**Retained implementation constraints:**
- 93. **Channels made real (they could not reply at all), Telegram added, the webdev store made
    deterministic, and a live end-to-end run that found two more bugs — plus an OpenClaw/Hermes
    gap analysis in `docs/COMPETITIVE_2026-08-05_openclaw_hermes.md`.**
    - **Reported bug: the Channels panel could not connect anything.** It listed connected channels
      and offered no way to add one — the only connect route was `POST /channels/:channel/connect`,
      builder-only and left out of the router's end-user allowlist. New `POST /spaces/:spaceId/
      assistant/channels` (same path as the existing GET, `action` in the body — a dynamic segment
      followed by a static suffix is the shape that has repeatedly corrupted this codebase's Hono
      route tables), gated by `requireEndUserBusinessMembership` at a NEW admin floor: changing how
      a business is reached from outside is not a plain member action. Owner outranks admin (the
      item 90 bug, avoided here rather than repeated). Returns the webhook URL, since connecting on
      our side is only half of it. New `ChannelConnect` component in the shell.
    - **Unreported and worse: NO channel could reply.** `/internal/notify` handled email and
      returned `delivered:false` for everything else, so a customer could message a business on
      Slack/Discord/WhatsApp, the agent would run and produce a real answer, and the reply never
      left the building. Slack, Discord, WhatsApp and Telegram now send for real, resolving the
      space's own bot token from the vault at send time (`CHANNEL_SEND_CREDENTIAL` — a DIFFERENT
      secret from the inbound-verification one). Slack's 200-with-`ok:false` is treated as the
      failure it is. New `CREDENTIALS_WORKER` binding on the notifications worker.
    - **Telegram** (`ChannelType` gained a 5th member): free, no business verification, no
      per-message billing, no 24-hour reply window — the opposite of WhatsApp on every axis that
      matters to a $0-budget business, and the top gap the OpenClaw/Hermes analysis identified.
      Auth is unlike every other adapter: Telegram does not sign payloads, it echoes back a secret
      token the owner chose at `setWebhook` time, so this is a shared bearer secret compared in
      constant time, not a signature. Keys on the CHAT id (a group reply must go to the
      conversation, not the sender) and dedupes on `chat:message_id` since message_id is only
      unique per chat. Signal/iMessage deliberatel
- Required Fix (DEFERRED — a scoping statement for a future phase): When this is eventually built, it is its OWN SpaceType ( personal-assistant , membership_model: "team" -shaped since there is exactly one real owner per instance, no business-switcher concept) with its own Product Shell skin — not a mode of Launchpad, and not a rename of the existing generic Space Assistant (item 20's SPACE_ASSISTANT_PROFILE ), which is scoped to operate WITHIN one space, not across a person's whole life and portfolio. The reason to sequence it last is architectural honesty, not lack of ambition: it needs the established specification's portfolio/delegation primitives to already exist and be trustworthy before a personal assistant can responsibly spin one up on a user's behalf, and it needs the established specification's autonomous-build loop proven before "the assistant can build you a mini-app on request" (BI.3) is anything but a toy demo.
- Spec §05 (byte ~116k): *"One assistant per user per Space by default. Admin can raise
this limit."* The **company state is shared** and space-level — `SpaceDO` (members,
structure, billing) + `ProjectDO` workspaces (file **locks**, **version history**,
**real-time presence**, byte ~399k/§12) + threads + KB. Each user's assistant
(`assistants/{userId}/`, byte ~411k) is a personal chief-of-staff acting **on** that
shared company — it is **not** a private fork of the company. Two members' assistants do
not build two companies because they read/write the *same* `ProjectDO`. Coordination =
file locks + presence + **project deduplication** (admin's assistant broadcasts "this
already exists"). This resolves the "two assistants = two companies" concern.
- 190 - 192
We said user gets their own space/business assistant that they connect their own channels like WhatsApp or telegram etc should this also be there in non autonomous business templates the cowork templates
**YES, absolutely.** In fact, having WhatsApp and Telegram connected to non-autonomous / vertical cowork spaces is **one of your biggest competitive advantages over Harvey AI, Legora, and Claude Cowork.**
Products like Harvey AI or desktop Claude are **trapped on a desktop browser**. A lawyer walking into a courtroom, a doctor doing hospital rounds, an architect on a construction site, or an investment banker in a taxi cannot easily open a 15-inch laptop to check a document.
Giving every professional a **personal WhatsApp / Telegram channel to their firm's Cowork Space** turns the system into an on-the-go **Executive Chief of Staff**.
- ### 2. How Channels Operate: Autonomous Mode vs. Cowork Mode
The same scan-to-connect QR code and channel pairing infrastructure (`workers/agents/src/launchpad/channel-pairing.ts`) works in both modes, but with different audiences:
```
┌─────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ 🚀 AUTONOMOUS VENTURE MODE                                   │ 💼 VERTICAL COWORK / COPILOT MODE                           │
├─────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ • **Audience:** Outside Public Customers.                   │ • **Audience:** Internal Firm Professionals & Partners.     │
│ • **Role:** 24/7 AI Sales Receptionist & Support Desk.      │ • **Role:** Private Mobile Executive Copilot.               │
│ • **Example:** Customers text WhatsApp to book a haircut    │ • **Example:** Lawyer texts Telegram to query case law      │
│   or ask for pricing.                                       │   and review contract clauses.                              │
│ • **Access Control:** Restricted via `AgentFirewall` to     │ • **Access Control:** Authenticated to the verified         │
│   Tier 1 / RAG tools (cannot access code or files).         │   professional's project permissions.                       │
│ • **Proactive Triggers:** Nightly revenue recaps & alerts.  │ • **Proactive Triggers:** Filing deadlines & urgent alerts. │
└─────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```
- ### Summary
**Keep channel connectivity for ALL templates.**
* In **Autonomous Venture templates**, WhatsApp/Telegram is how **outside customers** talk to the business.
* In **Vertical Cowork templates**, WhatsApp/Telegram is how **busy professionals** direct their AI firm and access their files from anywhere in the world.
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
     `scheduled_jobs`/`event_triggers`, don't fork a second engine).
     - **Markdown never existed anywhere in chat.** Every bubble rendered its content as a raw
       React text child, so an assistant reply arrived with its `**bold**`, `- bullets` and ```
       fences intact as literal characters — while `packages/ui/src/styles.css` had been carrying
       finished styles for `.bubble p/ul/strong/em/pre/code` the whole time with nothing ever
       emitting those elements. New `apps/shell/src/components/Markdown.tsx` uses `react-markdown`
       + `remark-gfm`, chosen over `marked`/`showdown` for one reason that matters here: it builds
       React elements and never touches `dangerouslySetInnerHTML`, and an agent in this product
       renders web-fetched pages, customer email and connector output into these bubbles.
       `rehype-raw` is deliberately NOT installed, so inline HTML in markdown stays inert text.
       Wired through `RevealText`'s revealed substring (new opt-in `markdown` prop) so the reveal
       animation is untouched; an unclosed construct mid-reveal reads as literal text for a frame.
       The USER's own message stays literal — they typed it — and `.bubble.user` gained
       `white-space:pre-wrap`, which it never had, so their line breaks survive at all.
     - **`.msg-actions`/`.msg-action`/`.msg-action .tooltip` + `.msg-row:hover` were ALSO already
       styled and used by no component.** The only affordance was a permanently-visible text
       "Edit" button on one message. New `MessageActions.tsx` wires the existing styles: copy on
       every bubble, edit only on the last user message, both icons. `:hover` never fires on a
       tap, so a `.revealed` class set on tap reveals the row on touch rather than making it
       always-visible there (which would put two buttons under every message in a
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
 skills/ # Agent-specific skills (Tier 3)
 mini-agi/
 {miniAgiId}/
 data/ # Company data domains (sub-folders per domain)
 hr-data/
 sales-data/
 public-docs/
 bootstrap/
 {vertical}/ # Bootstrap Mode data
 annotation-queue/ # Tasks awaiting annotation
 in-progress/ # Locked tasks
 labeled-dataset/ # Completed annotations
 training-runs/ # Fine-tuning training files
 workflows/
 {name}.ts # Agent-authored Dynamic Workflow TypeScript
- - **Entry gate** (`NaelaoAgentDO.handleScriptRun`): a project-scoped run that acts on behalf of a
  user (non-empty `userId`, excluding the channel drain's synthetic `channel:...` ids, which never
  route through here anyway) resolves the clamp via a new `fetchAssistantAccess` (internal HMAC
  call to the existing spaces-worker endpoint) BEFORE any billing gate. `null` effective role
  (`assistant_mode='none'`, or a plain non-member) → 403 `assistant_access_denied`; lookup error →
  403 `assistant_access_unverified` (fail CLOSED — the fetchProjectConfig/F17 posture: an
  authorization check that fails open isn't one). No acting user (cron/trigger/webhook/bootstrap
  wakes) → no clamp, the assistant's own base grant, exactly as the clamp's SpaceDO doc always
  specified.
- **Read-only enforcement** (`ScriptEngineEnv.effectiveRole` + `ScriptToolSurface`, the `maxTier`
  structural precedent): `"viewer"` (which is also what `read_only` maps to server-side, even for
  a project owner) refuses `script.create/update/delete`, every STORED script (arbitrary
  agent-authored code is assumed mutating — fail closed), and any prebuilt op not on the explicit
  read-safe allowlist in the new `script-engine/assistant-access.ts` (`READ_SAFE_PREBUILT_OPS` —
  small and explicit like wallet.ts's credential-name list; a new prebuilt op is write-gated until
  consciously classified). `script.read`/`script.find` and read ops (read_file, knowledge.search,
  wallet.balance, project.list, ...) still work.
- **Approval-policy intersection** (`resolveAssistantApprovalPlan`, pure + unit-tested): `yolo`
  now fully applies only for system wakes (no `x-naelao-role` — the autonomous operation the owner
  configured it for) and owner/admin callers (who could self-authorize any gated action anyway);
  every other verified caller role — editor/viewer builders, `product_end_user`, `agent` API keys,
  and unrecognized roles (fail closed) — downgrades to the always_ask posture
  (`gate_unless_listed` + the policy's own `auto_approved_actions`).
- **Two escape hatches closed while wiring:** (1) `POST /agents/:agentId/script/run` (the worker's
  script-first entrypoint, whose own doc says "owner-initiated calls arrive with the usual
  JWT-derived headers") silently DROPPED `x-naelao-user-id`/`x-naelao-role` when forwarding to the
  DO — so not just the clamp but also handleScriptRun's per-caller billing branches could never
  apply to runs entering there; both headers are now forwarded (the ro

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
     `scheduled_jobs`/`event_triggers`, don't fork a second engine).
     - **Markdown never existed anywhere in chat.** Every bubble rendered its content as a raw
       React text child, so an assistant reply arrived with its `**bold**`, `- bullets` and ```
       fences intact as literal characters — while `packages/ui/src/styles.css` had been carrying
       finished styles for `.bubble p/ul/strong/em/pre/code` the whole time with nothing ever
       emitting those elements. New `apps/shell/src/components/Markdown.tsx` uses `react-markdown`
       + `remark-gfm`, chosen over `marked`/`showdown` for one reason that matters here: it builds
       React elements and never touches `dangerouslySetInnerHTML`, and an agent in this product
       renders web-fetched pages, customer email and connector output into these bubbles.
       `rehype-raw` is deliberately NOT installed, so inline HTML in markdown stays inert text.
       Wired through `RevealText`'s revealed substring (new opt-in `markdown` prop) so the reveal
       animation is untouched; an unclosed construct mid-reveal reads as literal text for a frame.
       The USER's own message stays literal — they typed it — and `.bubble.user` gained
       `white-space:pre-wrap`, which it never had, so their line breaks survive at all.
     - **`.msg-actions`/`.msg-action`/`.msg-action .tooltip` + `.msg-row:hover` were ALSO already
       styled and used by no component.** The only affordance was a permanently-visible text
       "Edit" button on one message. New `MessageActions.tsx` wires the existing styles: copy on
       every bubble, edit only on the last user message, both icons. `:hover` never fires on a
       tap, so a `.revealed` class set on tap reveals the row on touch rather than making it
       always-visible there (which would put two buttons under every message in a
- The Gap: Regulators and courts can issue data preservation orders requiring Naelao to produce specific builder or end-user data. No eDiscovery export capability exists. Manually extracting data from DO SQLite, R2, and Analytics Engine for a legal request would take days and be error-prone.
 Required Fix: Build eDiscovery export tool (admin-only): specify scope (builder_id, space_id, date_range, data_types). Workflow gathers: conversation history from ConversationDO, config history from SpaceDO, billing records from BillingDO, audit logs from AuditLogDO, Analytics Engine data. Packages into EDRM XML format (industry-standard eDiscovery format) or JSON. Signs package with platform private key for authenticity. Stores in encrypted R2 with access log. Delivery via secure download link to legal team. Typical completion time:
- **`workers/agents/src/do/NaelaoAgentDO.ts`**: new `run_traces` SQLite table (`ensureInit()`,
`PRIMARY KEY (run_id, seq)` — script-native runs mint their own `runId` with no `agent_runs` row
backing them, per the pre-existing gap that table only serves the legacy ReAct path, so this is
the first persisted-by-id record of a script-native run's existence). `persistRunTrace(runId,
tenantId, trace)` — unconditional SQLite insert (best-effort, swallows its own errors, same
"observability must never fail the run" posture as `logAgentActivity`), plus a best-effort
Analytics Engine mirror via `@naelao/tracing`'s `createTracer` when `env.ANALYTICS` is bound: one
root span (`script_loop.run`, run_id/tenant_id/step-count attributes) and one child span per
step (`script_loop.<phase>`, `parent_span_id` = root), `setError` on any `ok:false` step — degrades
to SQLite-only, no AE calls at all, when `ANALYTICS` is unbound (the pre-existing optional-binding
convention this file already uses twice elsewhere). Called from `handleScriptRun` right after
`runScriptLoop` resolves, before billing settlement — runs even on a failed result, since a
failed run's trace is exactly what a builder (or the later skill-evolution job) needs to
diagnose it. New `readRunTrace(runId)` reads it back ordered by `seq`.

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
