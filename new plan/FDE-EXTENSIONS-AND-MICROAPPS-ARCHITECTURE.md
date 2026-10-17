# FDE extension, worker, and MicroApp architecture

Updated: 2026-10-17
Branch: `Mcbt5s-Backup-2`

## Decision in one sentence

An **extension is a versioned package of composable capabilities**, not one execution mode. Workers, execution tiers, MicroApps, internal tools, workflows, and external channel handlers describe different axes of that package and may be combined where their principals and grants allow it.

This is the recommended product model for the mentor-to-student WhatsApp bot in the user's latest request. It reconciles the later correction that public customer behavior is custom extension behavior with the existing Foundry extension, workflow, Gadget, Canvas, execution-tier, project Knowledge, and channel systems. This document is an architecture/gap checkpoint; it does not claim that the proposed end-to-end onboarding already exists.

## The vocabulary FDEs should see

| Term | Meaning | Example | It does not mean |
|---|---|---|---|
| **Project template** | Install recipe: creates/configures a project and composes packages, data sources, workflows, UI and integrations. | “Trading mentor” creates one mentor project. | A special worker runtime or a promise that every integration is connected. |
| **Extension package** | Versioned product unit that can contain one or more installable primitives and declares needs. | `mentor-student-assistant` contains a Canvas, Gadget, channel handler and workflow. | A synonym for an external bot. |
| **Worker / sub-agent** | An invocation identity used by the planner to perform a bounded task. It has a role, skills, tools and delegation policy. It can invoke installed capabilities. | A knowledge worker searches approved course material for a student's question. | An installable UI, a database, or an execution tier. |
| **Execution tier** | Host-selected runtime/capability ceiling for one operation. | Tier 2 isolate for a message handler; Tier 3 for durable waits; Tier 6 container for approved native code. | A user-facing app type or authority grant. Higher tier never implies broader data access. |
| **MicroApp** | Installed user-facing Canvas plus its explicitly scoped Gadget data facet and UI actions. | Mentor admin screen for publishing documents, channel status and conversation review. | A private copy of the project's knowledge base or an autonomous planner. |
| **Internal tool/command** | A named, member-authorized operation exposed to an internal planner/worker. It is capability checked by the host. | `knowledge.publish`, `schedule.lesson`, or a project-specific reconciliation command. | A public webhook handler. |
| **Workflow/daemon** | Durable, scheduled, or event-driven orchestration using declared host operations. | Reindex a published file; expire old student conversation state. | Permission to call the planner or inherit the initiating member's grants. |
| **Connector/channel binding** | Host-owned provider account, OAuth/token lifecycle, webhook verification, and send/receive transport. | A mentor connects a Meta WhatsApp Business account. | Extension-owned provider credentials or raw webhook access. |
| **External channel handler** | A restricted package entrypoint invoked for a public event after host verification. Its principal is the external conversation, not a Space member. | Answer a student's WhatsApp question using a published course collection. | An internal planner, project member, or permission to use arbitrary project tools. |

FDE authoring should start from the business outcome and generate a package composition. It should not ask “is this a worker, microapp, tool, or extension?” as if the choices exclude one another. The author declares the primitives, connections, data products, and principals; the host computes and displays the effective grant and runtime ceiling.

## Actual repository model and the mismatches found

