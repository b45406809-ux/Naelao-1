/** Untrusted, explicitly shared project metadata. Authorization belongs to the host. */
export interface SharedProjectCard {
  projectId: string;
  summary: string;
  capabilities: string[];
  evidence: string[];
  updatedAt: string;
}

export type RequestStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "completed"
  | "cancelled";

export function validateSharedCard(
  input: SharedProjectCard
): SharedProjectCard {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.projectId))
    throw new Error("blackboard_invalid_project");
  const summary = input.summary.trim();
  if (!summary || summary.length > 4000)
    throw new Error("blackboard_invalid_summary");
  const clean = (
    values: string[],
    limit: number,
    maxLength: number
  ): string[] => {
    if (
      !Array.isArray(values) ||
      values.length > limit ||
      values.some(
        (value) =>
          typeof value !== "string" || !value.trim() || value.length > maxLength
      )
    )
      throw new Error("blackboard_invalid_card");
    return [...new Set(values.map((value) => value.trim()))];
  };
  if (!Number.isFinite(Date.parse(input.updatedAt)))
    throw new Error("blackboard_invalid_timestamp");
  return {
    projectId: input.projectId,
    summary,
    capabilities: clean(input.capabilities, 64, 120),
    evidence: clean(input.evidence, 32, 512),
    updatedAt: input.updatedAt,
  };
}

/** A requester cancels; only the receiving project can accept, decline or finish work. */
export function transitionRequest(
  current: RequestStatus,
  action: "accept" | "decline" | "complete" | "cancel",
  actor: "requester" | "receiver"
): RequestStatus {
  if (
    action === "cancel" &&
    actor === "requester" &&
    (current === "pending" || current === "accepted")
  )
    return "cancelled";
  if (actor === "receiver" && current === "pending" && action === "accept")
    return "accepted";
  if (actor === "receiver" && current === "pending" && action === "decline")
    return "declined";
  if (actor === "receiver" && current === "accepted" && action === "complete")
    return "completed";
  throw new Error("blackboard_invalid_transition");
}

/** Matching returns candidates, never authority or a claim that work is complete. */
export function rankSharedCards(
  query: string,
  cards: SharedProjectCard[],
  options: { includeZeroScore?: boolean } = {}
): Array<{ card: SharedProjectCard; score: number }> {
  const terms = new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 3)
  );
  return cards
    .map((card) => {
      const tokens = new Set(
        `${card.summary} ${card.capabilities.join(" ")}`
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
      );
      let score = 0;
      for (const term of terms) if (tokens.has(term)) score++;
      return { card, score };
    })
    .filter((result) => options.includeZeroScore === true || result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.card.projectId.localeCompare(b.card.projectId)
    );
}

/** Apply advisory model scores, preserving lexical order for unscored cards and score ties. */
export function rerankSharedCards(
  candidates: Array<{ card: SharedProjectCard; score: number }>,
  modelScores: ReadonlyMap<string, number>
): Array<{ card: SharedProjectCard; score: number }> {
  const lexicalIndex = new Map(
    candidates.map((candidate, index) => [candidate.card.projectId, index])
  );
  return [...candidates].sort((a, b) => {
    const aScore = modelScores.get(a.card.projectId);
    const bScore = modelScores.get(b.card.projectId);
    if (aScore === undefined && bScore !== undefined) return 1;
    if (aScore !== undefined && bScore === undefined) return -1;
    return (
      (bScore ?? 0) - (aScore ?? 0) ||
      (lexicalIndex.get(a.card.projectId) ?? 0) -
        (lexicalIndex.get(b.card.projectId) ?? 0)
    );
  });
}
