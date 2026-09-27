export interface MentionRoute {
  turnHolder: string | null;
  referents: readonly string[];
  mentions: readonly string[];
}

// Mentions are deliberately conservative: punctuation terminates an id and email addresses do
// not become accidental agent invocations. Only the first token is executable authority.
const MENTION = /(^|\s)@([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})\b/g;

export function routeMentions(message: string): MentionRoute {
  const mentions: string[] = [];
  for (const match of message.matchAll(MENTION)) {
    const id = match[2];
    if (id) mentions.push(id);
  }
  return Object.freeze({
    turnHolder: mentions[0] ?? null,
    referents: Object.freeze(mentions.slice(1)),
    mentions: Object.freeze(mentions),
  });
}
