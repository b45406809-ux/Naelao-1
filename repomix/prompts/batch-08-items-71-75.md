# AI Studio implementation prompt — batch 08, plan items 71–75

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Certified models, LoRA, air-gap enforcement, and terminal sleep**. This prompt is self-contained: the feature definitions and retained implementation
constraints have already been extracted and reconciled into the final specification below.
Do not seek or cite external design context. Repository code is evidence of current
state, not evidence that a requirement is complete.

When present, the **Final reconciled architectural changes** section is the newest authority in
this prompt. Where it updates or replaces a numbered plan requirement or retained constraint,
implement the new architecture and do not preserve the superseded behavior for compatibility.

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

### 71. Vertical-Scoped Certified Model Whitelist (`whitelist_only`)

**Final behavior:** Server-side validation rejecting any model not certified for that vertical template, guaranteeing compliance in medical and legal spaces.

**Production acceptance contract:**
Production entry: reasoner/model selector.
Persistence/deployment: agent/project policy config.
Required observable verification: model override tests do not prove vertical whitelist-only enforcement.

**Retained implementation constraints:**
- 151. **A new 28-step goal batch (Google Drive `new/goal 1.txt`) is IN PROGRESS — the first
     tranche (steps 2, 3, 8, 9, 10, 12, 13a, 14, 19, 24) is BUILT, tested, and deployed.** The
     authoritative list is the user's Drive file (28 steps, item 1 = a Claude-Code-style
     context-window breakdown UI for the Stats tab; the finale = 6 business templates + business-
     wide BYOK). Shipped so far:
     - **Step 10 (spawn/consult model+agent validation):** `agent.spawn` validates each task's
       model against `ALLOWED_MODELS` before delegating — a wrong id gets a real "did you mean"
       (new `billing-core` `suggestModels`) instead of a silent escalation-clamp (which read as a
       misleading "too expensive") or a bare provider 404. `thread.consult`/`thread.send_message`
       validate `agent_id` (and model) up front with did-you-mean over the project's agents.
     - **Step 8 (project model/agent listing):** new `thread.list_project_models` +
       `thread.list_project_agents` on the `project-coordination` prebuilt; the agent listing
       ALWAYS includes the general Space Assistant (`naelao-agent`) so a brand-new project still
       shows a real, addressable target. Both auto-approved reads.
     - **Step 9 (tool-result pagination):** generic size-guard in `ScriptToolSurface.run()` —
       `applyToolResultLimit` (exported, tested) pages the primary list of an oversized (or
       explicitly `limit`/`offset`-ed) result in place with a `_pagination` note carrying the true
       total + next-page instruction, or truncates a non-list blob with guidance. Small results
       stay byte-identical.
     - **Step 3 (chunked file read/search):** `read_file` gains `offset`/`length` ranged reads
       (`has_more`/`next_offset` paging) so a file over the single-read cap is read a slice at a
       time; new `search_file` returns matching lines with line numbers + optional context without
       pulling the whole file. paramHints added for every `r2-workspace` op.
     - **Step 12 (self-scheduling / background-task wake):** new `schedule` prebuilt
       (`schedule.wake_me`/`list`/`cancel`) lets an agent wake ITSELF later with a follow-up goal
       — the "set a cron trigger to check back on a background task" pattern. Built on the existing
       goal-based `scheduled_jobs` dispatcher; a delay-based wake is one-shot (`params._one_shot`,
       which the dispatcher now disables after firing), a `cron` wake recurs. Granularity is the
       hourly he
