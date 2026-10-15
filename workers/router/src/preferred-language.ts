import {
  type NaelaoJwtClaims,
  normalizePreferredLanguage,
} from "@naelao/types";

/** Load only the authenticated caller's preference; product users resolve within their product tree. */
export async function loadSavedLanguagePreference(
  db: D1Database,
  claims: NaelaoJwtClaims,
  spaceId: string
): Promise<string | null> {
  try {
    if (claims.role === "product_end_user") {
      const row = await db
        .prepare(
          `WITH RECURSIVE ancestors(id, parent_space_id, depth) AS (
           SELECT id, parent_space_id, 0 FROM spaces WHERE id = ?
           UNION ALL
           SELECT s.id, s.parent_space_id, ancestors.depth + 1
           FROM spaces s JOIN ancestors ON s.id = ancestors.parent_space_id
           WHERE ancestors.depth < 8
         )
         SELECT p.preferred_language FROM ancestors a
         JOIN product_end_users p ON p.product_space_id = a.id
         WHERE p.end_user_id = ? AND p.deleted_at IS NULL
         ORDER BY a.depth DESC LIMIT 1`
        )
        .bind(spaceId, claims.sub)
        .first<{ preferred_language: string | null }>();
      return normalizePreferredLanguage(row?.preferred_language);
    }
    if (["owner", "admin", "editor", "viewer"].includes(claims.role)) {
      const row = await db
        .prepare("SELECT preferred_language FROM users WHERE id = ?")
        .bind(claims.sub)
        .first<{ preferred_language: string | null }>();
      return normalizePreferredLanguage(row?.preferred_language);
    }
  } catch {
    // No preference is the safe fallback; the current message remains the language source.
  }
  return null;
}
