/**
 * Bounded cursor paging for the persisted conversation transcript.
 *
 * SpaceDO caps a page at 500 rows. A fixed one-page read therefore silently omitted older history
 * as threads grew. This helper pages from the newest row to the oldest while keeping an explicit
 * message and byte ceiling; callers must treat `undefined` as "too large/unavailable", never as an
 * empty transcript suitable for a successful compaction.
 */

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
  try {
    while (true) {
      const response = await fetchPage(beforeId);
      if (!response.ok) return undefined;
      const body = (await response.json()) as { data?: T[]; messages?: T[] };
      const page = body.data ?? body.messages ?? [];
      if (page.length === 0) break;
      for (const message of page)
        bytes += new TextEncoder().encode(message.content ?? "").length;
      if (
        messages.length + page.length > TRANSCRIPT_MAX_MESSAGES ||
        bytes > TRANSCRIPT_MAX_BYTES
      )
        return undefined;
      messages.unshift(...page);
      if (page.length < TRANSCRIPT_PAGE_SIZE) break;
      const oldestId = page[0]?.id;
      if (!oldestId) return undefined;
      beforeId = oldestId;
    }
    return messages;
  } catch {
    return undefined;
  }
}
