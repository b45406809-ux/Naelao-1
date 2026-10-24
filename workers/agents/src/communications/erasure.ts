import type { AgentsEnv } from "../index.js";
export async function eraseCommunicationIdentities(
  env: AgentsEnv,
  tenantId: string,
  spaceId: string,
  userId?: string,
  includeChildren = false
) {
  const owned = await env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id=? AND tenant_id=?"
  )
    .bind(spaceId, tenantId)
    .first();
  if (!owned) throw new Error("communication_erasure_scope_mismatch");
  for (;;) {
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT id,space_id FROM assistant_communication_identities WHERE tenant_id=? AND ${includeChildren ? "space_id IN (SELECT id FROM spaces WHERE id=? OR parent_space_id=?)" : "space_id=?"} ${userId ? "AND project_id IS NULL AND owner_user_id=?" : ""} ORDER BY id LIMIT 100`
    )
      .bind(
        tenantId,
        spaceId,
        ...(includeChildren ? [spaceId] : []),
        ...(userId ? [userId] : [])
      )
      .all<{ id: string; space_id: string }>();
    if (!results.length) break;
    if (!env.SCRIPTS_R2)
      throw new Error("communication_storage_erasure_unavailable");
    for (const identity of results) {
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_communication_identities SET status='erasing' WHERE id=? AND tenant_id=?"
      )
        .bind(identity.id, tenantId)
        .run();
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await env.SCRIPTS_R2.list({
          prefix: `spaces/${identity.space_id}/communications/${identity.id}/`,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (page.objects.length)
          await env.SCRIPTS_R2.delete(page.objects.map((o) => o.key));
        if (!page.truncated) break;
        if (!page.cursor || seen.has(page.cursor))
          throw new Error("communication_erasure_cursor_invalid");
        seen.add(page.cursor);
        cursor = page.cursor;
      } while (cursor);
      await env.PLATFORM_DB.prepare(
        "DELETE FROM assistant_communication_identities WHERE id=? AND tenant_id=?"
      )
        .bind(identity.id, tenantId)
        .run();
    }
  }
  if (userId)
    await env.PLATFORM_DB.prepare(
      "DELETE FROM assistant_communication_controllers WHERE user_id=? AND identity_id IN (SELECT id FROM assistant_communication_identities WHERE tenant_id=?)"
    )
      .bind(userId, tenantId)
      .run();
}
export async function sweepAssistantCommunications(env: AgentsEnv) {
  await env.PLATFORM_DB.prepare(
    "DELETE FROM assistant_mail_ingress_usage WHERE day<date('now','-35 days')"
  ).run();
  await env.PLATFORM_DB.prepare(
    "UPDATE assistant_verification_waits SET secret_json=NULL,status='expired' WHERE expires_at<=? AND status IN ('waiting','received','ambiguous')"
  )
    .bind(new Date().toISOString())
    .run();
  await env.PLATFORM_DB.prepare(
    "DELETE FROM assistant_command_tokens WHERE expires_at<=?"
  )
    .bind(new Date().toISOString())
    .run();
  if (!env.SCRIPTS_R2) return;
  const { results } = await env.PLATFORM_DB.prepare(
    "SELECT m.id,m.body_key,i.space_id,i.id AS identity_id FROM assistant_communication_messages m JOIN assistant_communication_identities i ON i.id=m.identity_id WHERE m.created_at<datetime('now','-30 days') ORDER BY m.created_at,m.id LIMIT 200"
  ).all<{
    id: string;
    body_key: string;
    space_id: string;
    identity_id: string;
  }>();
  for (const row of results) {
    const prefix = `spaces/${row.space_id}/communications/${row.identity_id}/`;
    if (row.body_key !== prefix + row.id + ".json")
      throw new Error("communication_retention_scope_mismatch");
    const attachments = await env.SCRIPTS_R2.list({
      prefix: prefix + row.id + "-a",
      limit: 20,
    });
    if (attachments.truncated)
      throw new Error("communication_attachment_count_invalid");
    await env.SCRIPTS_R2.delete([
      row.body_key,
      ...attachments.objects.map((o) => o.key),
    ]);
    await env.PLATFORM_DB.prepare(
      "DELETE FROM assistant_communication_messages WHERE id=? AND identity_id=?"
    )
      .bind(row.id, row.identity_id)
      .run();
  }
}
