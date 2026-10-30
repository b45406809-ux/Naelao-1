/** Delete external hostname resources before their Space rows are erased. */
export async function eraseSpaceDomainProviders(
  db: Pick<D1Database, "prepare">,
  tenantId: string,
  spaceId: string,
  deleteHostname: (hostnameId: string) => Promise<void>,
): Promise<number> {
  const owned = await db.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ?")
    .bind(spaceId, tenantId).first<{ id: string }>();
  if (!owned) throw new Error("Erasure space is outside the tenant scope");

  let afterId = "";
  let deleted = 0;
  for (;;) {
    const { results } = await db.prepare(
      `SELECT id, provider_hostname_id FROM space_domains
       WHERE tenant_id = ? AND space_id = ? AND id > ? ORDER BY id LIMIT 100`,
    ).bind(tenantId, spaceId, afterId).all<{ id: string; provider_hostname_id: string | null }>();
    if (results.length === 0) return deleted;
    for (const row of results) {
      if (!row.id || row.id <= afterId) throw new Error("Invalid Space-domain erasure pagination cursor");
      if (row.provider_hostname_id) {
        await deleteHostname(row.provider_hostname_id);
        deleted++;
      }
      afterId = row.id;
    }
  }
}
