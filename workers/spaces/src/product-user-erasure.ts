/** Purge ProductUserDO state before removing the D1 roster used to discover those DOs. */
export async function eraseProductUsersForSpace(
  db: Pick<D1Database, "prepare">,
  tenantId: string,
  spaceId: string,
  eraseUser: (spaceId: string, userId: string) => Promise<void>,
): Promise<number> {
  const owned = await db.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ?")
    .bind(spaceId, tenantId).first<{ id: string }>();
  if (!owned) throw new Error("Erasure space is outside the tenant scope");

  let afterUserId = "";
  let erased = 0;
  for (;;) {
    const { results } = await db.prepare(
      `SELECT end_user_id FROM product_end_users
       WHERE product_space_id = ? AND end_user_id > ? ORDER BY end_user_id LIMIT 100`,
    ).bind(spaceId, afterUserId).all<{ end_user_id: string }>();
    if (results.length === 0) return erased;

    for (const { end_user_id: userId } of results) {
      if (!userId || userId <= afterUserId) throw new Error("Invalid product-user erasure pagination cursor");
      await eraseUser(spaceId, userId);
      await db.prepare("DELETE FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?")
        .bind(spaceId, userId).run();
      afterUserId = userId;
      erased++;
    }
  }
}
