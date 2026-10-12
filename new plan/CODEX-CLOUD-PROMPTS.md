# Naelao: 10 sequential Codex Cloud prompts

Prepared 2026-10-11. These are reading batches, not prescriptive implementation contracts.
Let the coding model design the implementation after inspecting the requirements and code.
No batch is pre-completed. Existing implementation and historical test labels are evidence
to investigate, never permission to skip requirements.

## Before sending the implementation prompts

1. Connect GitHub and select `b45406809-ux/Naelao-1`. Use the pushed
   `Mcbt5s-Backup-2` branch as the starting point, not a potentially older default branch.
   Confirm the checkout includes this file and both original documents.
2. In the current web/desktop experience, choose **Work in > Cloud > Select environment**,
   create or select the repository environment, review setup, and **Publish** it before
   starting a task. Changes to reusable setup require republishing; existing tasks keep
   their own state. [Official cloud guide](https://learn.chatgpt.com/docs/cloud).
3. Turn on **Allow Codex to access internet**. Start with **Package managers** and add
   official documentation hosts needed for research, including `developers.cloudflare.com`,
   `developers.openai.com`, `learn.chatgpt.com`, `nodejs.org`, `www.typescriptlang.org`,
   `pnpm.io`, `playwright.dev`, and `vitest.dev`. Add exact vendor/download hosts as needed;
   **All (unrestricted)** is available if you prefer broader access.
   Save, test access, and republish. Organization restrictions still apply.
   [Official environment guide](https://learn.chatgpt.com/docs/environments/cloud-environments).
4. Choose **GPT-6.1 Sol** if the actual model picker offers it. Current documentation
   recommends it for complex coding when available, and documents the `gpt-6.1-sol`
   identifier. Availability depends on account, client, workspace settings and rollout.
   A prompt cannot force the hosted model to change; a repository `config.toml` is not a
   guarantee of cloud selection. If your legacy cloud UI lacks a picker, use the offered
   model or try the current Work/Codex cloud experience. Start with the supported default
   reasoning effort; use higher effort if needed, without Ultra for this sequential workflow.
   [Official model guide](https://learn.chatgpt.com/docs/models).
5. Let environment setup install this repository's dependencies. Use Node 22.11+ and the
   repository's pinned `pnpm@9.12.0`. A starting install script is below. The repository
   contains newly added workspace packages: if the frozen install reports a stale lockfile,
   have setup inspect the mismatch, deliberately run `pnpm install --no-frozen-lockfile`,
   and preserve the resulting lockfile for review. Do not conceal install failures.
6. Start with disposable test data and mocked providers. For live checks, configure only
   the credentials and test resources actually required. Current cloud **Network secrets**
   substitute HTTPS credentials through the proxy; programs get placeholders. Values a
   program must read directly use **Environment variables** or the **Personal vault**.
   Verify each integration supports the chosen mechanism; file encryption/signing cannot
   use a substituted placeholder as its cryptographic key. Never commit credentials.
   [Official secret configuration](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets).
7. If you still use legacy Codex Cloud, enable agent internet access in its environment
   settings. Setup has internet access separately; legacy secrets are available only
   during setup and removed before the agent phase. Do not expect an `export` in setup
   to survive into the agent shell. Reconfigure setup/cache when dependency requirements
   change. [Legacy environment guide](https://learn.chatgpt.com/docs/environments/cloud-environment),
   [legacy internet guide](https://learn.chatgpt.com/docs/cloud/internet-access).
8. Use one cloud task and send prompts 1 through 10 as follow-ups, waiting for each result.
   If you use a new task, first commit/apply the previous task's changes and select that
   resulting branch/commit. Fresh tasks must not accidentally start from the old baseline.
   Cloud compute does not automatically provide Docker, Windows/macOS machines, Cloudflare
   resources, live BYOK keys or a private-machine connection; check capabilities explicitly.
   Keep unavailable live checks visible rather than treating mocks as deployment evidence.

Starting install script, run from the checked-out repository root:

```bash
set -euo pipefail
node --version
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm --version
pnpm install --frozen-lockfile
```

The previous local code-generation-only restriction does not apply to the cloud
implementation prompts below: install dependencies, run tests, inspect failures and fix code.

## Shared rules for every prompt

- Requirements sources are only `new plan/New Text Document (12).txt` (13,666 lines) and
  `new plan/New Text Document (13).txt` (1,398 lines), in that chronological order.
  Do not use historical plan files or old checkpoints as product authority. Follow applicable
  repository instructions, and inspect source/configuration/tests as needed.
- Read each listed range in ascending order, in manageable windows of about 150–200 lines.
  Primary ranges own the current batch's requirements; look-ahead ranges resolve amendments
  and dependencies. Reading something early does not automatically complete its later batch.
  Do not reread both entire documents at every step.
- Later explicit corrections override earlier conflicting proposals on the same subject.
  Keep earlier requirements when later text merely adds detail. Document 13 can amend
  Document 12. Repeated examples describe one feature, not duplicate implementations.
  References to brands, old names, prices, latency, APIs or hypothetical code are not proof
  that a vendor capability exists. Validate important assumptions against current official docs.
- Before fixing a design, search unread later portions of these two source files for the
  relevant subsystem names. Read the matching context with line numbers and record any
  additional ranges consulted. This prevents the listed look-aheads from becoming a blind
  whitelist that misses a later correction. Do not read unrelated historical plans.
- Work sequentially as one implementation worker. Inspect the current code independently,
  reuse sound implementations, fix incomplete or incorrect ones, and implement missing behavior.
  Do not assume any old step passed; do not erase valid existing work simply to start over.
- Cloud execution, private-machine tunnels and local models remain supported product paths.
  Cloud may be default. Placement, data-residency and egress policies must control authorized
  private-machine/local-model routing. No forbidden cloud fallback. An outbound internet tunnel
  is not a physically disconnected whole-OS installation.
- Decide files, architecture, migrations and meaningful tests yourself. Research and correct
  invalid assumptions rather than copying illustrative code blindly. Keep UI thread/session
  parity, genuine worker delegation and authorization boundaries where the source requires them.
- Run appropriate tests and integration checks, including restart/replay and failure scenarios
  where relevant. Distinguish proven behavior from mocked behavior and unavailable live checks.
  Fix issues within the current batch and preserve working earlier behavior.
- Maintain one small `new plan/CLOUD-PROGRESS.md` as you work: source ranges, reconciled
  amendments, decisions, changed files, commands/results, open dependencies, next action.
  Initialize all 10 batches as UNASSESSED; update them only from fresh evidence. Track substantive
  requirement coverage, not just whether a range was read. Keep original TXT files unchanged.
- Finish the current batch before moving on. Report changes, verification and blockers, then
  stop for my next numbered prompt. If a batch cannot fit one task turn, record the exact
  unfinished action and continue that batch when asked; never silently mark it done.

Linux cloud paths are relative to the repository root, not the old Windows `C:\Users\...` path.
Example bounded read: `nl -ba 'new plan/New Text Document (12).txt' | sed -n '158,245p'`.

## Copy-and-paste prompts

1. **Document 12: lines 1–1564**

```text
Implement Naelao reading batch 1 of 10. Read "Shared rules for every prompt" in
new plan/CODEX-CLOUD-PROMPTS.md and follow them.

Primary: new plan/New Text Document (12).txt, lines [1–1564].
Look ahead in Document 12: [6127–6560, 6965–7086, 11001–11135,
11707–11776, 12348–12763, 13207–13344].
Look ahead in new plan/New Text Document (13).txt: [735–1062, 1147–1398].

Read in bounded windows. Resolve later amendments before choosing architecture.
Independently assess the existing repository; assume no previous implementation
step is complete. Design, implement and test the final requirements belonging
to the primary range. Record decisions and fresh evidence in CLOUD-PROGRESS.md.
Do not substitute a plan-only response for implementation. Stop after this batch.
```

**Progress (2026-10-12): PARTIAL — local implementation complete; platform/data gates remain.** Review-card decision/merge UI, roster
authorization, replay handling, project review panel, and private output-log
expiry indexing are implemented with focused mocked tests. Injection attempts are
now quarantined at ingress; known injection text in tool results is withheld
before model replay. Task file paths are host-signed and enforced by VFS and
virtual Bash; scoped workers cannot use native Python/Tier-5/6 paths until the
runtime supports file-scoped mounts. A complete-request context preflight now
counts system, user, tool schema, and image context with a conservative reserve.
Agents tests (55 files / 218 tests), Spaces tests (12 tests, including host routing), both worker
typechecks, and `git diff --check` pass. See `new plan/CLOUD-PROGRESS.md` for the
four exact remaining external gates and evidence. Batch 1 was committed and pushed as
`c2875e5` on `Mcbt5s-Backup-2`; user waived live Cloudflare tests. Batch 2 is now
PARTIAL_NEEDS_PLATFORM: canonical gadget scopes, tenant/member-checked app routes,
CSP hardening, a dynamic-page registry/renderer, per-tenant hostname enforcement,
and single-use HMAC form actions are implemented and tested. Deployment still needs
an owned preview zone and wildcard Worker route; pages fail closed until
`DYNAMIC_PAGE_HOST_SUFFIX` is configured. See CLOUD-PROGRESS.md. Batch 3 is IN PROGRESS, and Batch 4 is IN PROGRESS; see CLOUD-PROGRESS.md for current evidence and open gates.

2. **Document 12: lines 1565–3590**

```text
Implement Naelao reading batch 2 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md. Inspect the preceding cloud work and its evidence.

Primary: new plan/New Text Document (12).txt, lines [1565–3590].
Look ahead in Document 12: [6127–6690, 11001–11135, 11707–11776,
12213–12559].
Look ahead in new plan/New Text Document (13).txt: [237–734, 1223–1374].

Read in source order, reconcile later corrections, and think through the
architecture yourself. Implement and test all final requirements owned by
the primary range, including their integration with existing code. Record
additional later ranges consulted, decisions, results and blockers. Stop here.
```

**Progress (2026-10-12): PARTIAL_NEEDS_PLATFORM — local runtime implemented; deploy route needs an owned preview zone.** Four canonical installation scopes (`PROJECT_SHARED`, `PROJECT_USER`, `SPACE_SHARED`, `SPACE_USER`) map to isolated durable gadget facets while legacy scope names remain compatible. Gadget app/data/MCP routes validate tenant ownership and active space membership; initialization is admin-only and constrained to the named `SPACE_SHARED` tier-3 actor. The app iframe uses restrictive CSP/no-store/security headers. Public pages have a registry, static safe-HTML renderer, tenant-specific host enforcement on a suffix separate from the app origin, strict CSP, and action-bound, expiring, single-use HMAC tokens that can write only declared keys/fields. Spaces tests pass (18 files / 57 tests), agent-sdk tests pass (17 files / 59 tests), both typechecks and `git diff --check` pass. Cloudflare documentation fetch returned proxy 403; live tests were waived. The runtime remains disabled until an owned preview suffix and wildcard Worker route are configured. Batch 3 is IN PROGRESS, and Batch 4 is IN PROGRESS; see CLOUD-PROGRESS.md for current evidence and open gates.

3. **Document 12: lines 3591–5657**

```text
Implement Naelao reading batch 3 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md. Prior labels are not completion evidence.

Primary: new plan/New Text Document (12).txt, lines [3591–5657].
Look ahead in Document 12: [6690–6901, 7141–7548, 10694–11000,
11423–11481, 11707–11776, 12213–12347].
Look ahead in new plan/New Text Document (13).txt: [1–236, 1324–1374].

Use later amendments to interpret earlier examples. Inspect, design, implement
and verify the current range's final requirements yourself. Avoid duplicate
features and hardcoded domain behavior where the source calls for extensions.
Update the cloud coverage/progress record with actual evidence and stop here.
```

**Progress (2026-10-12): PARTIAL_NEEDS_PLATFORM — independent local work complete; continue with Batch 4.** Conformance runs 50 host-oracled fixtures in fresh Worker Loader isolates; local R2 hydration, regression rejection, and private-state access rejection pass. State-delta receipts gate blueprint export, activation and both marketplace publish paths. Structural JSON artifact policies are immutable, capped at two repairs, and resume only after scoped owner/admin approval. Desk-Drop has hashed single-use tickets, HttpOnly ProductUserDO cookies, same-origin Shell proxy, QR challenge and revocation; no shared identity issuer maps builder logins to ProductUserDO. Telegram/Meta review cards link to authenticated approvals; recipient-specific presence honors the actual owner/admin. Native payout reconciliation, 40/25→20→5 lifetime royalties, Pioneer-50 ranks, paid fixed-license checkout/webhook/fork entitlements and duplicate-charge refund records are implemented. Recurring template checkout stamps its ID and activates only on captured payment; signed local SQLite replay tests prove per-order idempotency. Current focused suite: 13 files / 29 tests; billing, marketplace, spaces and agents typechecks pass; local Wrangler dry-runs and state-delta smoke pass; migrations 0084–0091 applied locally. Live provider/Cloudflare requests were not made; Lemon Squeezy docs were blocked by proxy 403. Optional FDE escrow is not configured and has no custody/refund contract. See CLOUD-PROGRESS.md for evidence and these platform gates.

4. **Document 12: lines 5658–7973**

**Resume note (2026-10-12): Batch 3 independent local work is complete; focus on Batch 4.**
See CLOUD-PROGRESS.md for current checks and explicit external gates: no deployed provider
payload verification, configured optional escrow contract, or shared builder/ProductUser
identity issuer. Continue prompts 4–10 sequentially, commit/push each batch, and run the
requested final 1–10 coverage pass. Do not follow the older stop-after-one-prompt line
against the user's later instruction.

```text
Implement Naelao reading batch 4 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md and independently check current interfaces.

Primary: new plan/New Text Document (12).txt, lines [5658–7973].
Look ahead in Document 12: [11136–11776, 12348–12763, 13207–13344].
Look ahead in new plan/New Text Document (13).txt: [735–1398].

This batch includes consolidated subsystem blueprints and development/testing
requirements. Reconcile these with earlier implementations and later runtime
constraints. Research vendor assumptions; do not mechanically implement obsolete
examples or invent unavailable isolation guarantees. Implement and test the
final requirements, preserve tunnels and local models, record evidence, and stop.
```

**Progress (2026-10-12): PARTIAL_NEEDS_PLATFORM — local implementation complete; continue with Batch 5.** Read primary D12 5658–7973 in ascending windows, required D12/D13 look-aheads, and extra D12 12764–13206. Existing metering, terminal folding, private R2 tool output, LocalTunnelDO routing, filtered RAG, saga recovery, and workerd launcher remain in place. Cloudflare's local decoder flush hangs, so the Worker forwards bounded Ogg to Workers AI; local model spaces fail closed instead of cloud-falling-back. Meta/Twilio WhatsApp voice notes now require an authorized paired sender or valid per-space webhook, fetch audio using vaulted credentials, enforce provider URL/path, MIME and streamed 8 MiB limits, then transcribe. Local-model spaces receive an explicit unsupported response. Meta's official media docs confirm media-ID lookup, bearer-authenticated download and supported audio types; Cloudflare Whisper docs returned proxy 403, so transcription output remains mocked. Agent suite: 58 files / 232 tests; Spaces: 23 files / 67 tests; Agents and Shell typechecks pass. Direct Docker `/health` and `/exec` pass on all three images; a signed local request reached real ToolSandboxDO and settled its local budget, but Wrangler then failed Container readiness with `Network connection lost`. Saga external provider effects, voice-model output, cloud tunnel execution and live media acceptance remain unproven. No live Cloudflare deployment or vendor call was made. See CLOUD-PROGRESS.md for exact gates.

5. **Document 12: lines 7974–10197**

```text
Implement Naelao reading batch 5 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md.

Primary: new plan/New Text Document (12).txt, lines [7974–10197].
Look ahead in Document 12: [11523–11706, 12764–13344].
Look ahead in new plan/New Text Document (13).txt: [964–1111, 1324–1374].

Determine the final behavior after later model, perception, runtime and fallback
corrections. Check current official capabilities and costs before relying on
named services or performance figures. Implement the primary range's final
requirements, test successful and failure paths, update coverage and stop here.
```

**Progress (2026-10-12): PARTIAL_NEEDS_PLATFORM — local implementation complete; continuing with Batch 6.** Read D12 7974–10197 in ascending bounded windows, required look-aheads D12 11523–11706 and 12764–13344, and D13 964–1111 and 1324–1374. Searched unread tails for Clef/Jev/System 1/runtime corrections and read matching contexts D12 13340–13447 and D13 724–727, 761–762, 1387–1394. Cloudflare's current official Workers AI catalog and Clef model pages confirm `@cf/cloudflare/clef-flash` (24,576 context, $0.038/M input), `clef` (65,536, $0.24/M), and `clef-omni` (64,000, $0.15/M); typed `state`/`questions` decisions and audio/video input are documented. Jev endpoint compatibility and all latency figures were not verified. Added an opt-in Clef provider to the shared decision client, bundled container/browser preflight, and a high-confidence, off-path project container warm that respects air-gap, role, project, and tier gates; existing ToolSandboxDO 60-second idle alarm remains the false-positive bound. Browser-reflex action selection and bounded AXTree observations were already implemented. No live Workers AI call or deployment was made; actual model output and speculative DO-to-Container warm timing remain unproven. Agent SDK: 9 fast-decision tests pass and typecheck passes; Agents: 58 files / 232 tests pass and typecheck passes. Continue with Batch 6; detailed coverage is in CLOUD-PROGRESS.md.

6. **Document 12: lines 10198–11776**

```text
Implement Naelao reading batch 6 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md and revalidate affected existing behavior.

Primary: new plan/New Text Document (12).txt, lines [10198–11776].
Look ahead in Document 12: [11777–12347, 12348–12763, 12764–13344].
Look ahead in new plan/New Text Document (13).txt: [1–236, 735–1398].

Read the later constraints before deciding how to implement this range's
evaluation, project/template, worker, ingress and cross-cutting requirements.
Build real integrated behavior rather than just prose, mocks or a flat tool
router. Implement, test, record fresh evidence and any remaining live gates,
and stop after this batch.
```

7. **Document 12: lines 11777–12763**

```text
Implement Naelao reading batch 7 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md.

Primary: new plan/New Text Document (12).txt, lines [11777–12763].
Look ahead in Document 12: [12764–13344].
Look ahead in new plan/New Text Document (13).txt: [108–178, 1147–1189,
1324–1374].

Reconcile channel/presence, extension/container and named-machine tunnel
requirements with later policy and runtime corrections. Independently inspect
the tunnel code already present; its existence is not proof it works. Design
and complete the final requirements, exercise authentication, permissions,
disconnect/restart/replay and safe cancellation, record results and stop here.
```

8. **Document 12: lines 12764–13666**

```text
Implement Naelao reading batch 8 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md.

Primary: new plan/New Text Document (12).txt, lines [12764–13666].
Look ahead in new plan/New Text Document (13).txt: [735–1398].

Resolve this final Document 12 section against current official vendor
documentation and Document 13 amendments. Implement and test its final model,
BYOK/fallback, preview and developer-tooling requirements. Reconcile conflicting
earlier implementations without silently removing private-machine/local-model
support. Record evidence, outstanding dependencies and coverage. Stop here;
the next batch begins Document 13.
```

9. **Document 13: lines 1–734**

```text
Implement Naelao reading batch 9 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md.

Primary: new plan/New Text Document (13).txt, lines [1–734].
Look ahead in the same Document 13: [735–1398].
Context from new plan/New Text Document (12).txt: [6501–6560,
11707–11776, 12213–12347].

Document 13 follows Document 12 and may amend it. Separate reference-product
comparisons from requirements and avoid promising entire external platforms
can be cloned as templates. Design, implement and test the actual foundry,
connector ownership/pinning and integration requirements. Verify existing
behavior yourself, update coverage and stop after this batch.
```

10. **Document 13: lines 735–1398, then full coverage reconciliation**

```text
Implement Naelao reading batch 10 of 10. Follow the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md.

Primary: new plan/New Text Document (13).txt, lines [735–1398].
Use CLOUD-PROGRESS.md to locate affected earlier source ranges; reread those
specific ranges only when needed to reconcile or prove their final behavior.

Treat this final section as later runtime corrections, not a vendor guarantee.
Research current official limits and APIs, choose compatible designs, implement
and test the final requirements, and repair any earlier code that conflicts.
Then audit substantive coverage of Document 12 [1–13666] and Document 13
[1–1398]. Close missing requirements across all 10 batches, run relevant full
integration/regression checks, and clearly separate proven results from blocked
live checks. Do not claim completion merely because all ranges were read or
code was written. Record an honest final coverage/verification report.
```

## Continue an interrupted batch

```text
Continue the current Naelao cloud reading batch. Read the shared rules in
new plan/CODEX-CLOUD-PROMPTS.md and the latest CLOUD-PROGRESS.md entry.
Resume its exact unfinished action, verify repository state independently,
and keep working on that batch's implementation and checks. Do not start a
later numbered batch or treat an unverified checkpoint as completion.
```

## Frozen source identity and coverage

- Document 12: 1,030,011 bytes; SHA-256
  `C84907A0455FF69283C91080EFA7C0380F2A68DBB81F8A9B0280B1527584177E`.
- Document 13: 95,671 bytes of original requirements, through line 1398; SHA-256
  `06BF9FA2A42076952F8BA1851BBD2FD77C27874CF47E8D89B21EDD6146856F69`.
  Old appended continuation prompts are excluded.
- Primary Document 12 coverage is contiguous:
  [1–1564], [1565–3590], [3591–5657], [5658–7973], [7974–10197],
  [10198–11776], [11777–12763], [12764–13666].
- Primary Document 13 coverage is contiguous: [1–734], [735–1398].
  Blank lines, summaries and repeated examples are included; duplicates are reconciled.
- The original TXT files contain no added Luna contracts, completion checkpoints or
  cloud prompts. Keep progress and decisions separate so source line numbers remain stable.
- This handoff includes unverified implementation changes. Assess every batch from
  source and running code; do not inherit any local step's claimed completion.