- Execution tiers are defined in `workers/agents/src/script-engine/execution-ladder.ts`: Tier 1 virtual POSIX/R2, Tier 2 isolate, Tier 3 Durable Workflow, Tier 4 Kitesurf, Tier 5 Chromium, Tier 6 container. They route an operation and do not describe who may access its data.
- The typed extension primitive union in `packages/agent-sdk/src/extensions.ts` has Gadget, Canvas, channel, container, linter, and workflow primitives. A separate compatibility `ExtensionManifest` still uses `gadgets`, `daemons`, `commands`, `channels`, and `containers`; it accepts a validated versioned `bundle`, persists it at installation, and derives the runtime `channels` declaration from its channel primitives. The owner/admin project bundle installer now compiles and installs project Canvas HTML, project-bound Gadget schemas, external channel handlers, and Durable Workflow entrypoints in one release. It derives capabilities from the present primitives, validates exact artifact-to-manifest matching, and rejects unsupported roles/parts. Worker roles explicitly declare their principal separately from invocation and execution placement; the current workflow installer accepts only `project_member` roles. `channel_only` handlers remain external and never inherit workflow/member grants. The Shell lists installed Canvas parts and lets members select one by a stable URL resource ID. Other execution placements (container, browser, Kitesurf, arbitrary Python) remain unsupported by this bundle route; this is a scoped v1 composition slice rather than an all-tier runtime installer.
- Before the current SDK follow-up, `packages/sdk/src/channel.ts` called an object with `receive()` and `send()` a developer `ChannelAdapter`, suggesting extension-owned provider transport. The API now treats `ChannelAdapter` as the declarative host connection/handler contract and exposes the restricted `ChannelHandlerModule.run(args, ctx)` context. The actual provider transport and signature verification remain in the Agents host (`workers/agents/src/launchpad/channels.ts`). The SDK mismatch is corrected, but a bundle compiler/build installer that ties `handlerScript` to a signed package artifact is still absent.
- The current channel contract requires a provider, script path, channel-only context, and event names. It also accepts exact `knowledgeCollections` IDs, and bundle validation requires each ID to exist in the package's `owner_published_external` declarations. Bundles can declare provider-matched host connections, Canvas/Gadget parts and workflow worker roles. The connection is presently descriptive/readiness-linked to the existing Space provider channel; it is not a per-installation OAuth credential reference.
- The restricted `ctx.channel` exposes provider, normalized text event, opaque conversation ID, `reply()`, and a host-bounded `answer({question})` request. An installation may opt into `session.get()` / `session.set(value)` with a declared size and TTL within host maxima; state is persisted only after confirmed delivery. Owners/admins can see per-installation active counts, bytes, and earliest expiry, then clear that installation's saved state without seeing conversation IDs or values. The host retrieves only the installation's explicitly bound, owner-published collection IDs and sends up to three bounded excerpts to a text-only answer path. It intentionally exposes no project ID, general Knowledge API, Gadget SQL, tools, planner, connector secret, or network. The answer path cannot select a model/provider, fails closed without sources or spend admission, and is not the project planner.
- `MicroAppDO` scopes Durable Object actor storage to Space/Project/member identities and still has no public-channel-contact principal. The restricted channel handler has a separate host-managed JSON state store keyed by project + installation + opaque conversation ID, with up to 4 KiB per conversation, a 90-day maximum TTL, 10,000 active sessions and 16 MiB per project. It also supports up to 16 independently bounded named records per conversation. It does not create one Durable Object per student or expose Gadget SQL. This is a narrow conversation-state primitive, not general public MicroApp Gadget access.
- Project files/Knowledge, Canvas file management, and channel handler grants remain separate surfaces. A publication boundary is implemented locally: owners/admins can choose exact indexed project documents into named collections, and a service-only search filters to those document IDs, rechecks each result against the publication relation, and wraps retrieved text as untrusted. Channel bundles declare exact external collection IDs; the trusted dispatcher searches only those IDs and provides a bounded grounded-answer method. Planner upload and shared Canvas/planner publication flows are not integrated.
- Channel primitives may reference a same-provider `connectionId`; bundle validation checks that reference and provider match. Owner/admin installation listings return sanitized provider requirement metadata, and the project channel panel shows each required connection's purpose and whether its host channel link is enabled. Existing channel setup uses provider-specific pairing or BYO credentials, but the link and credentials are still Space/channel scoped. There is no OAuth callback/token refresh/revocation lifecycle keyed to an extension installation. Providers differ: some support OAuth/embedded signup; Telegram bot setup is not the same OAuth flow as Slack or Meta. The host must implement verified provider-specific flows rather than pretending one extension SDK popup can authorize all of them.
- External channel delivery supports bounded text and one reply per event, with human review on uncertain delivery. Owners/admins can page recent events by installation and pause automatic handling for one conversation; the UI directs the owner to their connected provider inbox to reply. It is not a provider-independent reply composer, assignment queue, general-purpose dynamic workflow, multi-message action, or voice contract.

