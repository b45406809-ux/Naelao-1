const MAX_DOCUMENT_CHUNKS = 12_000;
const R2_DELETE_BATCH_SIZE = 100;
const KV_DELETE_BATCH_SIZE = 100;
const SPACE_ERASURE_TABLES = [
  "active_sessions", "thread_sessions", "threads", "kb_chunks", "kb_documents",
  "agent_email_addresses", "agi_runs", "artifacts", "attachment_copy_claims", "blueprint_export_jobs",
  "business_services", "capability_nonces", "channel_attachments", "channel_links", "channel_pairings",
  "connector_alias_audit", "connector_aliases", "customer_voice_call_admissions",
  "customer_voice_purchase_quotes", "customer_voice_number_bindings", "customer_voice_space_policies",
  "desk_drop_tickets", "email_attachment_ocr_usage", "email_inbound_attachments", "email_reply_routes",
  "eval_runs", "eval_suites", "extension_provider_routes", "extension_provider_connections",
  "extension_publisher_keys", "installed_extensions", "kb_external_publication_documents",
  "kb_external_publications", "launchpad_products", "fde_graduations", "llm_token_reservations",
  "mcp_servers", "oauth_sessions", "oauth_providers", "payment_connections",
  "payout_destinations", "project_access", "project_steward_decisions", "project_steward_runs",
  "recipe_installations", "scheduled_job_runs", "scheduled_jobs", "space_compliance_policy",
  "space_credential_keys", "space_credentials", "space_members", "triggers", "virtual_cli_commands",
  "webhook_subscriptions", "whop_sub_merchants", "workflow_executions_v2",
] as const;

export async function deleteKvPrefix(
  kv: Pick<KVNamespace, "list" | "delete">,
  prefix: string
): Promise<number> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let deleted = 0;
  do {
    const listed = await kv.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (let start = 0; start < listed.keys.length; start += KV_DELETE_BATCH_SIZE) {
      const batch = listed.keys.slice(start, start + KV_DELETE_BATCH_SIZE);
      await Promise.all(batch.map(({ name }) => kv.delete(name)));
      deleted += batch.length;
    }
    if (listed.list_complete) return deleted;
    const nextCursor = listed.cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("KV erasure returned a missing or repeated cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
  return deleted;
}

export interface ErasureDocument {
  id: string;
  project_id: string | null;
  chunk_count: number | null;
}

export async function eraseSpaceD1Records(db: D1Database, spaceId: string): Promise<void> {
  // Children precede parents where the migrations declare foreign keys.
  await db.batch(SPACE_ERASURE_TABLES.map((table) =>
    db.prepare(`DELETE FROM ${table} WHERE space_id = ?`).bind(spaceId)
  ));
}

/** Retain financial/audit records, but remove tenant login, notification, API, and registry state. */
export async function eraseOrgOperationalRecords(db: D1Database, orgId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM org_members WHERE org_id = ?").bind(orgId),
    db.prepare("DELETE FROM api_keys WHERE org_id = ?").bind(orgId),
    db.prepare("DELETE FROM builder_api_key_index WHERE tenant_id = ?").bind(orgId),
    db.prepare("DELETE FROM service_accounts WHERE tenant_id = ?").bind(orgId),
    db.prepare("DELETE FROM notifications WHERE tenant_id = ?").bind(orgId),
    db.prepare("DELETE FROM web_push_subscriptions WHERE tenant_id = ?").bind(orgId),
    db.prepare("DELETE FROM do_registry WHERE tenant_id = ?").bind(orgId),
    db.prepare("DELETE FROM space_type_tools WHERE tenant_id = ?").bind(orgId),
    // Earnings rows reference these subscriptions; preserve financial history while stopping renewals.
    db.prepare("UPDATE template_subscriptions SET status = 'cancelled', updated_at = datetime('now') WHERE space_id IN (SELECT id FROM spaces WHERE tenant_id = ?)").bind(orgId),
    // Preserve the wallet's financial/provider identifiers, but remove the direct owner email.
    db.prepare("UPDATE whop_sub_merchants SET owner_email = 'erased@deleted.invalid' WHERE tenant_id = ?").bind(orgId),
    db.prepare("UPDATE spacetypes SET name = 'Erased SpaceType', description = NULL, schema_json = '{}', status = 'archived' WHERE org_id = ?").bind(orgId),
    db.prepare("UPDATE spaces SET name = 'Erased space', config_json = '{}', created_by = NULL, status = 'deleted', suspension_reason = 'erasure', updated_at = datetime('now') WHERE tenant_id = ?").bind(orgId),
    db.prepare("UPDATE users SET org_id = NULL WHERE org_id = ?").bind(orgId),
    db.prepare("UPDATE orgs SET name = 'Erased organization', owner_id = 'system-erasure', status = 'erased' WHERE id = ?").bind(orgId),
  ]);
}

