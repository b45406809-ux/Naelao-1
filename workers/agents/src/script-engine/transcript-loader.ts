/**
 * Bounded cursor paging for the persisted conversation transcript.
 *
 * SpaceDO caps a page at 500 rows. A fixed one-page read therefore silently omitted older history
 * as threads grew. This helper pages from the newest row to the oldest while keeping an explicit
 * message and byte ceiling; callers must treat `undefined` as "too large/unavailable", never as an
 * empty transcript suitable for a successful compaction.
 */

import { readBoundedResponseJson } from "@naelao/http";

export interface TranscriptPageMessage {
  id?: string;
  content: string;
}

export const TRANSCRIPT_PAGE_SIZE = 50;
export const TRANSCRIPT_MAX_MESSAGES = 10_000;
export const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

export async function loadTranscriptPages<T extends TranscriptPageMessage>(
  fetchPage: (beforeId?: string) => Promise<Response>
): Promise<T[] | undefined> {
  const messages: T[] = [];
  let beforeId: string | undefined;
  let bytes = 0;
  const seenIds = new Set<string>();
  try {
    while (true) {
      const response = await fetchPage(beforeId);
      if (!response.ok) return undefined;
      const body = await readBoundedResponseJson<{ data?: T[]; messages?: T[]; cursor_applied?: boolean; has_more?: boolean }>(response, TRANSCRIPT_MAX_BYTES + 256 * 1024);
      if (beforeId && body.cursor_applied === false) return undefined;
      const page = body.data ?? body.messages ?? [];
      if (page.length === 0) {
        // An empty page is only end-of-history when the service agrees. Do not let an
        // inconsistent cursor/provider response silently compact an incomplete transcript.
        if (body.has_more === true) return undefined;
        break;
      }
      for (const message of page) {
        if (message.id) {
          if (seenIds.has(message.id)) return undefined;
          seenIds.add(message.id);
        }
        bytes += new TextEncoder().encode(message.content ?? "").length;
      }
      if (
        messages.length + page.length > TRANSCRIPT_MAX_MESSAGES ||
        bytes > TRANSCRIPT_MAX_BYTES
      )
        return undefined;
      messages.unshift(...page);
      if (body.has_more === false || (page.length < TRANSCRIPT_PAGE_SIZE && body.has_more !== true)) break;
      const oldestId = page[0]?.id;
      if (!oldestId) return undefined;
      beforeId = oldestId;
    }
    return messages;
  } catch {
    return undefined;
  }
}
