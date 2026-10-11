import { deterministicChoice, type FastDecisionGateway } from "@naelao/agent-sdk";

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
  const holder = deterministicChoice(mentions[0] ?? "none", "mention_first_explicit_target");
  return Object.freeze({
    turnHolder: holder.value === "none" ? null : holder.value,
    referents: Object.freeze(mentions.slice(1)),
    mentions: Object.freeze(mentions),
  });
}

/** Typed System One routing constrained to ids the person explicitly mentioned. */
export async function routeMentionsWithSentry(message: string, gateway?: FastDecisionGateway): Promise<MentionRoute> {
  const fallback = routeMentions(message);
  const candidates = [...new Set(fallback.mentions)];
  if (!gateway || candidates.length < 2) return fallback;
  const criteria: Record<string, string> = { none: "No mentioned worker is being directly asked to act." };
  for (const id of candidates) criteria[id] = `@${id} is the primary worker directly asked to act; the other mentions are context.`;
  try {
    const decision = await gateway.choice({
      state: { message, explicit_mentions: candidates },
      instructions: "Choose the one explicit @mention that owns this turn. Never infer an unmentioned worker. Choose none when all mentions are contextual.",
      criteria,
      policyCode: "mention_primary_turn_holder",
    });
    if ((decision.confidence ?? 0) < 0.75) return fallback;
    const turnHolder = decision.value === "none" ? null : decision.value;
    if (turnHolder !== null && !candidates.includes(turnHolder)) return fallback;
    return Object.freeze({
      turnHolder,
      referents: Object.freeze(fallback.mentions.filter((id) => id !== turnHolder)),
      mentions: fallback.mentions,
    });
  } catch {
    return fallback;
  }
}