export async function anonymizeOrgUsers(db: D1Database, orgId: string): Promise<void> {
  await db.prepare(
    `UPDATE users
     SET email = 'erased-' || id || '@deleted.invalid', password_hash = NULL,
         last_login_at = NULL, status = 'erased', preferred_language = NULL
     WHERE org_id = ?`
  ).bind(orgId).run();
}

function documentPrefix(spaceId: string, projectId: string | null, documentId: string): string {
  return `kb/${spaceId}/${projectId ?? "_space"}/${documentId}/`;
}

function autoragKey(spaceId: string, projectId: string | null, documentId: string): string {
  return `autorag/${spaceId}/${projectId ?? "_space"}/${documentId}.md`;
}

export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const listed = await bucket.list(cursor === undefined ? { prefix, limit: 1000 } : { prefix, cursor, limit: 1000 });
    for (let start = 0; start < listed.objects.length; start += R2_DELETE_BATCH_SIZE) {
      await Promise.all(listed.objects.slice(start, start + R2_DELETE_BATCH_SIZE).map(({ key }) => bucket.delete(key)));
    }
    if (!listed.truncated) return;
    const nextCursor = listed.cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error("R2 erasure returned a missing or repeated cursor");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
}

/** Remove artifacts and workspace files stored outside the Knowledge bucket. */
export async function eraseSpaceR2Resources(
  tenantId: string,
  spaceId: string,
  artifactBucket: R2Bucket,
  repositoryBucket: R2Bucket,
  workspaceBucket: R2Bucket,
  extraWorkspaceKeys: string[] = [],
): Promise<void> {
  await eraseSpaceR2Prefixes(tenantId, spaceId, artifactBucket, repositoryBucket, workspaceBucket);
  await eraseTenantExportKeys(tenantId, workspaceBucket, extraWorkspaceKeys);
}

export async function eraseSpaceR2Prefixes(
  tenantId: string,
  spaceId: string,
  artifactBucket: R2Bucket,
  repositoryBucket: R2Bucket,
  workspaceBucket: R2Bucket,
): Promise<void> {
  await deleteR2Prefix(artifactBucket, `${tenantId}/${spaceId}/`);
  await deleteR2Prefix(repositoryBucket, `repositories/${tenantId}/${spaceId}/`);
  await deleteR2Prefix(workspaceBucket, `spaces/${spaceId}/`);
}

export async function eraseTenantExportKeys(
  tenantId: string,
  workspaceBucket: R2Bucket,
  keys: string[],
): Promise<void> {
  const exportPrefix = `conformance-jobs/${tenantId}/`;
  if (keys.some((key) => !key.startsWith(exportPrefix) || key.includes("..") || key.includes("\\"))) {
    throw new Error("Invalid tenant-scoped erasure object key");
  }
  for (let offset = 0; offset < keys.length; offset += R2_DELETE_BATCH_SIZE) {
    await workspaceBucket.delete(keys.slice(offset, offset + R2_DELETE_BATCH_SIZE));
  }
}

function validatedChunkCount(value: number | null): number {
  if (value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DOCUMENT_CHUNKS) {
    throw new Error("Invalid knowledge document chunk count during erasure");
  }
  return value;
}

/** Delete every project-scoped object and vector for the supplied space documents. */
export async function eraseSpaceKnowledgeResources(
  spaceId: string,
  documents: ErasureDocument[],
  bucket: R2Bucket,
  vectors: VectorizeIndex,
): Promise<void> {
  for (const document of documents) {
    const count = validatedChunkCount(document.chunk_count);
    await deleteR2Prefix(bucket, documentPrefix(spaceId, document.project_id, document.id));
    await bucket.delete(autoragKey(spaceId, document.project_id, document.id));
    for (let start = 0; start < count; start += R2_DELETE_BATCH_SIZE) {
      const end = Math.min(start + R2_DELETE_BATCH_SIZE, count);
      const ids = Array.from({ length: end - start }, (_, offset) => `${document.id}_chunk_${start + offset}`);
      await vectors.deleteByIds(ids);
    }
  }
  // Remove leftovers from partially indexed or pre-project-scope documents as well.
  await deleteR2Prefix(bucket, `kb/${spaceId}/`);
  await deleteR2Prefix(bucket, `autorag/${spaceId}/`);
}
