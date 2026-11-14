export interface TemplateExpectedUsageV1 {
  conversations_per_month: number;
  interactions_per_conversation: number;
  managed_model_id?: string;
  model_calls_per_interaction?: number;
  model_credits_budget_per_month?: number;
}

export type TemplateExpectedUsageInput =
  | { valid: true; usage: TemplateExpectedUsageV1 | null; message: null }
  | { valid: false; usage: null; message: string };

export function parseTemplateExpectedUsageInput(conversationsText: string, interactionsText: string,
  modelId = "", modelCallsText = "", modelCreditsBudgetText = ""): TemplateExpectedUsageInput {
  const conversationsInput = conversationsText.trim();
  const interactionsInput = interactionsText.trim();
  const modelIdInput = modelId.trim();
  const modelCallsInput = modelCallsText.trim();
  const modelCreditsBudgetInput = modelCreditsBudgetText.trim();
  if (modelIdInput && (!modelCallsInput || !Number.isSafeInteger(Number(modelCallsInput))
    || Number(modelCallsInput) < 1 || Number(modelCallsInput) > 10)) {
    return { valid: false, usage: null, message: "Choose 1–10 managed-model calls per interaction." };
  }
  if (modelCreditsBudgetInput && (!modelIdInput || !Number.isSafeInteger(Number(modelCreditsBudgetInput))
    || Number(modelCreditsBudgetInput) < 1)) {
    return { valid: false, usage: null, message: "Enter a positive whole-number planning budget and select a managed model." };
  }
  if (!conversationsInput && !interactionsInput) return { valid: true, usage: null, message: null };
  const conversations = Number(conversationsInput);
  const interactions = Number(interactionsInput);
  if (!conversationsInput || !interactionsInput
    || !Number.isSafeInteger(conversations) || conversations < 1 || conversations > 1_000_000
    || !Number.isSafeInteger(interactions) || interactions < 1 || interactions > 500) {
    return { valid: false, usage: null,
      message: "Enter 1–1,000,000 conversations per month and 1–500 interactions per conversation." };
  }
  return { valid: true, usage: { conversations_per_month: conversations, interactions_per_conversation: interactions,
    ...(modelIdInput ? { managed_model_id: modelIdInput, model_calls_per_interaction: Number(modelCallsInput),
      ...(modelCreditsBudgetInput ? { model_credits_budget_per_month: Number(modelCreditsBudgetInput) } : {}) } : {}) }, message: null };
}

export function createLatestRequestFence() {
  let generation = 0;
  return {
    issue: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
    invalidate: () => { generation += 1; },
  };
}
