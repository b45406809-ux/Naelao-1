# Naelao — Full System File-Tree Map

> Complete, functional monorepo layout for the entire Naelao platform: every Cloudflare Worker, Durable Object, shared package, frontend app, container image, infrastructure definition, and test suite needed to build and run the system end to end.
>
> Conventions:
> - **Monorepo** managed with **pnpm workspaces + Turborepo**.
> - Every worker is a self-contained package with its own `wrangler.toml`, `src/`, `migrations/`, and `test/`.
> - Durable Objects live inside the worker that owns them (`src/do/`).
> - Shared logic lives in `packages/*` and is imported by workers and apps.
> - `infra/` provisions all Cloudflare resources as code (KV, R2, Queues, Vectorize, Analytics Engine, Pages).
> - Gap references (e.g. `G-AC11`) point to the appendix entry whose fix the file/folder implements.

```
naelao/
├── README.md
├── LICENSE
├── package.json                      # pnpm workspace root + scripts
├── pnpm-workspace.yaml               # packages/*, workers/*, apps/*
├── turbo.json                        # build/test/deploy task graph (dependency-ordered, G-AE34)
├── tsconfig.base.json                # shared strict TS config
├── .editorconfig
├── .gitignore
├── .nvmrc
├── biome.json | .eslintrc + .prettierrc   # lint/format
├── vitest.workspace.ts               # workspace-wide test config (@cloudflare/vitest-pool-workers)
├── .changeset/                       # versioning of shared packages
│
├── .github/
│   └── workflows/
│       ├── ci.yml                    # typecheck + lint + unit + integration (G-AE48)
│       ├── deploy-staging.yml        # dependency-ordered staging deploy (G-AE34)
│       ├── deploy-production.yml     # gradual rollout + health gates (G-AB10, G-AB46)
│       ├── secret-scan.yml           # gitleaks/trufflehog (G-Z39, G-AD23)
│       ├── api-diff.yml              # OpenAPI breaking-change gate (G-AD37)
│       ├── contract-diff.yml         # inter-worker Service Binding contract gate (G-AE40)
│       ├── bundle-size.yml           # per-worker bundle budget (G-AE37)
│       ├── tenant-isolation.yml      # cross-tenant leakage suite (G-AE49)
│       └── load-test.yml             # k6 SLO gate (G-AB14)
│
├── infra/                            # Infrastructure as Code (G-AE39)
│   ├── terraform/
│   │   ├── main.tf                   # cloudflare provider, account-level resources
│   │   ├── kv.tf                     # all KV namespaces
│   │   ├── r2.tf                     # all R2 buckets
│   │   ├── queues.tf                 # queues + DLQs
│   │   ├── vectorize.tf              # shared multi-tenant index (G-AB49, G-AC49)
│   │   ├── analytics_engine.tf       # datasets
│   │   ├── pages.tf                  # CF Pages projects (dashboard/portal/marketplace/admin)
│   │   ├── containers.tf             # container registry + image bindings
│   │   ├── access.tf                 # CF Access (admin routes)
│   │   ├── environments/{staging,production,dr}.tfvars
│   │   └── outputs.tf                # resource IDs → wrangler bindings
│   ├── wrangler.shared.toml          # shared binding fragments
│   ├── secrets/
│   │   ├── doppler.config.yaml       # central secret source (G-AA13, G-AE38)
│   │   └── secret-manifest.json      # required secret keys per env (drift check, G-AE35)
│   └── scripts/
│       ├── provision-resources.sh    # stand up a full environment from scratch (DR/CI)
│       ├── start-dev.sh              # local multi-worker mesh + emulated resources (G-AE48)
│       ├── deploy.ts                 # topological deploy orchestrator (G-AE34, G-AE40)
│       ├── rotate-secrets.ts         # coordinated fleet secret rotation (G-AE38)
│       ├── drift-check.ts            # config/resource drift detector (G-AE35)
│       └── restore-drill.ts          # quarterly recovery rehearsal (G-AE46)
│
├── packages/                         # ── shared libraries ──────────────────────
│   ├── types/                        # @naelao/types
│   │   └── src/{env.ts,api.ts,do-state.ts,manifest.ts,events.ts,index.ts}
│   ├── config/                       # @naelao/config — typed env + runtime config loader
│   │   └── src/{schema.ts,load.ts}
│   ├── http/                         # @naelao/http — Hono base app, error envelope, /v1 router
│   │   └── src/{app.ts,errors.ts,middleware.ts,cors.ts}
│   ├── auth/                         # @naelao/auth — JWT issue/verify, JWKS, RBAC
│   │   └── src/{jwt.ts,jwks.ts,refresh.ts,revocation.ts,rbac.ts,session.ts}   # G-AD01..AD08
│   ├── crypto/                       # @naelao/crypto — AES-GCM, envelope enc, HKDF, DEK
│   │   └── src/{aesgcm.ts,envelope.ts,dek.ts,iv-registry.ts,hash-chain.ts}    # G-AD17,AD18,AD20,W12
│   ├── db/                           # @naelao/db — DO SQLite helpers + migration runner
│   │   └── src/{sql.ts,migrate.ts,user-version.ts,outbox.ts}                  # G-AD32,AD33,F20,AD49
│   ├── analytics-schema/             # @naelao/analytics-schema — positional slot registry
│   │   └── src/{schema.ts,slots.ts,sampler.ts}                                # G-AC15,AD35
│   ├── tracing/                      # @naelao/tracing — W3C trace context propagation
│   │   └── src/{context.ts,propagate.ts,span.ts}                              # G-AD36
│   ├── logger/                       # @naelao/logger — structured logging
│   │   └── src/{logger.ts,fields.ts}                                         # G-AD35
│   ├── idempotency/                  # @naelao/idempotency — Idempotency-Key middleware
│   │   └── src/{middleware.ts,store.ts}                                       # G-AD34
│   ├── ratelimit/                    # @naelao/ratelimit — sharded DO token bucket
│   │   └── src/{rate-limit-do.ts,sharded.ts,client.ts}                        # G-AC11,AC17
│   ├── entitlements/                 # @naelao/entitlements — plan → capability gating
│   │   └── src/{service.ts,plans.ts}                                          # G-AE45
│   ├── manifest/                     # @naelao/manifest — Space Type/template schema + validator
│   │   └── src/{schema.ts,validate.ts,transition.ts,impact.ts,propagate.ts}   # G-AC01..AC10
│   ├── constraint-engine/            # @naelao/constraint-engine — requires/conflictsWith solver
│   │   └── src/{registry.json,solver.ts}                                      # G-AC01,AC07
│   ├── billing-core/                 # @naelao/billing-core — ledger, reservations, two-sided
│   │   └── src/{ledger.ts,reservation.ts,correlation.ts,proration.ts}         # G-AC29,AC33,AC36,AB38
│   ├── billing-providers/            # @naelao/billing-providers — Stripe/LemonSqueezy/RevenueCat
│   │   └── src/{stripe.ts,lemonsqueezy.ts,revenuecat.ts,meters.ts,connect.ts} # G-AC31,AA04,AA08
│   ├── rag/                          # @naelao/rag — chunking, embedding, hybrid search, rerank
│   │   └── src/{chunk.ts,embed.ts,hybrid.ts,rerank.ts,reindex.ts,cost.ts}     # G-AD09..AD13,D03,D04
│   ├── tool-runtime/                 # @naelao/tool-runtime — tool exec, beforeToolCall, sanitizer
│   │   └── src/{registry.ts,before-tool-call.ts,result-sanitizer.ts,ssrf.ts}  # G-AB20,AB21,AA27
│   ├── orchestration/                # @naelao/orchestration — DAG planner + executor
│   │   └── src/{planner.ts,executor.ts,aggregate.ts,hitl.ts,cancel.ts,continuation.ts,cost-preview.ts} # G-AE19..AE25,AC44
│   ├── channel-adapters/             # @naelao/channel-adapters — unified channel interface
│   │   └── src/
│   │       ├── adapter.ts            # ChannelAdapter interface (G-AE17)
│   │       ├── pipeline.ts           # auth→normalize→identity→render→dispatch
│   │       ├── identity.ts           # cross-channel identity resolution (G-AE12)
│   │       ├── format/{blocks.ts,slack.ts,discord.ts,whatsapp.ts,markdown.ts} # G-AE11
│   │       ├── media.ts              # inbound/outbound media normalization (G-AE16)
│   │       ├── dispatch-do.ts        # per-channel rate-limited dispatch (G-AE13,AE15)
│   │       └── providers/{slack.ts,discord.ts,telegram.ts,whatsapp.ts,email.ts,sms.ts,web-widget.ts}
│   ├── moderation/                   # @naelao/moderation — output content safety
│   │   └── src/{moderate.ts,llama-guard.ts,csam-hash.ts}                      # G-AB19
│   ├── webhooks/                     # @naelao/webhooks — outbound delivery + verification
│   │   └── src/{deliver.ts,sign.ts,verify-endpoint.ts,dlq.ts}                 # G-AD38,AD39
│   ├── degradation/                  # @naelao/degradation — per-dependency fallback map
│   │   └── src/{policy.ts,circuit-breaker.ts}                                 # G-AD50,AD30
│   ├── agent-sdk/                    # @naelao/agent-sdk — AgentPress: tools, context, memory
│   │   └── src/{agent.ts,tools.ts,context.ts,memory.ts,prompt.ts}             # G-AD46,41§
│   ├── client-sdk/                   # @naelao/client — browser + node SDK (generated + hand)
│   │   └── src/{client.ts,stream.ts,auth.ts,webhooks.ts,react/{hooks.ts}}     # G-AD48,AE05,AE10
│   ├── ui-kit/                       # @naelao/ui-kit — shared React components + design tokens
│   │   └── src/{components/,tokens.ts,theme.ts}                               # G-AE06
│   └── testing/                      # @naelao/testing — fixtures, mesh harness, isolation probes
│       └── src/{fixtures.ts,mesh.ts,isolation.ts}                             # G-AE48,AE49
│
├── workers/                          # ── Cloudflare Workers (each deployable) ──
│   │                                 #    common per-worker shape shown for `router`; others mirror it
│   ├── router/                       # naelao-router — public origin, CORS, auth, WS routing, dispatch
│   │   ├── wrangler.toml             # service bindings to all workers, KV/rate-limit bindings
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts              # fetch + WebSocket upgrade entrypoint
│   │   │   ├── routes/               # /v1 route handlers, reverse-proxy to services
│   │   │   ├── middleware/{auth.ts,ratelimit.ts,trace.ts,maintenance.ts}      # G-AC11,AD07,AD36,AE36
│   │   │   └── dispatch.ts           # service-binding dispatch table
│   │   ├── test/{router.test.ts}
│   │   └── README.md
│   │
│   ├── ws-gateway/                   # naelao-ws-gateway — connection mgmt, fan-out, per-conn ratelimit (G-AC37)
│   │   └── src/{index.ts,session.ts,fanout.ts,reconnect.ts}                   # G-AC39,AC40,AC41
│   │
│   ├── auth/                         # naelao-auth — login, refresh, sessions, SSO, password reset
│   │   ├── src/{index.ts,login.ts,refresh.ts,reset.ts,providers/{oauth.ts,saml.ts,magic-link.ts,byo-jwt.ts}}  # G-AD05,AD06
│   │   └── src/do/{RefreshTokenDO.ts,SigningKeyDO.ts}                         # G-AD01,AD04
│   │
│   ├── spaces/                       # naelao-spaces — space/sub-space CRUD, members, registry
│   │   ├── src/{index.ts,spaces.ts,members.ts,clone.ts}                       # G-AB29,AB30
│   │   └── src/do/
│   │       ├── SpaceDO.ts            # per-product master SQLite (G-AC12 sharding hooks)
│   │       ├── SpaceMetaDO.ts        # cacheable config (G-AC16)
│   │       ├── UserRegistryDO.ts     # SaaS end-user registry, sharded (G-AC19)
│   │       ├── ConversationShardDO.ts# sharded conversation store (G-AC12,AC14)
│   │       ├── ShardRouterDO.ts      # thread→shard routing (G-AC14)
│   │       ├── ChildUserDO.ts        # per-end-user DO for SaaS tenancy (G-AC13)
│   │       └── migrations/           # versioned schema migrations (G-AD32)
│   │
│   ├── provisioner/                  # naelao-provisioner — space lifecycle saga, seeding, status
│   │   ├── src/{index.ts,create.ts,delete-saga.ts,seed.ts,status.ts,bulk.ts} # G-AD42,AD43,Z28,AC48
│   │   └── workflows/{provision.workflow.ts,erasure.workflow.ts}             # G-AD14 erasure saga
│   │
│   ├── credentials/                  # naelao-credentials — encrypted secret store + access audit
│   │   ├── src/{index.ts,store.ts,decrypt.ts,access-log.ts}                   # G-AD19,W11
│   │   └── src/do/{TursoRegistryDO.ts}                                        # G-AC22,AC27
│   │
│   ├── threads/                      # naelao-threads — thread/message CRUD, streaming forward
│   │   └── src/{index.ts,threads.ts,messages.ts,archive.ts}                   # G-AC28,AC46
│   │
│   ├── agents/                       # naelao-agents — agent defs, run lifecycle, pre-flight
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── definitions.ts        # CRUD + versioning + rollback (G-AB01)
│   │   │   ├── experiments.ts        # A/B harness (G-AB02), prompt experiments (G-AB07)
│   │   │   ├── tests.ts              # per-agent regression suites (G-AB03)
│   │   │   ├── deploy-pipeline.ts    # canary + quality gate (G-AB04,AB16)
│   │   │   └── trace.ts              # execution trace / replay (G-AB11,AB12)
│   │   └── src/do/
│   │       ├── NaelaoAgentDO.ts      # agent brain: sessions, WAL, fibers, memory, token buffer
│   │       ├── ConcurrencyDO.ts      # run concurrency limiter
│   │       ├── WalletDO.ts           # credit ledger, reservations (G-AC29,AC36)
│   │       ├── OrchestrationBudgetDO.ts # sub-agent fan-out budget (G-AC44)
│   │       └── AlarmSchedulerDO.ts   # multi-alarm scheduling (G-AA34)
│   │
│   ├── assistant/                    # naelao-assistant — Space Assistant entry + channels
│   │   ├── src/{index.ts,chat.ts,channels.ts}
│   │   └── src/do/{AssistantDO.ts,AssistantSandboxDO.ts}                      # G-AA20 voice, G-AD40,AD41
│   │
│   ├── knowledge/                    # naelao-knowledge — KB CRUD, ingestion, search
│   │   ├── src/{index.ts,documents.ts,search.ts,reconcile.ts}                 # G-AD49 cross-store
│   │   ├── workflows/{ingest.workflow.ts}                                     # batch embed (G-AD11)
│   │   └── src/do/{HybridQueryDO.ts}                                          # G-Z05 federation
│   │
│   ├── billing/                      # naelao-billing — webhooks, invoicing, payouts, reconcile
│   │   ├── src/{index.ts,webhooks.ts,invoices.ts,refunds.ts,subscriptions.ts} # G-AB41,AB38,AB43
│   │   ├── workflows/{payout.workflow.ts,reconciliation.workflow.ts,dunning.workflow.ts} # G-AC35,AC32,AA03
│   │   └── src/do/{StripeRateLimiterDO.ts,BuilderWalletDO.ts}                 # G-AC31,AC33
│   │
│   ├── mcp-hub/                      # naelao-mcp-hub — MCP proxy, OAuth, pooling, transports
│   │   ├── src/{index.ts,oauth.ts,pool.ts,health.ts,schema-cache.ts}         # G-AD28,AD29,AD30
│   │   └── src/transports/{http.ts,sse.ts,stdio.ts}                          # G-AD31
│   │
│   ├── triggers/                     # naelao-triggers — inbound webhook ingestion + verification
│   │   └── src/{index.ts,verify/{slack.ts,discord.ts,telegram.ts,whatsapp.ts,stripe.ts,generic.ts}}  # G-G09
│   │
│   ├── channels/                     # naelao-channels — inbound channel → agent routing
│   │   └── src/{index.ts,inbound.ts}    # consumes @naelao/channel-adapters (G-AE17)
│   │
│   ├── workflows/                    # naelao-workflows — dynamic workflow loader + registry
│   │   ├── src/{index.ts,loader.ts,run.ts}
│   │   └── src/do/{WorkflowRegistryDO.ts,WorkerDefinitionDO.ts}
│   │
│   ├── artifact/                     # naelao-artifact — dynamic worker loader, artifact security
│   │   └── src/{index.ts,scan.ts,serve.ts}                                    # 27-pattern scan, CSP G-AA30
│   │
│   ├── browser/                      # naelao-browser — CF Browser Rendering CDP proxy
│   │   └── src/{index.ts,navigate.ts,robots.ts,sanitize.ts,session-isolation.ts}  # G-AB33,AB35,AB36
│   │
│   ├── mini-agi/                     # naelao-mini-agi — cross-space intelligence + access matrix
│   │   └── src/{index.ts,access-matrix.ts}  & src/do/{MiniAGIDO.ts}
│   │
│   ├── together-ai/                  # naelao-together-ai — LoRA fine-tuning proxy
│   │   └── src/{index.ts,finetune.ts}  & src/do/{FinetuneJobDO.ts}
│   │
│   ├── eval/                         # naelao-eval — GAIA/benchmark pipeline, judge calibration
│   │   └── src/{index.ts,run.ts,judge.ts,calibrate.ts}                        # G-AB08
│   │
│   ├── analytics/                    # naelao-analytics — queue consumer, conversation insights
│   │   └── src/{index.ts,consume.ts,insights.ts,cohorts.ts,funnels.ts}        # G-AB26,AB27,AC15
│   │
│   ├── notifications/                # naelao-notifications — multi-channel delivery
│   │   └── src/{index.ts,consume.ts,channels/{apns.ts,fcm.ts,email.ts,slack.ts,sms.ts},escalation.ts}  # G-AD44,AD45
│   │
│   ├── feedback/                     # naelao-feedback — ratings, sentiment, quality signals
│   │   └── src/{index.ts,collect.ts}
│   │
│   ├── marketplace/                  # naelao-marketplace — listings, search, install, payouts
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── listings.ts           # publish/version/curation (G-AE31)
│   │   │   ├── search.ts             # hybrid search + facets (G-AE26)
│   │   │   ├── ranking.ts            # ranking + recommendations (G-AE27)
│   │   │   ├── install.ts            # dependency resolution + lifecycle (G-AE28,AE29)
│   │   │   ├── ratings.ts            # provenance, Sybil defense (G-AB24)
│   │   │   └── analytics.ts          # publisher analytics (G-AE32)
│   │   └── workflows/{install.workflow.ts}
│   │
│   ├── portal-router/                # naelao-portal-router — custom domain/slug → space
│   │   └── src/{index.ts,resolve.ts}  # CF for SaaS custom hostnames (G-AC47)
│   │
│   ├── apps-registry/                # naelao-apps-registry — Naelao Apps / MCP app store
│   │   └── src/{index.ts}  & src/do/{AppRegistryDO.ts,SpaceTypeRegistryDO.ts}
│   │
│   ├── admin/                        # naelao-admin — CF Access protected ops surface
│   │   └── src/{index.ts,users.ts,credits.ts,dlq.ts,maintenance.ts,platform-analytics.ts}  # G-AE36,AC49
│   │
│   ├── sweeper/                      # naelao-sweeper — cron: heartbeat, cleanup, DLQ, drift
│   │   └── src/{index.ts,heartbeat.ts,dlq.ts,job-registry.ts}                 # G-AE41,AA42
│   │
│   ├── categorizer/                  # naelao-categorizer — cron: project categorization
│   │   └── src/{index.ts}
│   │
│   ├── search/                       # naelao-search — marketplace + knowledge search backend (G-AE26)
│   │   └── src/{index.ts,index-builder.ts}
│   │
│   └── synthetics/                   # naelao-synthetics — end-to-end journey monitors (G-AE47)
│       └── src/{index.ts,journeys/{chat.ts,install.ts,channel.ts,voice.ts}}
│
├── apps/                             # ── Frontends (CF Pages) ─────────────────
│   ├── dashboard/                    # Builder Dashboard — Next.js 14 App Router (G-AE01)
│   │   ├── app/                      # routes: spaces, agents, knowledge, billing, team, config
│   │   ├── components/               # config UI (schema-driven, G-AE02)
│   │   ├── lib/{api.ts,query.ts,ws.ts,auth.ts}  # client SDK, React Query, live WS (G-AE10)
│   │   ├── error-boundary.tsx        # G-AE08
│   │   ├── next.config.js  & wrangler.toml (Pages)
│   │   └── test/
│   ├── product-portal/               # End-user product UI (white-label, G-AE06)
│   │   ├── app/  & theme/{tokens.ts,apply.ts}    # design-token theming
│   │   ├── public/{manifest.webmanifest,sw.ts}   # PWA/offline (G-AE09)
│   │   └── ...
│   ├── widget/                       # Embeddable assistant widget (G-AE03)
│   │   ├── loader/loader.ts          # <15KB script-tag loader → sandboxed iframe
│   │   ├── app/                      # widget UI (runs in iframe)
│   │   ├── protocol/postmessage.ts   # host↔widget protocol (G-AE04)
│   │   └── persistence.ts            # anonymous conversation persistence (G-AE18)
│   ├── marketplace-web/              # Public SEO marketplace (Next.js SSR/SSG, G-AE30)
│   │   ├── app/marketplace/[slug]/   # listing pages + JSON-LD + sitemap
│   │   └── ...
│   └── admin-ui/                     # Internal admin console (G-AE36, AC49)
│       └── app/
│
├── mobile/                           # React Native app (thin wrapper on client-sdk, G-AE09)
│   └── src/{App.tsx,screens/,native/}
│
├── containers/                       # ── Container images (CF Containers) ─────
│   ├── sandbox-base/                 # base image: FUSE-R2 mount + workspace tooling
│   │   ├── Dockerfile  & fuse/{mount.ts,commit.ts,lock.ts}                    # G-AD24,AD25
│   ├── code-exec/                    # code execution sandbox (Dockerfile + entrypoint)
│   ├── gpu-media/                    # GPU image: transcode/extract/merge
│   ├── mcp-stdio-host/               # hosts stdio MCP servers (G-AD31)
│   └── pipeline/
│       ├── build.ts                  # reproducible build (G-AD22)
│       ├── scan.ts                   # Trivy/Grype + secret scan gate (G-AD23)
│       └── publish.ts                # registry publish + provenance
│
├── tests/                            # ── Cross-cutting test suites ────────────
│   ├── integration/                  # full service-binding mesh flows (G-AE48)
│   ├── e2e/                          # browser e2e (Playwright) across dashboard/portal/widget
│   ├── contract/                     # inter-worker contract tests (G-AE40)
│   ├── isolation/                    # tenant-isolation verification (G-AE49)
│   ├── load/                         # k6 scripts + SLO thresholds (G-AB14)
│   └── chaos/                        # fault injection (R2/Vectorize/queue/DO eviction, G-AB15)
│
├── docs/                             # ── Documentation & contracts ────────────
│   ├── architecture.md               # system overview + diagrams
│   ├── openapi.yaml                  # source-of-truth public API (G-AD37, AD48)
│   ├── data-stores.md                # per-store model, consistency, residency
│   ├── deployment.md                 # deploy order, environments, rollback
│   ├── security.md                   # auth, crypto, key mgmt, isolation invariants
│   ├── billing.md                    # two-sided ledger, metering, reconciliation
│   ├── runbooks/
│   │   ├── incident-response.md
│   │   ├── recovery-matrix.md        # per-store RTO/RPO + restore (G-AE46)
│   │   ├── secret-rotation.md        # G-AE38
│   │   └── maintenance-mode.md       # G-AE36
│   └── status-page.md                # SLA + status page config (G-AA43)
│
└── naelao_expanded_gaps_resolved.html  # the full spec + 1169 gap appendices (A–AE)
```

