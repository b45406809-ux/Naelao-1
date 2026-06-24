import type { FinishReason } from '../../naelao-auth/src/jwt';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallDelta[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallDelta {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChunk {
  delta: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'timeout' | null;
  toolCalls?: ToolCallDelta[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface RemoteLoopOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  spaceId: string;
  runId: string;
  togetherAiService: Fetcher;
  timeoutMs?: number;
}

export async function* streamCompletion(
  options: RemoteLoopOptions
): AsyncGenerator<StreamChunk> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('stream_timeout'), options.timeoutMs ?? 25_000);

  try {
    const resp = await options.togetherAiService.fetch(
      new Request('https://placeholder/v1/ai/chat', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Space-Id': options.spaceId,
          'X-Run-Id': options.runId,
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          tools: options.tools,
          stream: true,
          max_tokens: 4096,
        }),
      })
    );

    if (!resp.ok || !resp.body) {
      yield { delta: '', finishReason: 'stop', toolCalls: undefined };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls: ToolCallDelta[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;

        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string; tool_calls?: ToolCallDelta[]; finish_reason?: string };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
          };

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta?.content ?? '';
          const finishReason = (choice.finish_reason ?? choice.delta?.finish_reason) as StreamChunk['finishReason'];

          if (choice.delta?.tool_calls) {
            toolCalls.push(...choice.delta.tool_calls);
          }

          yield {
            delta,
            finishReason: finishReason ?? null,
            toolCalls: finishReason === 'tool_calls' ? toolCalls : undefined,
            usage: chunk.usage
              ? { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens }
              : undefined,
          };
        } catch {
          // skip malformed SSE line
        }
      }
    }
  } catch (e) {
    if (ac.signal.aborted) {
      yield { delta: '', finishReason: 'timeout', toolCalls: undefined };
    } else {
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function runRemoteLoop(
  options: RemoteLoopOptions,
  onChunk: (chunk: StreamChunk) => void
): Promise<'stop' | 'tool_calls' | 'max_tokens' | 'error' | 'timeout' | 'cancelled'> {
  let finishReason: StreamChunk['finishReason'] = null;
  for await (const chunk of streamCompletion(options)) {
    onChunk(chunk);
    if (chunk.finishReason !== null) {
      finishReason = chunk.finishReason;
    }
  }
  if (!finishReason) return 'stop';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'timeout') return 'timeout';
  return finishReason as 'stop' | 'tool_calls';
}
