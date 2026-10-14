export const FOUNDRY_CHANNEL_GOAL_LIMIT = 10_000;

export interface FoundryChannelCommand {
  sourceSpaceId: string;
  agentId: string;
  goal: string;
}

export interface FoundryChannelEventStore {
  exec(query: string, ...values: unknown[]): { rowsWritten: number };
}

export function releaseFoundryChannelEvent(
  store: FoundryChannelEventStore,
  input: { spaceId: string; channel: "whatsapp" | "telegram"; senderId: string; externalId?: string | null },
): void {
  if (!input.externalId) return;
  store.exec("DELETE FROM foundry_channel_events WHERE space_id=? AND channel=? AND sender_id=? AND external_id=?",
    input.spaceId, input.channel, input.senderId, input.externalId);
}

/** Claim provider delivery IDs before launching work so webhook replays cannot duplicate runs. */
export function claimFoundryChannelEvent(
  store: FoundryChannelEventStore,
  input: { spaceId: string; channel: "whatsapp" | "telegram"; senderId: string; externalId?: string | null },
  now = Date.now(),
): boolean {
  if (!input.externalId) return true;
  const claimed = store.exec(
    "INSERT OR IGNORE INTO foundry_channel_events(space_id,channel,sender_id,external_id,claimed_at) VALUES(?,?,?,?,?)",
    input.spaceId, input.channel, input.senderId, input.externalId, now,
  );
  store.exec("DELETE FROM foundry_channel_events WHERE claimed_at < ?", now - 30 * 24 * 60 * 60 * 1000);
  return claimed.rowsWritten > 0;
}

/** Channel command syntax: `FOUNDRY RUN <source-space-id> <worker-id>` on one line,
 * followed by the worker's prompt. Capability tokens are accepted only in Foundry UI. */
export function parseFoundryChannelCommand(text: string): FoundryChannelCommand | null {
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  const header = text.slice(0, newline).trim();
  const match = /^FOUNDRY\s+RUN\s+([A-Za-z0-9._:-]{1,160})\s+([A-Za-z0-9._:-]{1,160})$/i.exec(header);
  const goal = text.slice(newline + 1).trim();
  if (!match || !goal || goal.length > FOUNDRY_CHANNEL_GOAL_LIMIT) return null;
  return { sourceSpaceId: match[1]!, agentId: match[2]!, goal };
}