- // Temple: LexSpace — full configuration
const TEMPLE_LEXSPACE: Temple = {
 id: 'temple-lexspace-v1',
 name: 'LexSpace',
 tagline: 'AI legal research and drafting — compliance-first',
 category: 'vertical-legal',
 spaceType: 'verticals',
 suggestedPricing: { type: 'seats', pricePerSeat: 15000, trialDays: 0 }, // $150/seat/month
 defaultAuthProvider: 'saml-sso',
 productConfig: {
 allowPublicSignup: false,
 requireAdminApproval: true,
 featureFlags: {
 'matter-management': true,
 'immutable-audit-trail': true,
 'citation-verification': true,
 'document-compare': true,
 'privilege-log-generator': true,
 },
 userPermissions: {
 canCreateProjects: true, // Matters = projects
 canCreateSubSpaces: true, // Practice groups = sub-spaces
 canUploadKnowledge: true,
 maxThreadsPerUser: null,
 },
 adminFeatures: {
 conversationLogAccess: true, // Required for regulatory compliance — pre-flagged for Naelao approval
 auditLogAccess: true,
 knowledgeBaseManagement: true,
 },
 subSpaceTerminology: 'practice groups',
 },
 agentBundle: [
 {
 agentId: 'legal-researcher-v1',
 required: true,
 configOverrides: {
 systemPromptAddendum: 'Always cite primary sources. Never cite secondary summaries without the primary. Flag any jurisdiction ambiguity explicitly. All legal citations must follow Bluebook format.',
 },
 },
 {
 agentId: 'legal-drafter-v1',
 required: true,
 configOverrides: {
 requiresApprovalFor: ['document_finalise', 'client_send'],
 },
 },
 {
 agentId: 'privilege-checker-v1',
 required: false, // Optional — activated if firm handles litigation
 configOverrides: {},
 },
 ],
 knowledgeSchema: [
 { documentType: 'jurisdiction_guides', required: true, description: 'Upload court rules and jurisdiction-specific procedural guides', exampleUrl: 'https://docs.naelao.app/templates/lexspace-jurisdiction-guide' },
 { documentType: 'firm_precedents', required: false, description: 'Past briefs and contracts the agents can reference as style guides', exampleUrl: null },
 { documentType: 'client_intake_forms', required: false, description: 'Standard client intake templates auto-populated by the intake agent', exampleUrl: 'https://docs.naelao.app/templates/lexspace-intake' },
 ],
 estimatedSetupMinutes: 25,
 buildsCount: 0,
 featured: true,
};
- - **G-BF02 — platform Composio/Pipedream keys in mcp-hub.** `COMPOSIO_API_KEY`/`PIPEDREAM_API_KEY`
  optional Workers Secrets; new `resolveProviderApiKey` — a BYO vault credential (`auth_secret_name`)
  still WINS when present (a builder running their own provider project keeps control + their own
  billing); otherwise the platform key is injected server-side and never leaves the worker; neither
  → honest 503 `provider_not_configured`. A BYO declaration that resolves to no key errors clearly
  (400) instead of silently falling back — fallback would mask the misconfiguration and bill
  Naelao's provider account. Applied to both provider branches (tools-list + tool-call); the
  reserved money-in tool-name guard covers platform-keyed calls identically. This closes §A1.18
  Phase P: the routing existed; the key model was the missing piece. Still needed for live use:
  `wrangler secret put COMPOSIO_API_KEY` per environment (degrades honestly until set); the
  per-user OAuth connect flow (G-BF03) and the curated universal catalogue entries (G-BF04) are
  the next increments.
- **G-BF08 — `free_tier_eligible` enforcement.** The flag existed since Phase F, was projected to
  the dashboard, and was never checked anywhere. New `workers/spaces/src/template-catalog.ts`
  (loadTemplateCatalog extracted from index.ts — preserving business-create.ts/create-space.ts's
  one-way import rule — with `free_tier_eligible` added to the projection and the KV cache key
  bumped to v2), plus `resolveOrgPlanTier` (unknown org → "free", fails CLOSED) and
  `checkFreeTierTemplateEligibility`. Gated at BOTH template entry points: `createBusinessForEndUser`
  (product businesses + reseller spaces — the plan checked is the OWNING builder org's, checked
  before any side effect) and `createSpaceRecord` (POST /spaces + /builder/products). Deliberate
  asymmetry, documented in code: the TIER lookup fails closed, but a genuinely UNAVAILABLE
  catalogue degrades OPEN — this is a monetization gate, not a security boundary, and failing
  closed would 403 every free-plan creation during an agents-worker outage (and break every
  dev/test env without the binding). `shell/manifest.template_catalog` now carries the flag for
  the create-business dialog.
- ### 3. Server-Side Enforcement (The Compliance Gate)
A compliance rule cannot just be a UI hiding trick. If someone tries to send an API request with an unallowed model via curl or the developer API, **the server must reject it**.
In `workers/agents/src/index.ts` and `NaelaoAgentDO.ts`:
```typescript
// Inside /agent/run route (workers/agents/src/index.ts)
export function validateModelForSpacePolicy(
  requestedModel: string,
  spaceModelPolicy?: VerticalModelPolicy
): { valid: boolean; reason?: string } {
  // If template has no restrictive policy, allow platform default allowlist
  if (!spaceModelPolicy || spaceModelPolicy.mode !== "whitelist_only") {
    return { valid: isAllowedModel(requestedModel) };
  }
  // Enforce the vertical whitelist strictly
  const isWhitelisted = spaceModelPolicy.allowedModelIds.includes(requestedModel) ||
                        (requestedModel.startsWith("custom/") && spaceModelPolicy.allowedModelIds.some(m => m.startsWith("custom/")));
  if (!isWhitelisted) {
    return {
      valid: false,
      reason: `Compliance Violation: Model '${requestedModel}' is not certified for this vertical space. Permitted models: [${spaceModelPolicy.allowedModelIds.join(", ")}]`
    };
  }
  return { valid: true };
}
```
- #### The Filter Logic in `ModelSelector.tsx`:
```typescript
// apps/shell/src/components/ModelSelector.tsx
export function ModelSelector({
  spaceModelPolicy,
  selectedModel,
  onModelChange
}: {
  spaceModelPolicy?: VerticalModelPolicy;
  selectedModel: string;
  onModelChange: (model: string) => void;
}) {
  // Filter visible models by the template's policy
  const visibleModels = useMemo(() => {
    if (spaceModelPolicy?.mode === "whitelist_only") {
      return ALLOWED_MODELS.filter(m => spaceModelPolicy.allowedModelIds.includes(m.id));
    }
    return ALLOWED_MODELS; // Standard spaces see full platform list
  }, [spaceModelPolicy]);
  return (
    <div className="model-selector-dropdown">
      <div className="dropdown-header">
        {spaceModelPolicy?.pickerHeaderLabel || "Select Model for this Session"}
      </div>
      {visibleModels.map(m => (
        <button
          key={m.id}
          className={`model-option ${selectedModel === m.id ? "active" : ""}`}
          onClick={() => onModelChange(m.id)}
        >
          <span className="model-name">{m.name}</span>
          <span className="model-badge">{m.badge}</span>
        </button>
      ))}
    </div>
  );
}
```
- ### Summary of Benefits
1. **Compliance by Construction:** Hospital, legal, and financial cowork spaces guarantee that staff cannot accidentally route sensitive data through unapproved models.
2. **Zero Clutter for Professionals:** A doctor or lawyer isn't confused by 20 generic coding or reasoning model names. They see **only the 2 or 3 models certified for their work**.
3. **Elevates Private Fine-Tuned Models:** Puts the company’s own fine-tuned models (`kind: "model_studio"`) directly at the top of the list as the primary recommendation for that vertical.

