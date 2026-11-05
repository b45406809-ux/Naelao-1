import {
  type NaelaoJwtClaims,
  normalizePreferredLanguage,
} from "@naelao/types";

/** Load only the authenticated caller's preference using the Space's explicit Product link. */
export async function loadSavedLanguagePreference(
  db: D1Database,
  claims: NaelaoJwtClaims,
  spaceId: string
): Promise<string | null> {
  try {
    if (claims.role === "product_end_user") {
      const row = await db
        .prepare(
          `SELECT p.preferred_language FROM spaces s
           JOIN product_end_users p ON p.product_space_id = s.product_id
           WHERE s.id = ? AND p.end_user_id = ? AND p.deleted_at IS NULL AND p.suspended_at IS NULL LIMIT 1`
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