---

## Cloudflare Resource Map (bindings these files consume)

| Resource type | Instances |
|---|---|
| **Workers** (~33) | router, ws-gateway, auth, spaces, provisioner, credentials, threads, agents, assistant, knowledge, billing, mcp-hub, triggers, channels, workflows, artifact, browser, mini-agi, together-ai, eval, analytics, notifications, feedback, marketplace, portal-router, apps-registry, admin, sweeper, categorizer, search, synthetics |
| **Durable Objects** | SpaceDO, SpaceMetaDO, UserRegistryDO, ConversationShardDO, ShardRouterDO, ChildUserDO, NaelaoAgentDO, ConcurrencyDO, WalletDO, BuilderWalletDO, OrchestrationBudgetDO, AlarmSchedulerDO, AssistantDO, AssistantSandboxDO, HybridQueryDO, RefreshTokenDO, SigningKeyDO, TursoRegistryDO, StripeRateLimiterDO, RateLimitDO, WorkflowRegistryDO, WorkerDefinitionDO, AppRegistryDO, SpaceTypeRegistryDO, MiniAGIDO, FinetuneJobDO, ProjectDO, MaintenanceConfigDO, AdmissionControllerDO, ChannelDispatchDO, ReconnectSemaphoreDO |
| **KV namespaces** | CONFIG, CIRCUIT, ARTIFACT, PORTAL_ROUTES, MCP_TOOL_CACHE, IDEMPOTENCY, SESSION_REVOCATION |
| **R2 buckets** | workspace, knowledge-docs, assets, artifacts, uploads, workflows, training-files, backups, exports |
| **Vectorize** | shared multi-tenant index (spaceId metadata filter) + marketplace listing index |
| **Queues (+DLQ)** | notifications, analytics, knowledge-index, billing-events, workflow-dispatch, agent-runs, channel-dispatch, webhook-delivery, stripe-pending, ingest, dlq |
| **Analytics Engine** | naelao_events (+ sampled diagnostic dataset) |
| **Workflows** | provision, erasure, ingest, payout, reconciliation, dunning, install, migration-continuation |
| **CF Pages** | dashboard, product-portal, widget, marketplace-web, admin-ui |
| **Other CF** | Browser Rendering, AI Gateway, Containers + Registry, Cron Triggers, Access, CF for SaaS (custom hostnames), CF Images |
| **External (build-vs-buy)** | Turso (per-product DBs), Stripe (+Tax/Meters/Connect), WorkOS/Stytch (SSO/MFA), Postmark/Resend (email), Sentry (errors), Axiom (logs), LaunchDarkly/Statsig (flags), Doppler/Vault (secrets), Cohere/Workers-AI (rerank), Vapi/LiveKit/Deepgram/ElevenLabs (voice), LlamaParse (docs) |

---

*Every node in this tree maps to a concrete responsibility in the spec body or a fix in appendices A–AE. Nothing in the functional system is left without a home: the 22+ workers, all Durable Objects, the no-code config UI, the embeddable widget, channel adapters, the orchestration substrate, the marketplace, multi-region data paths, IaC provisioning, the full test pyramid, and operational runbooks.*