### 72. Private LoRA Model Dynamic Edge Loading

**Final behavior:** Routes `custom/*` model calls through AI Gateway, dynamically injecting company LoRA weights onto base models at edge runtime.

**Production acceptance contract:**
Production entry: no custom-model route with enforced weight boundary.
Persistence/deployment: no certified LoRA binding or deployment config.
Required observable verification: no LoRA routing boundary test exists.

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
- The Gap Throughout the spec, DOs and Workers call this.env.NAELAO_AI_GATEWAY.messages.create({ model: '...', max_tokens: 200 }) as if NAELAO_AI_GATEWAY were a Workers AI binding or SDK object. Cloudflare AI Gateway is a URL-based proxy, not a binding type — it has no binding interface and exposes no messages.create() method. The correct pattern (documented in shared/ai-client.ts) is to pass a modified baseURL to the Anthropic SDK. Two different binding name variants (env.AI_GATEWAY and env.NAELAO_AI_GATEWAY) also appear in the same codebase, one of which will be undefined at runtime. Every DO or Worker that calls .messages.create() via this binding will throw TypeError: this.env.NAELAO_AI_GATEWAY.messages is undefined.
- - `workers/agents/src/connectors/oauth.ts` — generic OAuth2+PKCE helpers (not Whop-specific code;
  any future connector with a catalogue `oauth` spec reuses these): `generatePkce`,
  `buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshTokens` (Whop rotates the refresh token on
  every use — the new one is always persisted, the old one never reused), and a KV-backed
  single-use OAuth ticket (`issueOAuthTicket`/`consumeOAuthTicket`) mirroring the codebase's own
  stream-ticket precedent: a short-lived, server-held, single-use ticket rather than putting a
  PKCE verifier or any credential in a browser-navigable URL.
- New `ConnectorDefinition.oauth` field (`catalogue.ts`): authorize/token URLs, scopes, and env-var
  NAMES for the client id/secret (never values in catalogue data). Whop's entry gained one.
- `POST /connectors/:platform/oauth/start` (authenticated `requireVerifiedTenant`, since this hop
  is a plain fetch, not a page navigation): generates the PKCE pair, stores
  `{verifier, spaceId, tenantId, userId, returnUrl, platform}` under a random ticket id
  (`AGENT_CACHE`, 10-minute TTL — long enough for a human to click through Whop's consent
  screen), and returns `{authorize_url}` with the ticket as `state`. The frontend does a REAL
  browser navigation to this URL.
- `GET /connectors/:platform/oauth/callback` — PUBLIC/unauthenticated (Whop redirects the raw
  browser here; the single-use ticket in `state` IS the auth, consumed — deleted — on first
  read, so a replayed callback URL from browser history/proxy logs can never redeem twice).
  Exchanges the code server-side (holds the client secret), vaults
  `{access_token, refresh_token, expires_at}` as JSON under the connector's own credential name
  (reusing the exact `POST /spaces/:spaceId/credentials` upsert path item 52's manual flow
  already used), upserts the `mcp_servers` row to `auth_type: "oauth2"`, and 302-redirects the
  browser to the caller's own `return_url` with `?whop_connected=1` (or `?whop_oauth_error=...`)
  — the tokens themselves never reach the browser.
- `POST /internal/connectors/oauth/refresh` (HMAC-gated, same `requireVerifiedTenant` check) is
  the ONLY place that ever holds the Whop OAuth client secret. `workers/mcp-hub/src/index.ts`'s
  `buildAuthHeaders` gained an `oauth2` branch (`resolveOAuthAccessToken`): parses the vaulted
  JSON, and when within 5 minutes of `expires_at`, calls this refresh endpoint (new
  `AGENTS_WORKER` service binding on mcp-hub) rather than
