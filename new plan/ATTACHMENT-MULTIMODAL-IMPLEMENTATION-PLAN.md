# Attachment and multimodal implementation plan

Date: 2026-10-15  
Branch: `Mcbt5s-Backup-2`  
Status: implementation in progress. The email-backed opaque-ID CLI slice is implemented and locally tested; other channel adapters, scanned-PDF rendering, generic modality contracts, and provider-run adapter evaluation remain unfinished.

## Architecture decision

Treat incoming files and media from every supported channel as scoped attachments available through the agent's virtual CLI, rather than automatically OCRing or copying their bytes into the planner prompt. Normalize channel-specific attachments to an opaque attachment ID, safe filename, declared and detected media type, byte size, source message ID, and authorization scope. Keep the bytes in the existing protected object store. Agents see a small attachment index and relevant user text; the system-one router may recommend a skill/tool from those facts, while the planner or worker decides whether to invoke it.

The router must not open an attachment merely to classify it. “Save this image to the project” needs only a scoped file-copy tool; “read the serial number in this image” needs image understanding; “summarize the attached PDF” needs document extraction. If intent is unclear, the planner asks or chooses a bounded inspection tool. Model outputs and extracted text remain untrusted data, never instructions with authority.

Expose attachment actions as virtual CLI tools so planner/worker behavior stays consistent with other commands, for example `attachment list`, `attachment inspect <id>`, `attachment read <id>`, and format-specific commands such as `attachment pdf-text`, `attachment ocr`, or `attachment transcribe`. Exact command names are to be finalized against existing CLI parser conventions. A tool receives an opaque ID, never an arbitrary R2 key or URL; the host rechecks tenant, Space, task/thread, actor, expiry, placement, and egress policy before reading bytes or calling a model.

Use progressive skill disclosure: a short attachment-skill index is available to the right planner/worker role; `skill read <id> --toc`, `--section`, or bounded `--lines` loads only the instructions needed. FDE-installed extension skills execute in their own project or Space extension workspace according to installation scope, never in the shared Space Assistant workspace. Skill text teaches tool use; it does not grant authority or bypass the host CLI's checks.

## Work plan

### A. Shared attachment envelope and tool authorization

1. Inventory inbound media for email, WhatsApp, Telegram, Slack, Discord, web/chat uploads, and existing task attachments. Record each channel's ownership token and safe download mechanism; reject channels whose API cannot be safely fetched with the configured scope.
2. Add a common attachment record and channel adapters that store provider bytes under random tenant/Space-scoped object keys. Persist only opaque IDs and safe metadata in message/task context. Verify signatures before fetching provider media; cap per-file and aggregate bytes; deny redirects or validate signed media hosts; set expiries and cleanup.
3. Implement virtual CLI discovery and operations over the authenticated attachment IDs. Every read rechecks scope and policy. Cross-tenant IDs, expired records, unknown MIME types, provider-fetch errors, and air-gap/egress denials fail closed.
4. Keep the agent context concise: message text, attachment names/types/sizes, and available skill/tool summaries. Do not send raw file bytes to System 1 or the planner unless a user-requested tool operation requires it.

Acceptance: channel-adapter contract tests; webhook-signature-before-download tests; authorization/expiry/replay/isolation tests; adversarial MIME/path/redirect tests; cleanup/restart replay tests; prompt-shape tests showing metadata-only context until a tool is invoked.

### B. Intent-aware skill and tool selection

1. Extend the System 1 routing result with advisory attachment relevance and tool/skill candidates based on the message text, declared/detected MIME, and verified selected-model capability evidence. It may return `not_needed`, `candidate_tool`, or `uncertain`; it must not read the file, make an irreversible choice, or authorize a tool.
2. Keep the planner's own choice authoritative within its already authorized tool surface. For an unambiguous file-storage request, route directly to storage/copy without OCR. For content-dependent requests, make the relevant reader/transcriber available and let the planner select it. Ask a concise question when the task cannot be safely inferred.
3. Use existing role-scoped skills and CLI `skill read` operations. Add supported PDF, image/OCR, audio, and video skill manuals only when the corresponding host tool is actually deployed. Avoid always injecting full manuals or extracted document contents.
4. Distinguish image OCR from visual understanding. OCR extracts text; it does not identify objects, explain charts, or validate visual condition. Prefer a currently verified selected model's native image input when suitable and authorized; otherwise use an explicitly available image tool and state its limits.

Acceptance: paired intent tests (`save file` vs `read file`), ambiguous intent, prompt-injection in file contents, unsupported modality, role targeting, and proof the router never accesses attachment bytes.

### C. Bounded PDF text and scanned-page OCR

1. Preserve the existing bounded text extraction for small text PDFs. Add tests distinguishing text-bearing, image-only/scanned, encrypted, malformed, and oversized documents.
2. Verify a renderer suitable for the actual Cloudflare Worker/Container target, not just Node. Candidate route: use the dedicated Document Sandbox (not the Agents request isolate) with a fixed no-network renderer image. Pin the renderer binary/image digest and deployment binding. Add a narrow host operation that stages one authorized PDF, renders a bounded page range at a fixed maximum resolution, returns bounded PNG bytes, and deletes scratch files on success/failure.
3. Enforce file/page/pixel/aggregate-byte limits before OCR; cap CPU/runtime, memory through the fixed sandbox profile, output size, and OCR token/usage admission. Disable external links, scripting, embedded actions, and network. Cleanly reject encrypted PDFs and unsupported features. Test restart/failure cleanup and malicious decompression/input cases.
4. Only then connect rendered pages to the existing OCR provider operation, with Space owner enablement, model/evidence/entitlement checks, spend limits, untrusted output labeling, retention policy, and no forbidden cloud fallback. If no renderer meets the bounds or is deployable, retain a truthful `scanned_pdf_ocr_unavailable` result.

