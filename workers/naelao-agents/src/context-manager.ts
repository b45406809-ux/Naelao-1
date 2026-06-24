import type { Message } from './fiber';

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': 128000,
  'Qwen/Qwen2.5-72B-Instruct-Turbo': 128000,
  'deepseek-ai/DeepSeek-R1': 65536,
  default: 32768,
};

export function getContextLimit(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] ?? MODEL_CONTEXT_LIMITS['default']!;
}

export function estimateMessageTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function fitMessagesToBudget(
  messages: Message[],
  model: string,
  reserveForOutput = 4096
): Message[] {
  const limit = getContextLimit(model) - reserveForOutput;
  if (estimateMessageTokens(messages) <= limit) return messages;

  let lo = 1;
  let hi = messages.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = messages.length > mid
      ? [messages[0]!, ...messages.slice(-mid)]
      : messages;
    if (estimateMessageTokens(candidate) <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (messages.length <= lo + 1) return messages;
  return [messages[0]!, ...messages.slice(-lo)];
}

export interface ContextWindow {
  messages: Message[];
  estimatedInputTokens: number;
  truncated: boolean;
  droppedCount: number;
}

export function buildContextWindow(
  systemPrompt: string,
  history: Message[],
  model: string
): ContextWindow {
  const systemMessage: Message = {
    id: 'system',
    threadId: '',
    role: 'system',
    content: systemPrompt,
    createdAt: new Date().toISOString(),
    seq: 0,
  };

  const allMessages = [systemMessage, ...history];
  const fitted = fitMessagesToBudget(allMessages, model);
  const truncated = fitted.length < allMessages.length;
  const droppedCount = allMessages.length - fitted.length;

  return {
    messages: fitted,
    estimatedInputTokens: estimateMessageTokens(fitted),
    truncated,
    droppedCount,
  };
}