- ### 1. The End-to-End Auto-Researcher Pipeline
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THE AUTO-RESEARCHER TRAINING ENGINE                      │
│                                                                             │
│ 1. [Ingestion]         Upload 500 PDFs, past tickets, Notion exports, docs  │
│                               │                                             │
│ 2. [Edge Synthesis]    Workers AI (Llama 3.2 3B) converts unstructured text │
│                        into 10,000 high-quality JSONL instruction pairs:    │
│                        `{"prompt": "...", "completion": "..."}`             │
│                               │                                             │
│ 3. [Auto-Researcher]   Agent optimizes hyperparameters & trains LoRA        │
│                        adapter weights on Cloudflare Workers AI             │
│                               │                                             │
│ 4. [Automated Eval]    Runs benchmark test cases (Base 8B vs Fine-Tuned 8B) │
│                        Verifies hallucination drop & accuracy gains         │
│                               │                                             │
│ 5. [Model Registry]    Model is registered as `custom/acme-support-v1`      │
│                        Instantly appears in the Model Selector for team!    │
└─────────────────────────────────────────────────────────────────────────────┘
```
- ### 2. How Cloudflare Infrastructure Powers This at Low Cost
You do not need a dedicated $10,000/month GPU server. You leverage Cloudflare’s native stack:
1. **R2 Training Buckets:** The raw unstructured documents and the synthesized `dataset.jsonl` files live in your project's R2 workspace.
2. **Workers AI Edge Synthesis:** Lightweight models (`@cf/meta/llama-3.2-3b-instruct`) run in parallel isolates to clean, deduplicate, and format raw text into clean training prompt-completion pairs.
3. **Cloudflare Workers AI LoRA Adapters:** Instead of training a 70B model from scratch, the system trains a **LoRA adapter (typically 20MB–100MB)** on top of base models like Llama 3.1 8B. Cloudflare loads these adapters dynamically on their edge GPUs at inference time.
4. **Cloudflare Workflows (`ModelTrainingWorkflow.ts`):** Manages the multi-hour training, loss-curve monitoring, and automated benchmark scoring without connection timeouts.
5. **AI Gateway Integration:** Once registered, AI Gateway routes team prompts directly to the base model + custom LoRA adapter transparently.
- // Cloudflare Workers AI LoRA dynamic loading
  return {
    model: "@cf/meta/llama-3.1-8b-instruct",
    lora: loraAdapterId // Injects company adapter weights at edge runtime!
  };
}
```
- model_policy: {
    mode: "whitelist_only",
    pickerHeaderLabel: "🏥 HIPAA & Clinically Vetted Models",
    defaultModelId: "custom/hospital-clinical-llama8b-v1",
    lockedByCompliancePolicy: true, // Admin cannot accidentally enable unvetted models
    allowedModelIds: [
      "custom/hospital-clinical-llama8b-v1",     // Company's private fine-tuned model
      "@cf/meta/llama-3.3-70b-instruct",        // Cloudflare enterprise BAA endpoint
      "claude-3-7-sonnet-20250219"              // High-precision clinical research
    ]
  },
  // Projects, viewports, knowledge seeds...
};
```
- ### 4. UI Experience in `ModelSelector.tsx`
When a doctor or lawyer opens the **Model Selector (`ModelSelector.tsx`)** in their space, the dropdown **only renders their certified vertical models and private fine-tuned weights**:
```
┌─────────────────────────────────────────────────────────────┐
│ 🏥 Clinically Vetted Models (Hospital Policy Locked):       │
├─────────────────────────────────────────────────────────────┤
│ • 🧠 Clinica Llama-8B v1.2 (Fine-Tuned on Hospital EHRs)  ⭐ │
│ • ⚡ Llama 3.3 70B (Cloudflare HIPAA Edge Gateway)          │
│ • 🔬 Claude 3.7 Sonnet (Clinical Research & Pharmacology)   │
├─────────────────────────────────────────────────────────────┤
│ 🔒 Other foundation models are disabled by space policy.    │
└─────────────────────────────────────────────────────────────┘
```
- ### Summary of Benefits
1. **Compliance by Construction:** Hospital, legal, and financial cowork spaces guarantee that staff cannot accidentally route sensitive data through unapproved models.
2. **Zero Clutter for Professionals:** A doctor or lawyer isn't confused by 20 generic coding or reasoning model names. They see **only the 2 or 3 models certified for their work**.
3. **Elevates Private Fine-Tuned Models:** Puts the company’s own fine-tuned models (`kind: "model_studio"`) directly at the top of the list as the primary recommendation for that vertical.

### 73. Sovereign Enterprise Air-Gapped Local AI Engine

**Final behavior:** Connects on-premise GPU clusters running Ollama / vLLM via `LocalTunnelDO` over encrypted WebSockets with zero cloud data egress.

**Production acceptance contract:**
Production entry: local tunnel connect and local-machine prebuilt.
Persistence/deployment: hibernating WebSocket DO.
Required observable verification: local tunnel tests cover token isolation, not local AI E2E.

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
- The Gap: Government, defense, and highly regulated enterprises cannot use cloud SaaS due to data sovereignty requirements. No private or air-gapped deployment option exists. These enterprise segments are entirely inaccessible as customers.
 Required Fix: Design self-hosted deployment package: Docker Compose / Kubernetes Helm chart with all Naelao services containerized. Replace CF-specific APIs: Durable Objects → Redis/SQLite; Queues → RabbitMQ; R2 → MinIO; KV → Redis; Analytics Engine → ClickHouse; Workers → Node.js/Fastify. Publish migration shim layer that maps CF SDK calls to self-hosted equivalents. Provide Terraform modules for AWS/Azure/GCP. Enterprise license with SLA. Air-gapped installer via signed container registry mirror.
- **Benchmark runner** (`infra/scripts/run-eval-suite.mjs`, dependency-free Node, manual dispatch
only — costs real tokens, not wired into CI): loads a JSONL dataset, finds-or-creates the named
suite via the real `/evals` API (never touches a worker directly — goes through
`NAELAO_API_BASE`/`NAELAO_TENANT_TOKEN` like any other authenticated caller), reads the suite's
LAST stored result BEFORE running again, runs it in `mode=agent`, and exits non-zero when
`avg_score` regresses by more than `--threshold` (default 0.5) versus that prior run — the
regression gate the plan called for, without yet wiring it into CI (no live deployment to point
it at in this pass — see the top-level the established architecture discussion on live-access status).
- 301 - 303
What about allowing companies to download and run models on local machine on ollama or other local llm models runner and connect ollama to their space
This is one of the most requested features for **Enterprise, Legal, Defense, and Healthcare** clients: **The Local / Air-Gapped On-Premises AI Runner**.
Many companies are legally prohibited (under HIPAA, GDPR, or defense contracts) from sending sensitive prompts over the internet to third-party AI APIs (Anthropic, OpenAI, Google). They also already have expensive on-premise hardware (Mac Studio M3/M4 Ultras, RTX 4090 workstations, or local NVIDIA H100 clusters) running **Ollama, vLLM, LM Studio, or llama.cpp**.
Because your codebase **already has `LocalTunnelDO` (`workers/agents/src/do/LocalTunnelDO.ts`) and the `local-agent` daemon**, enabling local Ollama clusters to power their Cloudflare workspace is a natural extension of the architecture.
- ### 1. The Zero-Port Local Tunnel Architecture
The technical challenge is that the company's Ollama instance is on their private office network (`http://localhost:11434`) behind corporate firewalls and NAT, while your agents run on Cloudflare Edge Durable Objects.
Using your **`LocalTunnelDO` WebSocket Bridge**, the company opens an **outbound-only encrypted tunnel** without opening any firewall ports:
```
┌─────────────────────────────────────────────────────────────┐
│                 COMPANY PRIVATE ON-PREM NETWORK             │
│                                                             │
│  [ Local GPU Cluster / Workstation ]                        │
│  • Ollama / vLLM running on `http://localhost:11434`        │
│  • Models: DeepSeek R1, Llama 3.3 70B, Qwen 2.5 Coder 32B   │
│                 │                                           │
│                 ▼                                           │
│  [ AVOS Local Bridge Daemon (`npx avos-local`) ]            │
│  • Connects outbound WebSocket to Cloudflare LocalTunnelDO  │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼ (Encrypted WSS Connection with HMAC Token)
┌─────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE EDGE RUNTIME                  │
│                                                             │
│  [ LocalTunnelDO (Durable Object) ]                         │
│  • Routes OpenAI-compatible `/chat/completions` requests    │
│    from the agent down to the company's local GPU.          │
│                 ▲                                           │
│                 │                                           │
│  [ NaelaoAgentDO / Reasoner Loop ]                          │
│  • Selects: `model: "local/ollama/qwen2.5-coder:32b"`       │
│  • Zero prompts sent to external cloud AI vendors!          │
└─────────────────────────────────────────────────────────────┘
```
- #### Step 2: Auto-Discovery into the Model Selector
When the local daemon connects, it queries `GET http://localhost:11434/api/tags` and sends the list of installed local models to `SpaceDO`.
The company's **Model Selector (`ModelSelector.tsx`)** automatically updates across all team threads:
```
┌─────────────────────────────────────────────────────────────┐
│ 🔮 Select Model for this Session:                           │
├─────────────────────────────────────────────────────────────┤
│ 🖥️ ON-PREMISE LOCAL MODELS (Zero Cloud Egress)              │
│ • 🦙 Llama 3.3 70B (Local GPU Workstation)      [Active]  🟢 │
│ • 💻 Qwen 2.5 Coder 32B (On-Premises Ollama)               │
│ • 🧠 DeepSeek R1 8B (Private Air-Gapped)                    │
├─────────────────────────────────────────────────────────────┤
│ 🌐 FOUNDATION CLOUD MODELS (Optional)                       │
│ • Claude 3.7 Sonnet (Extended Reasoning)                    │
│ • Llama 3.3 70B (Cloudflare Edge)                           │
└─────────────────────────────────────────────────────────────┘
```