## Mentor-to-student WhatsApp assistant: intended composition

### Installed project composition

```text
Trading Mentor project template
├── Mentor Console MicroApp
│   ├── Canvas: publish course material, configure assistant, inspect conversations
│   └── Gadget: mentor-owned settings and review queue (not the canonical file store)
├── Published Knowledge collection: "Student Library"
│   ├── only mentor-approved files/chunks are visible to the external handler
│   └── private notes, billing data, learner records, and unrelated project files stay excluded
├── WhatsApp connector binding
│   ├── owner/admin completes the host's provider-specific setup
│   └── credentials, signature verification, webhook registration and delivery stay in Naelao
├── Student channel handler
│   ├── principal: opaque external conversation; never a business-member identity
│   ├── grants: search the one approved collection, bounded reply, optional conversation state
│   └── runtime: Tier 2 isolate by default, with strict time/concurrency/spend limits
└── Optional durable workflow
    ├── invoked only by declared channel event or an authorized internal action
    └── retains the external principal/grant envelope; cannot escalate to planner authority
```

### Setup and normal operation

1. An FDE chooses **Trading Mentor** and installs the template into a project. The preview lists the primitives, data stores, provider connections, external data exposed, runtime tier, expected billing meters, and any optional feature. No connection or permission is silently enabled.
2. The project owner uses the Mentor Console or the normal project file surface to add documents. The same authenticated `knowledge.publish` operation can be requested from the internal planner. The files remain canonical project Knowledge objects; neither Canvas nor the channel extension creates a second file copy.
3. The owner explicitly publishes selected files into the **Student Library** collection. Publication is a separate action from upload. Collection-level policy supports unpublish, source status, indexing state, and audit history. The external handler cannot query unpublished files or the project filesystem.
4. The owner connects WhatsApp in the host's existing pairing/BYO setup flow. That setup is currently Space/channel scoped. The desired per-installation Meta Embedded Signup, requested-scope consent, callback validation, webhook registration, refresh/revocation and disconnect lifecycle is still open. In all current paths, the extension receives no raw provider token.
5. A student message arrives through the host provider adapter. The host verifies the signature, maps it to an active project channel binding, applies deduplication/rate/concurrency/spend controls, resolves only that installation's declarations and supplies an opaque external-subject/conversation ID.
6. The handler may call bounded `ctx.knowledge.search({ collection: "student-library", query })` only if the installed project binding grants that collection. It receives a small number of source-attributed excerpts marked untrusted. It may not read general project files, financial data, private learner records, or another project's Knowledge.
7. The handler composes one bounded reply, which the host moderates, sends, records, and deduplicates. Search failure, revoked access, stale installation, spending cap, or delivery uncertainty goes to a review inbox; it never falls through to the internal planner.
8. If conversation memory is enabled, a host session API stores bounded state under an opaque external subject in a project-sharded table with TTL and deletion controls. No raw SQL or cross-student row access is exposed. Memory is off by default and has a visible retention policy.
9. Mentor Console displays the channel's health, published knowledge sources, safe conversation inbox, spend/rate status, and review actions. Internal mentor/admin views and public student surfaces use different routes and authorization policies even when they ship in one package.

The Trading Mentor starter at [`packages/agent-sdk/examples/trading-mentor-channel/`](../packages/agent-sdk/examples/trading-mentor-channel/) now demonstrates one composed bundle: Canvas, project Gadget schema, external WhatsApp handler with published Knowledge and bounded sessions, and an internal Durable Workflow worker part. `workerRoles` binds the stable worker role to the workflow primitive and entry file. The owner/admin installer accepts all declared artifacts, compiles handler/workflow sources, stores immutable release objects, and pins a canonical artifact digest. The workflow runtime checks current membership, exact installation scope, host release attestation, the full R2 artifact set and operation authorization. The planner can inspect extension parts/worker bindings and delegate a clean-context workflow without changing planner topology. This remains a sample contract: the sample broker operation is deployment-provided, the Gadget is not written by it, and provider auth is still the existing shared host channel setup.

