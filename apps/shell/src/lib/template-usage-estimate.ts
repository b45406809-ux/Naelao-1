export interface TemplateExpectedUsageV1 {
  conversations_per_month: number;
  interactions_per_conversation: number;
}

export type TemplateExpectedUsageInput =
  | { valid: true; usage: TemplateExpectedUsageV1 | null; message: null }
  | { valid: false; usage: null; message: string };

export function parseTemplateExpectedUsageInput(conversationsText: string, interactionsText: string): TemplateExpectedUsageInput {
  const conversationsInput = conversationsText.trim();
  const interactionsInput = interactionsText.trim();
  if (!conversationsInput && !interactionsInput) return { valid: true, usage: null, message: null };
  const conversations = Number(conversationsInput);
  const interactions = Number(interactionsInput);
  if (!conversationsInput || !interactionsInput
    || !Number.isSafeInteger(conversations) || conversations < 1 || conversations > 1_000_000
    || !Number.isSafeInteger(interactions) || interactions < 1 || interactions > 500) {
    return { valid: false, usage: null,
      message: "Enter 1–1,000,000 conversations per month and 1–500 interactions per conversation." };
  }
  return { valid: true, usage: { conversations_per_month: conversations, interactions_per_conversation: interactions }, message: null };
}

export function createLatestRequestFence() {
  let generation = 0;
  return {
    issue: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
    invalidate: () => { generation += 1; },
  };
}