### 74. Strict Air-Gapped Space Compliance Lock

**Final behavior:** Router-level block physically preventing any request from reaching external cloud AI APIs when compliance lock is engaged.

**Production acceptance contract:**
Production entry: required central egress policy gate absent.
Persistence/deployment: required immutable space compliance setting/audit absent.
Required observable verification: no external-fetch denial journey test exists.

**Retained implementation constraints:**
- 126. **Three more live-reported bugs, all root-caused to the SAME underlying gap: the reasoner's
     "available_operations" field was a bare flat list of 60+ op names with no description or
     grouping — plus two silent trace-persistence holes that hid real repeat/parked tool calls
     from the activity table.**
     - **The real root cause of "our API doesn't support programmatic thread creation or direct
       in-thread chat messaging"** (item 125 shipped exactly that capability the same session).
       `project-coordination` WAS wired into the assistant's prebuilt list and `tools.
       availableOperations()` DID include `thread.create`/`thread.send_message` in the payload —
       but only as bare strings among dozens of others, with zero indication of what any of them
       do or what parameters they take (unlike `candidate_scripts`, which carries a real
       description/parameters/health per entry). A model asked to "communicate with an agent
       directly in a thread" had no way to recognize an opaque name like `thread.send_message` as
       the answer. New `ScriptToolSurface.availableOperationsGrouped()` groups the same ops by
       their owning prebuilt SCRIPT, reusing that script's own (already-written) description —
       `reasoner.ts` now sends this grouped structure as `available_operations` instead of the
       flat list (falls back to the flat list when a caller/test doesn't supply groups), and
       `DECISION_INSTRUCTIONS` gained one sentence telling the model to read every group's
       description before concluding a capability doesn't exist. Zero new prose was written per
       operation — the fix is structural (grouping + reuse), not a bigger prompt.
     - **The intermittent "narration with no tool-call table underneath it," and the "it's sort of
       repeating the same task many times" observation — the SAME bug, now fixed.** `loop.ts`'s
       within-run repeat-call guard (an already-attempted `name+params` combo, or an action still
       sitting in `deferred` awaiting approval) correctly served the model a cached outcome and
       `continue`d — but neither branch ever called `pushTrace`, even though the "reason" step
       immediately before it (carrying that turn's own `narration`/`doing` text, e.g. "Checking
       Instagram MCP tools") always does. Every REPEAT attempt therefore showed a real status line
       with nothing in the table beneath it — exactly the reported screenshot, and exactly why it

- Required Fix: Audit high-subrequest paths in Space Workers. Mitigation: (1) Batch Analytics Engine writes: accumulate multiple events and write in a single multi-row batch call. (2) Batch external tool calls: if agent invokes multiple external APIs, fan out via single fetch with parallel sub-streams rather than N sequential fetches. (3) Cache DO reads: cache SpaceDO config reads in Worker memory for request duration to avoid repeated DO RPC calls. (4) Instrument subrequest counting via proxy wrapper on fetch(). (5) Alert when any request path exceeds 500 subrequests (50% threshold). Track max_subrequests_per_request in Analytics Engine.
- **The gap:** Slack's webhook verifier (`channels.ts`) already rejects requests older than 300s
(replay defense-in-depth on top of the primary control — the `(session, direction, external_id)`
unique-index dedupe in `channel_messages`, `NaelaoAgentDO.ts` — and per-space secret scoping,
which blocks cross-business replay). Email, Discord, and WhatsApp had no freshness check at all:
a captured, validly-signed webhook for any of these three channels could be replayed indefinitely
and would still verify.
- 301 - 303
What about allowing companies to download and run models on local machine on ollama or other local llm models runner and connect ollama to their space
This is one of the most requested features for **Enterprise, Legal, Defense, and Healthcare** clients: **The Local / Air-Gapped On-Premises AI Runner**.
Many companies are legally prohibited (under HIPAA, GDPR, or defense contracts) from sending sensitive prompts over the internet to third-party AI APIs (Anthropic, OpenAI, Google). They also already have expensive on-premise hardware (Mac Studio M3/M4 Ultras, RTX 4090 workstations, or local NVIDIA H100 clusters) running **Ollama, vLLM, LM Studio, or llama.cpp**.
Because your codebase **already has `LocalTunnelDO` (`workers/agents/src/do/LocalTunnelDO.ts`) and the `local-agent` daemon**, enabling local Ollama clusters to power their Cloudflare workspace is a natural extension of the architecture.
- #### Step 2: Auto-Discovery into the Model Selector
When the local daemon connects, it queries `GET http://localhost:11434/api/tags` and sends the list of installed local models to `SpaceDO`.
The company's **Model Selector (`ModelSelector.tsx`)** automatically updates across all team threads:
```
┌─────────────────────────────────────────────────────────────┐
│ 🔮 Select Model for this Session:                           │
├─────────────────────────────────────────────────────────────┤
│ 🖥️ ON-PREMISE LOCAL MODELS (Zero Cloud Egress)              │
│ • 🦙 Llama 3.3 70B (Local GPU Workstation)      [Active]  🟢 │
│ • 💻 Qwen 2.5 Coder 32B (On-Premises Ollama)               │
│ • 🧠 DeepSeek R1 8B (Private Air-Gapped)                    │
├─────────────────────────────────────────────────────────────┤
│ 🌐 FOUNDATION CLOUD MODELS (Optional)                       │
│ • Claude 3.7 Sonnet (Extended Reasoning)                    │
│ • Llama 3.3 70B (Cloudflare Edge)                           │
└─────────────────────────────────────────────────────────────┘
```
- ### 5. Enterprise Security: The "Air-Gapped Space" Lock
In **Space Settings**, enterprise admins can enable **`Air-Gapped Mode`**:
```typescript
export interface EnterpriseCompliancePolicy {
  airGappedOnly: boolean; // When true: ALL cloud AI APIs (Anthropic/OpenAI/Workers AI) are blocked
  allowedLocalTunnels: string[]; // Whitelisted on-prem GPU machine IDs
}
```
* **The Guarantee:** If `airGappedOnly === true`, the router and `NaelaoAgentDO` **physically refuse** to dispatch calls to any external cloud URL. If the local Ollama machine goes offline, the system halts with a security alert rather than silently falling back to a cloud model.

