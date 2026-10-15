# Space data retention and encrypted backups

The owner/admin API is `GET|POST /spaces/:spaceId/data-ops`. Calls pass through business-role checks, confirm the Space belongs to the caller's tenant, and are forwarded to that Space's Durable Object using a tenant-scoped internal token. The Durable Object validates the token again. Actor IDs come from authenticated request claims and are written to the retention event log.

`POST` actions:

- `configure`: choose `message_retention_days` (0 disables deletion; accepted values are 30, 90, 180, 365, and 730), `archive_before_delete`, optional `target_storage_bytes` (1 MiB–10 GiB), and `warning_threshold_pct`.
- `set_retention_hold`: set or release a session-level hold. Held messages are excluded from deletion previews and counts.
- `preview_retention`: creates a 15-minute, one-use selection fingerprint and reports selected message count/serialized bytes plus held messages excluded. It reads only sessions matching both tenant and Space and limits a selection to 50,000 messages.
- `export`: create an encrypted full snapshot, or use `kind: "retention_messages"` with the matching `preview_id` to archive exactly the reviewed deletion selection. Supply a stable `request_id`; retries reuse the same archive ID. An R2 write failure records a failed job that can be retried with that same request ID.
- `apply_retention`: requires a fresh preview, re-queries and fingerprints the selection, and requires a verified, decryptable, checksum-matching archive when archive-before-delete is enabled. A transaction deletes only the exact message IDs, consumes the preview, and records the event.
- `preview_restore`, then `apply_restore`: verify archive scope, authentication/checksum, schema compatibility, and every R2 object reference before creating a short-lived restore preview. Apply runs in a transaction with foreign keys deferred for cyclic legacy schemas and inserts missing rows only. Replays are blocked by consuming the preview; a new preview can safely repeat the merge.

## Retention and ownership inventory

The only automatic hard deletion is from `messages`, through `sessions.space_id` + `sessions.tenant_id` and excluding `sessions.retention_hold = 1`. Session shells remain. Policy changes, holds, previews, archive records, restores, and deletion actions are recorded in `space_retention_events`. The worker does not set a generic TTL on audit, legal, billing, wallet, security, project, extension, provider, or agent records. There is no repository-defined legal retention schedule for those records, so they remain under their existing lifecycle until a separately approved schedule is defined.

The current SpaceDO migration schema contains these application tables (scope follows each table's explicit `space_id`, `tenant_id`, `session_id`, `project_id`, or cross-Space target/grantee columns where present):

- Conversation and agent state: `sessions`, `messages`, `agent_state`, `threads`, `customer_conversations`, `voice_call_sessions`, `agent_activity_log`, `agent_signal_events`, `agent_definitions`, `assistant_policy`, `agent_policy_overrides`, `agent_api_keys`, `space_assistants`.
- Money, billing, and audit: `wallet_ledger`, `wallet_payouts`, `space_credits`, `session_spend`, `project_spend`, `external_revenue_snapshots`, `action_receipts`, `provenance_ledger`, `cross_space_access_audit`, `processed_webhook_events`.
- Space, membership, security, and machine configuration: `spaces`, `space_members`, `user_settings`, `user_rate_limits`, `presence`, `injection_attempts`, `emergency_stopped_tasks`, `ephemeral_grants_consumed`, `local_grants`, `machine_enrollments`, `named_machines`, `container_slots`, `connector_account_mode`, `connector_aliases`, `cross_space_grants`, `accepted_cross_space_documents`, `accepted_cross_space_workers`.
- Projects and work: `projects`, `project_members`, `project_rules`, `project_facts`, `project_fabric`, `project_wiki`, `project_demo_fixtures`, `project_scheduled_jobs`, `workspace_files`, `tasks`, `pull_request_cards`, `rfcs`, `kb_documents`, `foundry_templates`, `foundry_feature_requests`, `executive_contacts`, `space_calendar_events`, `space_glossary_terms`, `notifications`, `event_triggers`, `artifact_linter_failures`, `space_runtime_state`, `space_user_budget_envelopes`.
- Extensions and provider configuration: `installed_extensions`, `extension_instances`, `custom_model_manifests`, `custom_model_lifecycle`, `custom_model_lifecycle_events`.
- Data-operations metadata: `space_retention_policies`, `space_storage_measurements`, `space_archive_records`, `space_retention_previews`, `space_archive_restore_previews`, `space_archive_restores`, `space_retention_events`.

Migration shadow tables such as `projects_v41`, `projects_v42`, `projects_v50`, `project_members_v42`, `event_triggers_v40`, and `cross_space_grants_v42` are temporary migration artifacts and are not present in the final migration replay. `_migrations` is represented by the manifest migration version, not restored as application data. FTS virtual tables and their shadow tables (`messages_fts*`) are derived indexes and are excluded; message writes rebuild the index through existing triggers. The seven data-operations metadata tables are excluded from snapshots so restore cannot replace the policy or its own audit history.

## Archive limits and operational boundaries

Archive plaintext is capped at 8 MiB, individual table snapshots at 10,000 rows, retention previews at 50,000 messages, and referenced R2 objects at 5,000. Full archives store encrypted SQLite rows plus R2 object keys/ETags/sizes; workspace object bytes remain in their canonical bucket and are checked for identity/integrity before restore. Restore is an idempotent **merge of missing rows**, not a destructive rollback or point-in-time replacement; current SQLite remains canonical. Incompatible columns, a future schema version, missing/changed referenced objects, invalid encryption, tenant/Space mismatch, or transaction errors fail before commit.

`SPACE_ARCHIVE_KEY` is an optional stable dedicated secret; if absent, `PLATFORM_SECRET` is used. Keep the selected key material stable to decrypt existing archives. No previous-key ring or online key-rewrap operation is implemented yet, so rotating this key makes older archives unreadable. The current implementation retries whole bounded archives rather than uploading resumable encrypted chunks; exceeding a cap returns an error and never claims a partial archive as verified. The code has local SQLite/R2-mock integration coverage only. Live R2 durability, account retention, and cross-deployment restore have not been verified.

Storage forecasts use sampled `PRAGMA page_count × page_size` measurements and a simple linear 30-day trend only when at least one day of history exists. They report allocated database bytes and owner-selected thresholds; no billing price or archival savings is inferred.