Acceptance: synthetic scanned/text PDFs; page-limit and pixel-bomb cases; invalid/encrypted files; CPU/timeout and output-limit failures; container restart/cleanup; Workers runtime test plus container image build/dry-run. A local container test is not live deployment acceptance.

### D. Generic modality contract and dispatch

1. Replace the notion of one universal provider request with a normalized Naelao task contract: modality and task (`transcribe`, `translate`, `describe_image`, `extract_document`, `summarize_video`, `speech_to_speech`), bounded input references, expected output type, language hints/constraints, and cancellation/timeout limits.
2. Implement explicit provider adapters that map only verified capabilities to each provider's request format. Keep model inventory candidate data separate from key-specific entitlement and deployment status. Validate exact selected key, model, capability, and price before paid requests. Unknown or stale evidence means unsupported.
3. Route simple media work as worker tools when it does not require shared planner context. For realtime conversation, route only to a verified duplex adapter; do not insert batch translation into a live call and call it realtime. Maintain thread/session and transcript parity for UI-driven planner interactions.
4. Preserve private-machine/local model routes. Placement, residency, and egress policies are evaluated before provider selection; when cloud is forbidden there is no cloud fallback. If no authorized adapter supports the task, ask for another input or return a clear unavailable result rather than guessing/transcribing with a mismatched model.
5. For multilingual/code-switched input, pass raw text through when the planner can handle it. Offer glossary/dialect resolution or verified translation as tools when needed. A model's confidence is not proof of language coverage; uncertainty must be represented and the system must abstain rather than fabricate.

Acceptance: provider-adapter contract tests per capability; stale/unsupported/model-entitlement denial; exact key/Space isolation; cost-cap failures; language/uncertainty and code-switch cases; local/private success; forbidden-cloud fallback denial; cancellation and transcript/session replay tests.

### E. Adapter evaluation and provider execution

1. Keep current adapter manifests, consent/provenance, encrypted test sets, owner-attested scores, approval/rollback/revocation, and disabled training behavior intact.
2. Before platform-run evaluation, identify a provider/runtime with an official documented inference operation that accepts the exact imported adapter and base-model format. Verify the request, response, resource limits, data handling, and account entitlement. A manifest string or successful base-model request is not proof that an adapter loads.
3. Add a provider-neutral evaluation runner interface with explicit provider adapters. The runner sends only the versioned, consented test cases, one bounded case/batch at a time, records provider/model/adapter versions and output hashes, calculates deterministic task metrics locally, and keeps generated outputs encrypted and Space-scoped. Never let an untrusted adapter or test fixture execute code or call arbitrary network.
4. Add owner confirmation before paid provider evaluation; reserve known costs when the provider exposes reliable pricing/usage data. If the provider cannot expose a safe cost bound or adapter contract, retain manual attestation and mark platform evaluation unavailable. Do not enable training based on evaluation support alone.

Acceptance: provider mock contract tests clearly labeled mocked; scope/consent, adapter/base-model mismatch, partial provider failure, result integrity, deterministic metric, threshold, budget-denial, rollback/replay, and deletion tests. Live adapter compatibility requires an operator-owned provider account and actual adapter.

### F. Live acceptance and rollout

After local implementation gates pass, use configured credentials and deployment authority to apply migrations, verify fixed container digest/bindings, test one controlled attachment per channel, run bounded OCR and each selected modality, check usage and cleanup, verify private/local policy denials, and record deploy/rollback results. Keep secrets in environment settings/vault, never in Git or chat. Until those checks run, report live acceptance as `UNRUN`; if credentials or authority are missing, finish all independent local work first and list only the precise remaining operator action.

## Completion labels

- `implemented and locally verified`: code and meaningful local/integration tests pass.
- `live verified`: tested against the named deployed provider/account and recorded with timestamp and cleanup.
- `blocked`: no verified runtime/provider contract or required authorization exists; explain the exact condition and safe behavior.
- `unrun`: test is possible but was not performed.

No vendor names, prices, latency, free-tier assertions, or region coverage are hardcoded from examples. A FDE may provide an adapter for a regional provider under the same capability and security contract; country/provider availability remains data configured and verified for that installation.

## Source context read for this plan

- `Tokenizers vs. Embedding Models Explained.continuation.messages.txt`: lines 3068–3284 (skill role filtering), 3285–3513 (progressive skill CLI), 3514–3753 (multilingual routing concerns), 3754–3942 (dialect resolver as a planner tool), 4140–4268 (LoRA language claims, not provider proof), 4269–4441 (Gateway/provider claims rejected unless verified), and 4983–5145 (email attachment ingress proposal).
- Additional subsystem search across the remaining transcript found OCR/PDF/tool mentions at lines 239–269, 411–440, 1060–1080, 1310–1460, 1860–1900, 2592–2772, 4480–4550, and 5010–5250. Pasted PDF/OCR/LoRA/Gateway implementation snippets are proposals, not proof of runtime or vendor support.
- Repository evidence: existing `email.attachment.read_text` and `email.attachment.ocr_image` operations are limited to task-owned email attachments; channel adapters currently normalize text; the Agents Worker has a dedicated DocumentSandboxDO and a fixed Documents Container image with LibreOffice, but no verified PDF raster binary or attachment-media CLI. `unpdf` currently extracts PDF text only. These findings inform the sequence above.