### 75. Finite Task Project Auto-Sleep

**Final behavior:** When the Project Journal Task DAG hits 100% completion, Durable Objects clear all alarms and hibernate at $0 cost.

**Production acceptance contract:**
Production entry: project journal and ToolSandbox idle alarm.
Persistence/deployment: durable Git/R2/SQLite plus alarms.
Required observable verification: idle tests do not prove project completion cleanup.

**Retained implementation constraints:**
- 98. **The assistant had never once been told who it was, `/new` silently dropped the user's first
    message, and a completed run 404'd on its own status poll. All three reported by the user, all
    three root-caused against live behaviour rather than guessed at.**
    - **The agent's own system prompt reached the model in no run, ever.** `loadAgentConfig` read
      `system-prompt.md` from R2 on every call and used it only to parse approval gates;
      `GatewayReasoner` hardcoded `system: DECISION_INSTRUCTIONS`. Every word of
      `LAUNCHPAD_ASSISTANT_PROFILE` — the business-building methodology, the wallet rules, "read the
      project journal first" — written, stored, never delivered. Asked what business it ran, the
      assistant said "that information is not provided in the given context", which was true.
      New `ReasonerDeps.agentPrompt` + `composeSystemPrompt` (identity, protocol, then a one-line
      identity anchor — recency wins on small models), wired at both reasoner sites.
      **That alone was not enough, and the reason is worth keeping.** A direct gateway call proved
      llama-3.3 follows a plain system prompt correctly, yet the SAME identity inside the real
      request still produced "I am an AI assistant, and I am not running a business for you" — the
      real request also carries a 4.3k-char protocol and five tool schemas, and `tool_choice:
      "required"` pulls attention onto the machinery. Fixed by ALSO carrying a bounded
      `who_you_are` digest in the payload the model is answering about. Verified live: it now
      answers "I am the Naelao Agent, a business-builder Space Assistant for your Launchpad
      Space…". Diagnostic worth reusing: when a prompt "should" work, test the model in isolation
      first — it separates delivery from attention in one call.
    - **`/new` created a session and nothing happened.** Home passes the opening line as `?q=`; the
      session page stripped `q` from the URL on mount, Next syncs that `replaceState` back into
      `useSearchParams`, and Chat cannot send until its history has loaded a beat later — so the
      message was retracted before the surface was ready for it. Reproduced exactly in a real
      browser: `POST /sessions` 201, then **no `POST /agent/run` at all**, 0 messages. Fixed by
      latching `q` on first render (`useState` initialiser) plus a second latch inside Chat, so
      whoever hands the message over, the first non-empty value wins and cannot be withd
