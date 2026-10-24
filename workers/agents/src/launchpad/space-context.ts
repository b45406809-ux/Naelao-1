/** Small generic Space context supplied to agent runs. Template IDs, business offerings, and
 * commercial pricing are intentionally excluded; task-specific knowledge comes from authorized
 * Space/project knowledge bases and connected tools. */

export interface SpaceContext {
  name: string;
  setup_status: string;
  setup_note?: string;
}

export interface SpaceConfigForContext {
  onboarding?: { status?: unknown } | undefined;
}

const COMPLETE = "complete";

export function resolveSpaceContext(input: {
  spaceName?: string | null;
  config: SpaceConfigForContext | null | undefined;
}): SpaceContext {
  const name = (input.spaceName ?? "").trim() || "this Naelao Space";
  const rawStatus = input.config?.onboarding?.status;
  const setupStatus = typeof rawStatus === "string" && rawStatus.trim() ? rawStatus.trim() : COMPLETE;
  const context: SpaceContext = { name, setup_status: setupStatus };
  if (setupStatus !== COMPLETE) {
    context.setup_note = "Space setup is incomplete. Explain what is needed only when it affects the requested task; continue helping with everything that can already be done.";
  }
  return context;
}

export function parseSpaceConfigForContext(configJson: string | null | undefined): SpaceConfigForContext {
  try {
    const parsed = JSON.parse(configJson || "{}") as SpaceConfigForContext;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

export interface SpaceNameAndConfigQuery {
  prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

export async function loadSpaceContext(
  db: SpaceNameAndConfigQuery | undefined, spaceId: string, tenantId: string
): Promise<SpaceContext | undefined> {
  if (!db || !spaceId) return undefined;
  try {
    const row = await db.prepare("SELECT name, config_json FROM spaces WHERE id = ? AND tenant_id = ?")
      .bind(spaceId, tenantId).first<{ name: string | null; config_json: string | null }>();
    if (!row) return undefined;
    return resolveSpaceContext({ spaceName: row.name, config: parseSpaceConfigForContext(row.config_json) });
  } catch { return undefined; }
}
