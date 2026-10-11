export function airGappedOnlyFromConfig(configJson: string | null | undefined): boolean {
  try {
    const config = JSON.parse(configJson || "{}") as {
      compliance?: { airGappedOnly?: boolean };
      productConfig?: { compliance?: { airGappedOnly?: boolean } };
    };
    return config.compliance?.airGappedOnly === true || config.productConfig?.compliance?.airGappedOnly === true;
  } catch {
    return true;
  }
}

/** Fail-closed check for any worker about to cross a network/service egress boundary. */
export async function isSpaceNetworkEgressDenied(db: D1Database, spaceId: string): Promise<boolean> {
  if (!spaceId) return true;
  try {
    const row = await db.prepare(
      "SELECT config_json FROM spaces WHERE id = ? AND status != 'deleted'",
    ).bind(spaceId).first<{ config_json: string | null }>();
    if (!row) return true;
    return airGappedOnlyFromConfig(row.config_json);
  } catch {
    // A malformed policy or unavailable policy store can never authorize egress.
    return true;
  }
}