- The Gap
 When a Space is deleted (soft-deleted via `deleted_at` timestamp in SpaceDO), no cleanup is performed on child Durable Objects: AssistantDOs, AgentDOs, AssistantSandboxDOs, WalletDOs, SkillRegistryDOs, and ProjectDOs for every project in the space remain active in Cloudflare's billing system. CF bills for DO storage by active SQLite bytes. A space with 50 users, each with an AssistantDO holding 50MB of conversation history, continues to incur ~$0.25/month in DO storage fees after deletion — forever. Over thousands of deleted spaces, this becomes a significant cost leak.
- **Explicit signals — no new ingestion.** `agent_activity_log` (item 40) already carries
`event_type`/`tokens_used`/`cost_credits`/`created_at` for every run completion/failure and
approval request — exactly what error rate and avg/total cost need. New `GET /spaces/:spaceId/
agent-signals?project_id=&window_hours=` (SpaceDO's `computeAgentSignals`, builder-only, same
gate as `agent-activity`) rolls it up on read: `runs_total/completed/failed`, `error_rate`,
`avg_cost_credits`, `total_cost_credits`, `approvals_requested`. "Regenerations" (a proxy for the
user hitting retry) is computed in application code — 2+ run events on the SAME thread within 5
minutes — rather than a SQL window function, since the row counts here are always small and DO
SQLite window-function support isn't otherwise relied on anywhere in this codebase.
- # 1. Should All Bots Keep Waking Up? (Finite vs. Standing Projects)
**No, absolutely not.** Running endless wake-ups on every project would waste tokens, clutter logs, and drain business wallets.
Projects should have two distinct **Lifecycle Modes**:
```
┌─────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ 🏁 FINITE TASK PROJECTS (Build & Sleep)                     │ 🔄 STANDING / CONTINUOUS PROJECTS (Ongoing 24/7 Desks)      │
├─────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ • **Examples:**                                             │ • **Examples:**                                             │
│   - *"Build an MVP landing page"* (`product_dev`)           │   - *"24/7 WhatsApp Phone Desk"* (`customer_bot`)          │
│   - *"Audit this 50-page M&A contract"* (`doc_studio`)      │   - *"Weekly B2B Lead Scraper"* (`growth_engine`)           │
│   - *"Run one-off data migration"* (`ops_dispatcher`)       │   - *"Daily Revenue Review & Alerts"* (`wallet_vault`)      │
│ • **Lifecycle:**                                            │ • **Lifecycle:**                                            │
│   1. Agent executes the 4 tasks in the Project Journal.     │   1. Wakes up on schedules (`cron: "0 9 * * *"`), webhooks,│
│   2. Once all tasks hit `COMPLETED`, **the bots SLEEP**.    │      or live customer phone calls.                          │
│   3. All cron alarms are cleared. **DO hibernates at $0**.  │   2. Runs 24/7 background operational loops.                │
│   4. Sits idle until a human types a new message.           │                                                             │
└─────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```
- #### How it works in the Codebase (`SpaceDO.ts`):
* When creating a project, `projects.lifecycle` is set to either `'finite'` or `'continuous'`.
* For `'finite'` projects, the moment the last task in `SpaceDO.tasks` transitions to `COMPLETED`:
  1. The bot logs a final summary: *"All project tasks completed successfully."*
  2. The Durable Object **clears all scheduled alarms** and enters dormant hibernation.