## Authority and data model

Treat these as separate axes in every package preview and install record:

1. **Principal:** platform member, project member, scheduled service, connector service, or external conversation. External identities never become `product_end_user`/business members by inference.
2. **Data grants:** named collections and actions, e.g. `knowledge.collection:student-library/search`; bounded channel reply; optional session read/write; no ambient project access.
3. **Runtime:** selected execution tier and placement. Tier escalation changes compute availability only after host policy approves it; it never adds data grants.
4. **Lifecycle:** package version, installation ID, provider connection ID, grants approved by, source digest, revoke/uninstall and migration state.
5. **Presentation:** internal Canvas, public dynamic page, or no UI. A public page cannot inherit owner/admin routes or Gadget methods.
6. **Composition:** workflows may connect declared operations, but the authorization envelope follows every event. No workflow or worker call converts an external subject into a member or invokes the general planner implicitly.

For public session state, prefer an opt-in host-owned API over one Durable Object per phone number. Use a scoped, indexed store or sharded project service keyed by a keyed hash of provider account + external subject; never use phone numbers as object names or logs. Enforce per-project row/byte limits, per-subject rate limits, TTL, retention preview/deletion, and tenant/project foreign keys. Only the host derives the key and injects the relevant bounded session record into that conversation's handler.

## SDK and authoring direction

The canonical SDK should describe declarative capabilities and typed handler functions, then the build tool bundles them into one versioned manifest/artifact. An FDE should be able to write the conceptual equivalent of:

```ts
export default defineExtension({
  id: "trading-mentor",
  ui: mentorConsole({ canvas: "./console.tsx", gadget: "mentor-settings" }),
  knowledge: [{ id: "student-library", source: "project-files", publication: "owner-approved" }],
  connections: [{ id: "student-whatsapp", provider: "whatsapp", required: true }],
  channels: [{ connection: "student-whatsapp", handler: "./answer-student.ts",
    grants: ["knowledge:student-library:search", "channel.reply"],
    session: { enabled: false, maxAgeDays: 30 } }],
  workflows: [{ id: "reindex-library", trigger: "knowledge.collection.updated", handler: "./reindex.ts" }],
});
```

This is illustrative target syntax, **not a supported API today**. Do not copy it into production templates until one canonical manifest, compiler, signer, installer, runtime and revoke path implement it. In particular, a channel SDK must not ask extension code to implement `receive()`/`send()` with provider tokens; it declares an intent and host invokes a handler.

FDE Studio should expose a typed visual surface with a code view beneath it:

- **Build the experience:** choose internal planner/worker tools, MicroApp Canvas, external channel handler, workflow, or a composition.
- **Select data:** choose project Knowledge collections and Gadget/session state, each with scope and retention.
- **Connect services:** choose provider-specific connector setup; show which admin account and external scopes are requested.
- **Review access:** render principals and resource/action grants in plain language and show explicit denials.
- **Choose runtime:** preview host-selected tier, placement, timeout, concurrency and spend. It is not an authorization picker.
- **Test as each principal:** mentor/admin, project member, public student, and revoked/disconnected state. Fixtures cannot use production credentials.
- **Publish:** owner review, immutable package/artifact hash, versioned migration plan, rollback and staged rollout.

## Optimization choices

- Keep project Knowledge canonical; do not copy mentor files into per-student Gadget SQLite or extension workspaces.
- Do not allocate one Durable Object/database per public contact by default. Store only opted-in minimal state in a bounded, sharded service.
- Keep channel ingress stateless except durable deduplication/session state; enqueue only when a longer workflow is needed. Reply inline for bounded, short handlers to avoid turning every FAQ into a multi-step planner workflow.
- Use existing project spend/wallet limits, per-channel overrides, execution ceilings, and moderation. Add a per-integration concurrency/rate budget and a per-external-subject abuse limit; do not assume provider rates or cloud costs from model-authored examples.
- Share one provider connection across compatible project handlers only through host-issued references with least privilege. Do not copy connector tokens into extension code, project files, Gadget state, or workflow payloads.
- Start with searchable text/PDF/DOCX content and one text reply. Add media, voice, multi-turn, and multi-message actions as separately declared capabilities with their own consent, retention, cost and runtime policy.

