/** Delete external custom-hostname resources before their D1 service rows are erased. */
export async function eraseBusinessServiceProviders(
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
      `SELECT id, cf_hostname_id FROM business_services
       WHERE tenant_id = ? AND space_id = ? AND id > ? ORDER BY id LIMIT 100`,
    ).bind(tenantId, spaceId, afterId).all<{ id: string; cf_hostname_id: string | null }>();
    if (results.length === 0) return deleted;
    for (const row of results) {
      if (!row.id || row.id <= afterId) throw new Error("Invalid business-service erasure pagination cursor");
      if (row.cf_hostname_id) {
        await deleteHostname(row.cf_hostname_id);
        deleted++;
      }
      afterId = row.id;
    }
  }
}
