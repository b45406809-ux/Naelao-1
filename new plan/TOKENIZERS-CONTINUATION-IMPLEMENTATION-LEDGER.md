# Tokenizers continuation implementation ledger

Authority: `Tokenizers vs. Embedding Models Explained.continuation.messages.txt`. Follow `FOUNDRY-SPACE-PLATFORM-CONTINUATION-PLAN.md` in pair order and its bounded windows. Historical statuses do not count as fresh review. A look-ahead does not complete a pair. Record implementation and verification per message; do not mark the AI model reply as product authority without validation.

Fresh audit began: 2026-10-15. Current next pair: Task 05 (Messages 9–10). Task 03 remains partially implemented; its remaining product actions are stated in its row and message notes.

| Pair | User message | AI message | Audit status | Current finding / evidence |
|---:|---:|---:|---|---|
| 01 | 1 | 4 | ASSESSED — no product change required | User asked about Google's code-execution behavior; the model's internal architecture, timing and price claims are unverified. Naelao already separates bounded Python/Wasm from native containers. See fresh runtime test result below. Source range: 1–55. |
| 02 | 56 | 59 | ASSESSED — shared canonical workspace already implemented | Containers do not directly mount SQLite/FUSE. Each execution hydrates a scoped workspace snapshot from R2 and publishes changes through a journaled, fenced per-file compare-and-swap flow; stale/conflicting snapshots fail closed. Restart, specialized-execution handoff, deletion, binary data, scope isolation and publication conflict/recovery have focused tests. Source range: 56–210. |
| 03 | 211 | 214 | PARTIAL — dynamic deployment-approved runtime cards and assistant workspace scope implemented | Custom digest-pinned `TOOL_SANDBOX` marketplace cards now resolve from deployment config and get the same no-internet 60-second host boundary. Install scopes now include project workspace, Space Assistant workspace, and isolated Space-extension workspace. Local dynamic startup is typechecked/mocked; Cloudflare live image startup is not validated. FDE self-service publication/review, template runtime references, duplicate-cost prompts and assistant install UI acceptance remain open. Source range: 211–338. |
| 04 | 339 | 344 | ASSESSED — timekeeper enforcement and cross-project promotion confirmed | Container execution has a hard 60-second maximum and now returns actionable Durable Workflow guidance on deadline. Durable workflow effects permit explicitly declared `code.execute_bash` for a bounded, normally authorized container step; raw `Bash` and dynamic JS are denied. Foundry asks before replacing project installs with `SPACE_SHARED`; that uses a dedicated Space-extension workspace, not the Space Assistant workspace. Focused tests passed; no free-idle or fixed-savings claim adopted. Source range: 339–450. |
| 05 | 451 | 454 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 451–574. |
| 06 | 575 | 578 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 575–693. |
| 07 | 694 | 697 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 694–749. |
| 08 | 750 | 753 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 750–841. |
| 09 | 842 | 845 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 842–1088. |
| 10 | 1089 | 1092 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 1089–1225. |
| 11 | 1226 | 1229 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 1226–1416. |
| 12 | 1417 | 1420 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 1417–1575. |
| 13 | 1576 | 1579 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 1576–1754. |
| 14 | 1755 | 1758 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 1755–1970. |
| 15 | 1971 | 1974 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 1971–2173. |
| 16 | 2174 | 2177 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 2174–2355. |
| 17 | 2356 | 2359 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 2356–2591. |
| 18 | 2592 | 2595 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 2592–2772. |
| 19 | 2773 | 2776 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 2773–2977. |
| 20 | 2978 | 2981 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 2978–3067. |
| 21 | 3068 | 3071 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 3068–3284. |
| 22 | 3285 | 3288 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 3285–3513. |
| 23 | 3514 | 3517 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 3514–3753. |
| 24 | 3754 | 3757 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 3754–3942. |
| 25 | 3943 | 3946 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 3943–4139. |
| 26 | 4140 | 4143 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 4140–4268. |
| 27 | 4269 | 4272 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 4269–4441. |
| 28 | 4442 | 4445 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 4442–4647. |
| 29 | 4648 | 4651 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 4648–4794. |
| 30 | 4795 | 4798 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 4795–4982. |
| 31 | 4983 | 4986 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 4983–5145. |
| 32 | 5146 | 5149 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 5146–5259. |
| 33 | 5260 | 5263 | UNASSESSED | Bounded primary and amendments pending fresh audit. Source range: 5260–5333. |

## Message-level log

Each pair row above owns its user message and following AI model message. Add a short entry below for each of the two messages when the pair is reviewed; keep corrections attributed to their later user message and record implementation/test evidence at the pair row. Do not alter the transcript.

### Message 01 — Task 01 user, lines 1–3
Status: ASSESSED — question only; no additional Naelao feature requested.

### Message 02 — Task 01 AI model, lines 4–55
Status: ASSESSED — vendor-internal claims are not adopted as product authority. Repository reality is a separate Python/Wasm isolate and a separate native container execution path; Tier 2 is not a promise of sub-10ms latency or zero cost. Verified existing code and tests: `execution-ladder.ts`, `dynamic-code.ts`, `isolated-runtime.ts`, `code-exec-python.test.ts`, `execution-ladder.test.ts`. Focused tests passed: 2 files / 21 tests. Look-ahead context consulted: 56–210, 211–338 (early read only; Task 03 remains unassessed), 339–450 (early read only; Task 04 remains unassessed), 451–574, 575–693, 694–749, 1755–1970, 2174–2355, 2592–2772, 3943–4139, 4442–4647, 4648–4794, 4795–4982. Additional later-subsystem search covered `Google AI Studio`, `code execution`, `Pyodide`, `Tier 2`, `Tier 6`, `container marketplace`, and `shared filesystem`. These look-aheads do not complete those tasks. Next pair: Task 02 / messages 3–4 (lines 56–210).