## Implementation sequence and done criteria

1. **Canonical terminology and SDK:** the bundle installer validates and stores the manifest and role bindings, checks matching extension identity, and compiles exact artifacts. Canvas/Gadget/channel/workflow parts can share one project installation; the Canvas selector uses an active installed resource ID in the URL. Workflow discovery returns bundle parts and role bindings to the existing planner tools. Still needed: publisher identity signatures, package migration/upgrade UX, other execution placements (containers/browser/Python/Kitesurf), a visual composition/permission preview, and end-to-end Gadget UI/worker operations. The host HMAC and full R2 digest currently establish host acceptance/integrity, not developer identity. No provider credentials enter guest code.
2. **Data products:** migration `0104_kb_external_publications.sql` and project-page UI support owner/admin publication of exact indexed project documents and unpublish. The internal search endpoint returns only filtered, source-attributed, untrusted chunks. The channel contract requires exact declared collection IDs; the trusted dispatcher retrieves from those collections, and `ctx.channel.answer({question})` requests a restricted generated answer. Still required: Canvas/planner publication integration and explicit end-to-end tests for immediate revocation, archive, and deletion behavior.
3. **Connector lifecycle:** bundle connections point at host-owned provider declarations; the owner/admin panel shows requirement purpose and whether the current host channel is connected. Still needed: per-installation connection references; one fully tested OAuth/embedded-signup provider; encrypted install-scoped token save; webhook registration; refresh/revoke/delete; reconnect and health. Keep providers without OAuth (such as Telegram bot setup) on their documented auth method.
4. **External conversation API:** bounded reply, source-grounded answer, opt-in per-conversation and named JSON sessions with TTL/quotas exist. Owners/admins can see aggregate retention and clear one installation's state; uninstall unbinds, clears state and removes only that installation. The inbox pages events by stable cursor and can pause automatic handling on one exact conversation. Still needed: provider-independent reply composition/assignment, per-conversation export/delete and end-to-end revocation/archive/deletion tests. No raw Gadget SQL, project IDs, member role or planner handles enter public handler context.
5. **Composition/onboarding:** the owner/admin bundle installer can install Canvas, Gadget, Knowledge-linked channel handler and workflow together in one reviewed release. Still needed: template-generated manifests/artifact plans, a visual owner approval/permission preview, actual authenticated OAuth/connection onboarding, and a complete end-to-end vertical slice. Show partial setup clearly and never imply a connection is complete when the provider has not authorized it.
6. **Vertical slice:** implement the mentor flow end to end with one provider, approved document ingestion, public query, session memory off/on, revocation, abuse cap, unpublish and human review. Then use the same pattern for other external extensions.

Done means an FDE can determine the principal, granted data, UI surface, orchestration, runtime and connection from the package preview; build a composed package without implementing provider transport; onboard a mentor without exposing private project files; and demonstrate that public users cannot reach a planner, member tool, private collection, another student's session, or revoked connection.

## Open decisions and dependencies

- Pick and verify the first provider for an extension-instance credential lifecycle. The likely WhatsApp path depends on whether this deployment supports Meta Embedded Signup or should reuse Twilio; Slack and Telegram have different OAuth/token and webhook rules. Keep current Space-scoped auth explicitly separate from future install-scoped auth.
- Define what project Knowledge API and file publication rules already exist for this purpose before adding a second storage system. Prefer extending the authoritative project-file/Knowledge host.
- Define per-external-subject retention defaults, deletion obligations, recording/consent, and the customer-visible disclosure for each provider and jurisdiction.
- Confirm whether the existing channel handler's captured one-reply contract is enough for the first vertical slice. Do not add tools/retrieval until the host can enforce collection/action grants.
- Live OAuth, provider delivery, account rate limits, and pricing remain provider/account checks; local tests cannot establish them.
