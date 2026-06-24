export type FiberStatus = 'idle' | 'running' | 'waiting_tool' | 'paused' | 'done' | 'error';

export interface Fiber {
  id: string;
  runId: string;
  status: FiberStatus;
  agentId: string;
  spaceId: string;
  threadId: string;
  model: string;
  systemPrompt: string;
  toolBudget: number;
  toolsUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCallId?: string;
  createdAt: string;
  seq: number;
}

export function createFiber(
  params: Partial<Fiber> & { runId: string; spaceId: string }
): Fiber {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    runId: params.runId,
    status: 'idle',
    agentId: params.agentId ?? '',
    spaceId: params.spaceId,
    threadId: params.threadId ?? '',
    model: params.model ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    systemPrompt: params.systemPrompt ?? '',
    toolBudget: params.toolBudget ?? 50,
    toolsUsed: params.toolsUsed ?? 0,
    createdAt: params.createdAt ?? now,
    updatedAt: params.updatedAt ?? now,
  };
}

export function updateFiberStatus(fiber: Fiber, status: FiberStatus): Fiber {
  return { ...fiber, status, updatedAt: new Date().toISOString() };
}

export function isTerminal(fiber: Fiber): boolean {
  return fiber.status === 'done' || fiber.status === 'error';
}

export function hasToolBudget(fiber: Fiber): boolean {
  return fiber.toolsUsed < fiber.toolBudget;
}

export function truncateMessages(messages: Message[], targetCount: number): Message[] {
  if (messages.length <= targetCount) return messages;
  const first = messages[0];
  if (!first) return messages.slice(-(targetCount));
  return [first, ...messages.slice(-(targetCount - 1))];
}

export function buildSystemPrompt(
  basePrompt: string,
  context: { spaceId: string; agentId: string; tools: string[] }
): string {
  return `${basePrompt}\n\nSpace ID: ${context.spaceId}\nAgent ID: ${context.agentId}\nAvailable tools: ${context.tools.join(', ')}`;
}