### Message 03 — Task 02 user, lines 56–58
Status: ASSESSED — proposes multiple specialized execution containers sharing one project workspace. No full Ubuntu or shared POSIX filesystem requirement is adopted from the reply; the product requirement is shared canonical project files across authorized execution tiers.

### Message 04 — Task 02 AI model, lines 59–210
Status: ASSESSED — claims of FUSE/SQLite projection, mathematical impossibility of corruption, sub-300ms startup, zero idle cost, distroless image sizes and a universal shell router are unverified or contradicted by current code. Naelao's implemented shared-workspace contract uses R2 as canonical bytes and a per-execution container snapshot; changes publish through a journal, per-file lock/fencing token and expected-hash CAS. This is safe shared project state without a live mounted filesystem. Inspected `ToolSandboxDO.ts` hydration/publication/replay and `specialized-workspaces.test.ts`; focused tests passed: 2 files / 14 tests. Coverage includes specialized write→general reader handoff, binary update, delete, warm-runtime refresh, restart, private project isolation, deployed digest rejection, authenticated scope derivation, concurrent writer conflict, and pending-publication recovery. Task 02 look-ahead amendments/search contexts: lines 737–738 (later FUSE isolation claim), 4442–4483 and 4639–4647 (later Cloudflare Artifacts/FUSE claims); transcript-wide search for shared-filesystem/sidecar/container workspace references also found 212–338, 234, 252, 329, 4450, 4473, 4546 and 4643. These are only look-ahead, not completed later tasks. No additional Task 02 code change was needed. Next pair: Task 03 / messages 5–6 (lines 211–338), specifically the marketplace/additional-container and workspace-scope correction.

### Message 05 — Task 03 user, lines 211–213
Status: PARTIALLY IMPLEMENTED — runtime discovery is metadata-only and never installs from a command failure. Marketplace runtime cards can be deployed from reviewed digest pins, and the owner can choose project, Space Assistant, or dedicated Space-extension workspace. The request also asks FDE-authored cards, template preconfiguration, duplicate runtime handling, and a missing-runtime approval path; self-service publication/review and template runtime references remain unimplemented.

### Message 06 — Task 03 AI model, lines 214–338
Status: PARTIALLY IMPLEMENTED — speculative 200ms/$0/container image-size claims, gVisor, SQLite/FUSE, secret proxy, arbitrary runtime publishing and cross-project live-instance deduplication were not adopted. Fresh changes: deployment registry accepts bounded marketplace metadata for `TOOL_SANDBOX` immutable digest cards; no caller/model can register an image. Install scopes distinguish `SPACE_ASSISTANT` (assistant workspace), `PROJECT_SHARED` (project workspace), and `SPACE_SHARED` (dedicated isolated Space-extension workspace); migration v79 preserves prior grants. The installed Cloudflare Container type declaration accepts dynamic `start({image, enableInternet})`; documentation requests returned HTTP 403, so native provider behavior remains unverified and live acceptance is not claimed. Task 03 focused tests: Agents 3 files / 20 tests, Spaces install/migration 2 files / 7 tests; Agent, Spaces, and Shell typechecks passed; Agents Wrangler dry-run built all three configured container images/bindings. Tests use mocked container transport; no Cloudflare deployment/image start occurred.

Task 03 later corrections consulted: lines 339–450 (explicit 60s cap, project→Space promotion, isolated Space workspace, no guaranteed savings); lines 451–574 (the proposed immutable registry proxy is superseded by the user's later trusted-source preference); lines 575–693 (FDE template-extension model); and lines 694–749 (trusted-source preference, bounded execution and workspace isolation). Full transcript search for container/runtime/workspace terms found later contexts at 737, 1755–1970, 2174–2355, 2592–2772, 3943–4139, and 4442–4794; those later tasks remain unaudited until their chronological turn. Additional residual requirements: no FDE self-service submission/review route; no `containerRuntimeIds` field in Foundry template definitions; no assistant-vs-Space-wide duplicate-cost recommendation UI; no proof that shared digests reduce provider storage or boot costs. Exact next pair: Task 04 / messages 7–8, lines 339–450.

### Message 07 — Task 04 user, lines 339–343
Status: ASSESSED — asks to prompt before installing the same credit-consuming extension in another project, promote/share it at Space scope when chosen, and enforce a maximum container runtime with FDE guidance about separating schedules from bounded worker execution.

### Message 08 — Task 04 AI model, lines 344–450
Status: ASSESSED — current Space runtime installer detects duplicate project grants, requests explicit owner confirmation before promotion, deactivates project grants atomically, and documents that files are not migrated and savings are not guaranteed. `SPACE_SHARED` runs use a dedicated Space-extension workspace separate from assistant files. Container scope validation and runner clamp timeouts to at most 60 seconds; ToolSandbox kills on deadline. Added an actionable `container_execution_time_limit_exceeded` response and `docs/timekeeper-pattern.md`. Durable workflow effects allow a declared `code.execute_bash` call for bounded container work; `Bash` alias and `code.run_js` are blocked as workflow capabilities. Verified through workflow-hook and ToolSandbox timeout tests. Model claims about free waiting, exact savings, shared queues, Docker/gVisor, and the proposed `defineDaemon` macro are not adopted. Look-ahead matches read: lines 451–749, 2286–2355, 3135–3225, 3943–3965, 4074–4095, and 4795–4825. These remain future pairs. Task 04 status: complete for the user-requested guardrails; no live platform cost measurement or workflow deployment was made. Next pair: Task 05 / messages 9–10, lines 451–574.
