export interface ResolvedMentions {
  primaryAgentId: string | null;
  referentAgentIds: string[];
}

/**
 * Parses a chat message to determine the primary turn-holder and any referent agents.
 * 
 * Rules:
 * 1. The first valid @mention is the primary turn-holder.
 * 2. Possessives (e.g., @DevBot's) are NEVER primary turn-holders; they are always referents.
 * 3. Subsequent mentions are referents.
 */
export function resolveTargetAgent(text: string, activeRoster: string[] = []): ResolvedMentions {
  // Regex matches @AgentName, ignoring trailing punctuation, capturing optional 's
  const mentionRegex = /(?<=^|\s)@([a-zA-Z0-9_-]+)('s)?\b/g;
  const matches = [...text.matchAll(mentionRegex)];

  if (matches.length === 0) {
    return { primaryAgentId: null, referentAgentIds: [] };
  }

  let primaryAgentId: string | null = null;
  const referentAgentIds: Set<string> = new Set();
  const rosterLower = activeRoster.map((r) => r.toLowerCase());

  for (const match of matches) {
    const agentName = match[1].toLowerCase();
    const isPossessive = !!match[2];

    // Check if the agent is actually in the project roster (prevent hallucinated mentions)
    // If activeRoster is empty, we bypass the check for system-level routing.
    if (rosterLower.length > 0 && !rosterLower.includes(agentName)) {
      continue;
    }

    if (!primaryAgentId && !isPossessive) {
      primaryAgentId = agentName;
    } else {
      // Don't add the primary agent to its own referent list
      if (agentName !== primaryAgentId) {
        referentAgentIds.add(agentName);
      }
    }
  }

  return { 
    primaryAgentId, 
    referentAgentIds: Array.from(referentAgentIds) 
  };
}
