.
├── _BUILD_PLAN
│   ├── 184 - 186 And.txt
│   ├── 187 - 189.txt
│   ├── 190 - 192 We.txt
│   ├── 193 - 195 No.txt
│   ├── 196 - 198 what.txt
│   ├── 199 - 201 What.txt
│   ├── 202 - 204 Now.txt
│   ├── 208 - 210 And.txt
│   ├── 211 - 213 What.txt
│   ├── 215 - 219 With.txt
│   ├── 220 - 222 I.txt
│   ├── 223 - 225.txt
│   ├── 231 This is a.txt
│   ├── 234 ### Axis.txt
│   ├── 235 - 240 Mini.txt
│   ├── 241 - 243 I.txt
│   ├── 244 - 245.txt
│   ├── 247 - 249 Plus.txt
│   ├── 250 - 252 What.txt
│   ├── 265 - 270 What.txt
│   ├── 271 - 276.txt
│   ├── 283 - 285 So a.txt
│   ├── 286 - 288 Plus.txt
│   ├── 292 - 294 Just.txt
│   ├── 295 - 297 In.txt
│   ├── 298 - 300 For.txt
│   ├── 301 - 303 What.txt
│   ├── 304 - 309 What.txt
│   ├── 310 - Should.txt
│   ├── 316 - 318 But.txt
│   ├── 319 - 320 What.txt
│   └── prompts
├── apps
│   ├── dashboard
│   │   ├── next.config.mjs
│   │   ├── postcss.config.js
│   │   ├── src
│   │   │   ├── app
│   │   │   │   ├── catalog
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── dashboard
│   │   │   │   │   ├── api-keys
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── clients
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── layout.tsx
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   ├── products
│   │   │   │   │   │   ├── [productId]
│   │   │   │   │   │   │   ├── OnboardingChecklist.tsx
│   │   │   │   │   │   │   ├── activity
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── agents
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── analytics
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── billing
│   │   │   │   │   │   │   │   ├── PaymentsAccountCard.tsx
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── configuration
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── danger-zone
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── domain
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── feature-flags
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── layout.tsx
│   │   │   │   │   │   │   ├── legal
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── local-machine
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── page.tsx
│   │   │   │   │   │   │   ├── pricing
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   ├── productContext.tsx
│   │   │   │   │   │   │   ├── users
│   │   │   │   │   │   │   │   └── page.tsx
│   │   │   │   │   │   │   └── wallet
│   │   │   │   │   │   │       └── page.tsx
│   │   │   │   │   │   ├── new
│   │   │   │   │   │   │   ├── page.tsx
│   │   │   │   │   │   │   ├── steps
│   │   │   │   │   │   │   │   ├── AuthConfigStep.tsx
│   │   │   │   │   │   │   │   ├── DomainStep.tsx
│   │   │   │   │   │   │   │   ├── IdentityStep.tsx
│   │   │   │   │   │   │   │   ├── PricingStep.tsx
│   │   │   │   │   │   │   │   ├── ReviewStep.tsx
│   │   │   │   │   │   │   │   └── SpaceTypeStep.tsx
│   │   │   │   │   │   │   └── wizardTypes.ts
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── settings
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   └── spaces
│   │   │   │   │       ├── [spaceId]
│   │   │   │   │       │   ├── commerce
│   │   │   │   │       │   │   └── page.tsx
│   │   │   │   │       │   ├── connectors
│   │   │   │   │       │   │   └── page.tsx
│   │   │   │   │       │   ├── credentials
│   │   │   │   │       │   │   └── page.tsx
│   │   │   │   │       │   ├── eval
│   │   │   │   │       │   │   └── page.tsx
│   │   │   │   │       │   ├── kb
│   │   │   │   │       │   │   └── page.tsx
│   │   │   │   │       │   ├── onboarding
│   │   │   │   │       │   │   └── page.tsx
│   │   │   │   │       │   ├── sessions
│   │   │   │   │       │   │   └── page.tsx
│   │   │   │   │       │   └── webhooks
│   │   │   │   │       │       └── page.tsx
│   │   │   │   │       └── page.tsx
│   │   │   │   ├── globals.css
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── login
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── page.tsx
│   │   │   │   └── reset-password
│   │   │   │       └── page.tsx
│   │   │   ├── components
│   │   │   │   └── ConfirmByTypingDialog.tsx
│   │   │   └── lib
│   │   │       ├── api.ts
│   │   │       ├── auth-provider.tsx
│   │   │       ├── auth.ts
│   │   │       ├── product-url.ts
│   │   │       └── temples.ts
│   │   └── tailwind.config.ts
│   ├── launchpad
│   │   └── src
│   │       └── index.html
│   ├── marketplace-web
│   │   ├── next.config.mjs
│   │   ├── postcss.config.js
│   │   ├── src
│   │   │   ├── app
│   │   │   │   ├── categories
│   │   │   │   │   └── [category]
│   │   │   │   │       └── page.tsx
│   │   │   │   ├── globals.css
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── listing
│   │   │   │   │   └── [id]
│   │   │   │   │       └── page.tsx
│   │   │   │   └── page.tsx
│   │   │   └── lib
│   │   │       └── api.ts
│   │   └── tailwind.config.ts
│   ├── portal
│   │   ├── next.config.mjs
│   │   ├── postcss.config.js
│   │   ├── src
│   │   │   ├── app
│   │   │   │   ├── [spaceId]
│   │   │   │   │   ├── auth
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   ├── layout.tsx
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── catalog
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── embed
│   │   │   │   │   └── [spaceId]
│   │   │   │   │       └── page.tsx
│   │   │   │   ├── globals.css
│   │   │   │   ├── launch
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── login
│   │   │   │   │   └── page.tsx
│   │   │   │   └── page.tsx
│   │   │   └── lib
│   │   │       ├── account.ts
│   │   │       ├── api.ts
│   │   │       ├── i18n.ts
│   │   │       ├── productAccount.ts
│   │   │       └── session.ts
│   │   ├── tailwind.config.ts
│   │   └── wrangler.toml
│   ├── shell
│   │   ├── next.config.mjs
│   │   └── src
│   │       ├── app
│   │       │   ├── globals.css
│   │       │   ├── layout.tsx
│   │       │   ├── p
│   │       │   │   └── [slug]
│   │       │   │       ├── (shell)
│   │       │   │       │   ├── agents
│   │       │   │       │   │   ├── [agentId]
│   │       │   │       │   │   │   └── page.tsx
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── analytics
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── approvals
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── connectors
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── dashboard
│   │       │   │       │   │   ├── assistant
│   │       │   │       │   │   │   └── page.tsx
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── knowledge
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── layout.tsx
│   │       │   │       │   ├── new
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── notifications
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── page.tsx
│   │       │   │       │   ├── plugins
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── projects
│   │       │   │       │   │   ├── [projectId]
│   │       │   │       │   │   │   ├── page.tsx
│   │       │   │       │   │   │   └── threads
│   │       │   │       │   │   │       └── [threadId]
│   │       │   │       │   │   │           └── page.tsx
│   │       │   │       │   │   ├── all
│   │       │   │       │   │   │   └── page.tsx
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── sessions
│   │       │   │       │   │   ├── [sessionId]
│   │       │   │       │   │   │   └── page.tsx
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── settings
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── spaces
│   │       │   │       │   │   ├── [businessId]
│   │       │   │       │   │   │   ├── accept-invite
│   │       │   │       │   │   │   │   └── [token]
│   │       │   │       │   │   │   │       └── page.tsx
│   │       │   │       │   │   │   ├── onboarding
│   │       │   │       │   │   │   │   └── page.tsx
│   │       │   │       │   │   │   └── page.tsx
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   ├── threads
│   │       │   │       │   │   ├── [threadId]
│   │       │   │       │   │   │   └── page.tsx
│   │       │   │       │   │   └── page.tsx
│   │       │   │       │   └── workflows
│   │       │   │       │       └── page.tsx
│   │       │   │       ├── layout.tsx
│   │       │   │       ├── login
│   │       │   │       │   └── page.tsx
│   │       │   │       ├── signup
│   │       │   │       │   └── page.tsx
│   │       │   │       └── verify-email
│   │       │   │           └── page.tsx
│   │       │   └── page.tsx
│   │       ├── components
│   │       │   ├── ActivityFeed.tsx
│   │       │   ├── AgentPolicyPanel.tsx
│   │       │   ├── AppCard.tsx
│   │       │   ├── ApprovedActionsEditor.tsx
│   │       │   ├── AssistantDelegationCard.tsx
│   │       │   ├── AssistantSidePanels.tsx
│   │       │   ├── ByokKeysPanel.tsx
│   │       │   ├── ChannelConnect.tsx
│   │       │   ├── Chat.tsx
│   │       │   ├── CitationBadge.tsx
│   │       │   ├── ComingSoon.tsx
│   │       │   ├── ComposerDock.tsx
│   │       │   ├── ConnectorAliases.tsx
│   │       │   ├── ContextUsageMeter.tsx
│   │       │   ├── CustomerBotAutomation.tsx
│   │       │   ├── FileViewer.tsx
│   │       │   ├── HtmlPreviewFrame.tsx
│   │       │   ├── InlineApprovalCard.tsx
│   │       │   ├── InlineArtifactCard.tsx
│   │       │   ├── InlineConnectorCard.tsx
│   │       │   ├── InterruptedRunCard.tsx
│   │       │   ├── Markdown.tsx
│   │       │   ├── MessageActions.tsx
│   │       │   ├── ModelSelector.tsx
│   │       │   ├── ProjectKindPanel.tsx
│   │       │   ├── SecurityBoundaryCard.tsx
│   │       │   ├── SettingsSection.tsx
│   │       │   ├── SubthreadPanel.tsx
│   │       │   └── UpgradeDialog.tsx
│   │       ├── lib
│   │       │   ├── active-space-context.tsx
│   │       │   ├── api.ts
│   │       │   ├── auth-provider.tsx
│   │       │   ├── chatSession.ts
│   │       │   ├── connectorActions.ts
│   │       │   ├── modelPreference.ts
│   │       │   ├── product-context.tsx
│   │       │   ├── productAccount.ts
│   │       │   ├── relativeTime.ts
│   │       │   └── roles.ts
│   │       └── types
│   │           └── mammoth-browser.d.ts
│   └── widget
│       └── src
│           └── naelao-chat.ts
├── docs
│   └── spec-appendix
├── infra
│   ├── gen-spec-index.py
│   ├── migrations
│   │   ├── 0001_users.sql
│   │   ├── 0002_orgs.sql
│   │   ├── 0003_spaces.sql
│   │   ├── 0004_billing.sql
│   │   ├── 0005_audit.sql
│   │   ├── 0006_kb_documents.sql
│   │   ├── 0007_billing_meters.sql
│   │   ├── 0008_events_queue_log.sql
│   │   ├── 0009_audit_log_v2.sql
│   │   ├── 0010_notifications.sql
│   │   ├── 0011_triggers.sql
│   │   ├── 0012_mcp_servers.sql
│   │   ├── 0013_space_type_tools.sql
│   │   ├── 0014_eval.sql
│   │   ├── 0015_artifacts.sql
│   │   ├── 0016_webhook_subscriptions.sql
│   │   ├── 0017_idempotency_keys.sql
│   │   ├── 0018_active_sessions.sql
│   │   ├── 0019_oauth_providers.sql
│   │   ├── 0020_service_accounts.sql
│   │   ├── 0021_space_members.sql
│   │   ├── 0022_api_key_scopes.sql
│   │   ├── 0023_feature_flags.sql
│   │   ├── 0024_do_registry.sql
│   │   ├── 0025_gdpr_requests.sql
│   │   ├── 0026_marketplace.sql
│   │   ├── 0027_threads.sql
│   │   ├── 0028_agi_runs.sql
│   │   ├── 0029_thread_sessions.sql
│   │   ├── 0030_token_version.sql
│   │   ├── 0031_platform_failures.sql
│   │   ├── 0032_usage_events_idempotency.sql
│   │   ├── 0033_reseller_accounts.sql
│   │   ├── 0034_space_hierarchy.sql
│   │   ├── 0035_commerce.sql
│   │   ├── 0036_ls_product_id.sql
│   │   ├── 0037_mcp_servers_auth.sql
│   │   ├── 0038_channel_links.sql
│   │   ├── 0039_channel_links_project.sql
│   │   ├── 0040_space_credentials.sql
│   │   ├── 0041_scheduled_jobs.sql
│   │   ├── 0042_scheduled_jobs_failures.sql
│   │   ├── 0043_scheduled_jobs_agent_goal.sql
│   │   ├── 0044_naelao_product.sql
│   │   ├── 0045_builder_dashboard_api.sql
│   │   ├── 0046_product_end_user_credentials.sql
│   │   ├── 0047_business_memberships.sql
│   │   ├── 0048_admin_schema_fixes.sql
│   │   ├── 0049_business_subscriptions.sql
│   │   ├── 0050_webhook_idempotency.sql
│   │   ├── 0051_kb_documents_project.sql
│   │   ├── 0052_webhook_idempotency_event_type.sql
│   │   ├── 0053_payout_requests.sql
│   │   ├── 0054_password_reset_tokens.sql
│   │   ├── 0055_email_verification.sql
│   │   ├── 0056_bizsvc_custom_domain_index.sql
│   │   ├── 0057_builder_password_reset_tokens.sql
│   │   ├── 0058_product_end_users_deleted_at.sql
│   │   ├── 0059_spaces_last_digest_sent_at.sql
│   │   ├── 0060_mcp_server_connector_provider.sql
│   │   ├── 0061_reseller_ledger_kind.sql
│   │   ├── 0062_subscriptions_lemon_squeezy.sql
│   │   ├── 0063_payment_connections.sql
│   │   ├── 0064_whop_sub_merchants.sql
│   │   ├── 0065_whop_kyc_onboarding.sql
│   │   ├── 0066_payout_request_expiry.sql
│   │   ├── 0067_subscriptions_whop_platform_plan.sql
│   │   ├── 0068_eval_run_model.sql
│   │   ├── 0069_credential_sharing_and_product_tier.sql
│   │   ├── 0070_channel_pairings.sql
│   │   ├── 0071_scheduled_job_runs.sql
│   │   ├── 0072_org_quota_overage.sql
│   │   ├── 0073_project_scoped_automation.sql
│   │   ├── 0074_items_45_87_security_models.sql
│   │   ├── 0075_phase1_runtime_security.sql
│   │   └── 0076_connector_alias_hardening.sql
│   ├── scripts
│   │   ├── await-quota-then-matrix.sh
│   │   ├── matrix-results-to-benchmarks.mjs
│   │   ├── run-eval-suite.mjs
│   │   ├── run-model-matrix.sh
│   │   ├── shell-interact.mjs
│   │   ├── shell-mobile-check.mjs
│   │   ├── shell-screenshot.mjs
│   │   └── start-dev.sh
│   └── terraform
│       ├── main.tf
│       ├── outputs.tf
│       ├── providers.tf
│       ├── terraform.tfvars.example
│       └── variables.tf
├── naelao_expanded_gaps_resolved.html
├── naelao_whop_businesses_spec.html
├── packages
│   ├── agent-sdk
│   │   └── src
│   │       ├── avos-features.ts
│   │       ├── canvas-runtime.ts
│   │       ├── extensions.ts
│   │       ├── index.ts
│   │       ├── launchpad-runtime.ts
│   │       └── workflow-taxonomy.ts
│   ├── analytics-schema
│   │   └── src
│   │       └── index.ts
│   ├── auth
│   │   └── src
│   │       ├── index.ts
│   │       ├── jwt.ts
│   │       └── rbac.ts
│   ├── billing-core
│   │   └── src
│   │       ├── effort.ts
│   │       ├── index.ts
│   │       ├── model-benchmarks.ts
│   │       ├── models.ts
│   │       ├── personal-plan.ts
│   │       ├── providers
│   │       │   ├── index.ts
│   │       │   ├── lemon-squeezy.ts
│   │       │   ├── types.ts
│   │       │   ├── whop-oauth-checkout.ts
│   │       │   ├── whop-platform-plan.ts
│   │       │   └── whop.ts
│   │       └── reseller.ts
│   ├── client-sdk
│   │   └── src
│   │       └── index.ts
│   ├── config
│   │   └── src
│   │       └── index.ts
│   ├── crypto
│   │   └── src
│   │       └── index.ts
│   ├── db
│   │   └── src
│   │       ├── index.ts
│   │       ├── migrate.ts
│   │       └── sql.ts
│   ├── entitlements
│   │   └── src
│   │       └── index.ts
│   ├── events
│   │   └── src
│   │       ├── business-feature-kinds.ts
│   │       ├── failure-classification.ts
│   │       └── index.ts
│   ├── http
│   │   └── src
│   │       ├── cors.ts
│   │       ├── errors.ts
│   │       ├── index.ts
│   │       ├── kv.ts
│   │       ├── middleware.ts
│   │       └── realtime.ts
│   ├── idempotency
│   │   └── src
│   │       └── index.ts
│   ├── llm-gateway
│   │   └── src
│   │       ├── gateway.ts
│   │       ├── index.ts
│   │       └── types.ts
│   ├── logger
│   │   └── src
│   │       └── index.ts
│   ├── moderation
│   │   └── src
│   │       └── index.ts
│   ├── rag
│   │   └── src
│   │       ├── chunk.ts
│   │       ├── citations.ts
│   │       ├── embed.ts
│   │       ├── hybrid.ts
│   │       └── index.ts
│   ├── security
│   │   └── src
│   │       ├── audit.ts
│   │       ├── headers.ts
│   │       ├── index.ts
│   │       ├── rate-limit-do.ts
│   │       ├── secrets.ts
│   │       ├── ssrf-guard.ts
│   │       └── waf.ts
│   ├── testing
│   │   └── src
│   │       └── index.ts
│   ├── tool-runtime
│   │   └── src
│   │       └── index.ts
│   ├── tracing
│   │   └── src
│   │       └── index.ts
│   ├── types
│   │   └── src
│   │       └── index.ts
│   ├── ui
│   │   └── src
│   │       ├── components
│   │       │   ├── Avatar.tsx
│   │       │   ├── Badge.tsx
│   │       │   ├── Button.tsx
│   │       │   ├── Card.tsx
│   │       │   ├── Form.tsx
│   │       │   ├── Modal.tsx
│   │       │   ├── NavItem.tsx
│   │       │   ├── PageView.tsx
│   │       │   ├── QrCode.tsx
│   │       │   ├── Sidebar.tsx
│   │       │   ├── SpaceSwitcher.tsx
│   │       │   ├── Toast.tsx
│   │       │   ├── TopBar.tsx
│   │       │   └── icons.tsx
│   │       ├── index.ts
│   │       ├── qr.ts
│   │       ├── styles.css
│   │       ├── tokens.css
│   │       └── useTheme.ts
│   └── webhooks
│       └── src
│           └── index.ts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── prompts.xml
├── repomix
│   ├── apply-batch-patch.mjs
│   ├── build-prompts.mjs
│   ├── patches
│   ├── prepare-authority-context.mjs
│   ├── prompts
│   └── verify-configs.mjs
├── repomix-output.xml
├── run-phase (1).mjs
├── run-phase.mjs
├── vitest.workspace.ts
└── workers
    ├── admin
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── agents
    │   ├── Dockerfile.toolsandbox
    │   ├── container
    │   │   ├── artifact-fs.mjs
    │   │   ├── artifact-fs.test.mjs
    │   │   └── server.mjs
    │   ├── local-agent
    │   │   └── naelao-local-agent.mjs
    │   ├── src
    │   │   ├── agent-templates.ts
    │   │   ├── channels
    │   │   │   └── agentmail.ts
    │   │   ├── connectors
    │   │   │   ├── catalogue.ts
    │   │   │   ├── composio.ts
    │   │   │   ├── directory.ts
    │   │   │   ├── oauth.ts
    │   │   │   ├── pipedream.ts
    │   │   │   └── webhook-normalizer.ts
    │   │   ├── do
    │   │   │   ├── ConcurrencyDO.ts
    │   │   │   ├── HITLApprovalDO.ts
    │   │   │   ├── LocalTunnelDO.ts
    │   │   │   ├── NaelaoAgentDO.ts
    │   │   │   ├── TaskDO.ts
    │   │   │   └── ToolSandboxDO.ts
    │   │   ├── env.ts
    │   │   ├── index.ts
    │   │   ├── launchpad
    │   │   │   ├── bootstrap.ts
    │   │   │   ├── business-context.ts
    │   │   │   ├── channel-pairing.ts
    │   │   │   ├── channels.ts
    │   │   │   ├── growth-skills.ts
    │   │   │   ├── project-templates.ts
    │   │   │   ├── scaling-skills.ts
    │   │   │   ├── spacetype.ts
    │   │   │   └── webdev-skills.ts
    │   │   ├── safety.ts
    │   │   ├── script-engine
    │   │   │   ├── agent-archetypes.ts
    │   │   │   ├── agent-config.ts
    │   │   │   ├── assistant-access.ts
    │   │   │   ├── code-runner.ts
    │   │   │   ├── container-catalogue.ts
    │   │   │   ├── conversation-context.ts
    │   │   │   ├── execution-ladder.ts
    │   │   │   ├── federation.ts
    │   │   │   ├── fingerprint.ts
    │   │   │   ├── index.ts
    │   │   │   ├── loop-budget.ts
    │   │   │   ├── loop.ts
    │   │   │   ├── memory-os.ts
    │   │   │   ├── observe.ts
    │   │   │   ├── prebuilt
    │   │   │   │   ├── approvals.ts
    │   │   │   │   ├── artifacts.ts
    │   │   │   │   ├── browser-use.ts
    │   │   │   │   ├── business-diagnostics.ts
    │   │   │   │   ├── business-email.ts
    │   │   │   │   ├── business-wallet.ts
    │   │   │   │   ├── code-exec.ts
    │   │   │   │   ├── commerce.ts
    │   │   │   │   ├── conversation.ts
    │   │   │   │   ├── dynamic-workflow.ts
    │   │   │   │   ├── fabric.ts
    │   │   │   │   ├── file-manager.ts
    │   │   │   │   ├── index.ts
    │   │   │   │   ├── knowledge-base.ts
    │   │   │   │   ├── local-machine.ts
    │   │   │   │   ├── lock.ts
    │   │   │   │   ├── mcp-connector.ts
    │   │   │   │   ├── memory.ts
    │   │   │   │   ├── notifications.ts
    │   │   │   │   ├── plan.ts
    │   │   │   │   ├── project-coordination.ts
    │   │   │   │   ├── project-journal.ts
    │   │   │   │   ├── r2-workspace.ts
    │   │   │   │   ├── revenue-tracker.ts
    │   │   │   │   ├── schedule.ts
    │   │   │   │   ├── skill-manager.ts
    │   │   │   │   ├── storefront.ts
    │   │   │   │   ├── sub-agent.ts
    │   │   │   │   ├── tasks.ts
    │   │   │   │   ├── wallet.ts
    │   │   │   │   ├── web-search.ts
    │   │   │   │   ├── wiki.ts
    │   │   │   │   ├── workspace-admin.ts
    │   │   │   │   └── workspace.ts
    │   │   │   ├── profiles.ts
    │   │   │   ├── project-journal.ts
    │   │   │   ├── project-memory-client.ts
    │   │   │   ├── reasoner.ts
    │   │   │   ├── reserved-capabilities.ts
    │   │   │   ├── script-find.ts
    │   │   │   ├── skill-health.ts
    │   │   │   ├── skill-library.ts
    │   │   │   ├── step-context.ts
    │   │   │   ├── sub-agent-output.ts
    │   │   │   ├── tool-surface.ts
    │   │   │   ├── types.ts
    │   │   │   └── virtual-cli.ts
    │   │   ├── shared
    │   │   │   └── ai-client.ts
    │   │   └── workflows
    │   │       ├── AgentTaskWorkflow.ts
    │   │       ├── ScriptRunWorkflow.ts
    │   │       └── report-infra-usage.ts
    │   └── wrangler.toml
    ├── analytics
    │   ├── src
    │   │   ├── events.ts
    │   │   ├── index.ts
    │   │   └── query.ts
    │   └── wrangler.toml
    ├── artifact
    │   ├── src
    │   │   ├── RepositoryDO.ts
    │   │   ├── index.ts
    │   │   ├── repository.test.ts
    │   │   └── repository.ts
    │   └── wrangler.toml
    ├── assistant
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── auth
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── billing
    │   ├── src
    │   │   ├── index.ts
    │   │   ├── lemon-squeezy.ts
    │   │   ├── ls-products.ts
    │   │   ├── quota.ts
    │   │   ├── whop-oauth-billing.ts
    │   │   └── whop-wallet.ts
    │   └── wrangler.toml
    ├── browser
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── channels
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── connector-gumroad
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── connector-whop
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── credentials
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── eval
    │   ├── src
    │   │   ├── index.ts
    │   │   └── trace-checks.ts
    │   └── wrangler.toml
    ├── feedback
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── knowledge
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── marketplace
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── mcp-hub
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── mini-agi
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── notifications
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── portal-router
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── provisioner
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── router
    │   ├── src
    │   │   ├── RateLimitDO.ts
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── search
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── security-gateway
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── spaces
    │   ├── src
    │   │   ├── builder-routes.ts
    │   │   ├── business-auth.ts
    │   │   ├── business-create.ts
    │   │   ├── business-routes.ts
    │   │   ├── cf-saas.ts
    │   │   ├── create-space.ts
    │   │   ├── do
    │   │   │   ├── BuilderAccountDO.ts
    │   │   │   ├── FeatureFlagDO.ts
    │   │   │   ├── LockDO.ts
    │   │   │   ├── ProductUserDO.ts
    │   │   │   ├── SpaceDO.ts
    │   │   │   ├── SpaceTypeRegistryDO.ts
    │   │   │   └── TransactionCoordinatorDO.ts
    │   │   ├── index.ts
    │   │   ├── launchpad-manifest.ts
    │   │   ├── product-end-user-routes.ts
    │   │   ├── template-catalog.ts
    │   │   └── tenancy.ts
    │   └── wrangler.toml
    ├── sweeper
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── synthetics
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── threads
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── together-ai
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── triggers
    │   ├── src
    │   │   └── index.ts
    │   └── wrangler.toml
    ├── workflows
    │   ├── src
    │   │   ├── env.ts
    │   │   ├── index.ts
    │   │   ├── queue-consumer.ts
    │   │   └── workflows
    │   │       ├── DataErasureWorkflow.ts
    │   │       ├── DunningWorkflow.ts
    │   │       ├── KbIngestionWorkflow.ts
    │   │       ├── QueueHealthWorkflow.ts
    │   │       └── SpaceProvisioningWorkflow.ts
    │   └── wrangler.toml
    └── ws-gateway
        ├── src
        │   └── index.ts
        └── wrangler.toml

240 directories, 570 files