- ### Summary
1. **Finite Projects Sleep Automatically:** Projects built for a single task (like building a website or auditing a contract) **shut down their alarms and sleep at $0 cost** the second the journal hits 100%.
2. **Context-Aware Connector Selection:** The agent defaults to **Personal accounts in private 1-on-1s** and **Shared company accounts in public team channels**, with a clear visual pill in the chat bar.
3. **Enterprise Power with Consumer Simplicity:** Non-technical users get a clean, human-friendly experience with simple buttons and previews, while all Git versioning, container promotions, and database isolations run invisibly at the edge.
- ### 1. Blind 24/7 Heartbeats vs. Self-Scheduled Adaptive Alarms
```
┌─────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ ❌ BLIND 24/7 HEARTBEATS (The Naive Anti-Pattern)            │ ✅ SELF-SCHEDULED ADAPTIVE ALARMS (Your Engine)             │
├─────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ • Wakes up on a fixed timer (e.g. every 5 min) even if      │ • **Sleeps at $0 cost** when there is no work to do.        │
│   there is zero work to do.                                 │ • **Wakes up instantly (10ms)** on events: customer chats,  │
│ • Burns 80% of token budgets on: *"No changes found."*      │   new webhooks, PR merges, or file edits.                   │
│ • Exhausts provider rate limits (TPM/RPM) on idle spaces.   │ • **Sets its own alarm:** *"I finished step 1. I'll wake    │
│ • Spams journals with empty status logs.                    │   myself up in 4 hours to check the lead response."*        │
└─────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```
- #### Turn 2: Self-Scheduled Delayed Wake-Up (When Waiting is Required)
* **Goal:** *"Send cold audit emails and follow up in 24 hours."*
* The agent drafts and dispatches the outreach emails on Turn 1.
* It does **not** sit awake burning CPU. It calls the `schedule.wake_me` tool [1.3.4, 1.3.17]:
  ```typescript
  await ctx.run("schedule.wake_me", {
    delayMinutes: 1440, // 24 Hours
    goal: "Check response status for Miami Dental outreach batch and follow up."
  });
  ```
* The Durable Object sets a native **Cloudflare Alarm (`this.ctx.storage.setAlarm`)** and **completely hibernates at $0 cost** [1.2.5].
* Exactly 24 hours later, Cloudflare fires the alarm, the agent wakes up with the goal in hand, checks the inbox, and takes the next step.
- ### 4. Why This Architecture Destroys Grok Bot’s Unit Economics
* **Grok Bot's Cost Problem:** Because xAI attempts to keep heavy cloud instances running for agents, they are forced to charge **$300/month (SuperGrok Heavy / Cursor Ultra)**.
* **Your Platform's Cost Advantage:** By combining **Durable Object Hibernation** with **Self-Scheduled Alarms** [1.2.5], an agent that is idle for 23 hours a day **costs $0.00 in compute and 0 tokens**.
* You deliver the **exact same user perception of a 24/7 proactive coworker** for **$29/month while keeping 85%+ gross profit margins**.

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
