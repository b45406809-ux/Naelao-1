export interface ToolExecutorEnv {
  NAELAO_WORKSPACE: R2Bucket;
  NAELAO_THREADS_DO: DurableObjectNamespace;
  NAELAO_MCP_HUB: Fetcher;
  NAELAO_JWT_SECRET: string;
}

export interface RunContext {
  runId: string;
  spaceId: string;
  agentId: string;
  walEntryId?: string;
}

async function atomicAppend(r2: R2Bucket, key: string, content: string, retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    const obj = await r2.get(key);
    const existing = obj ? await obj.text() : '';
    const etag = obj?.etag;
    const result = await r2.put(key, existing + content, etag ? { onlyIf: { etagMatches: etag } } : {});
    if (result) return;
  }
  throw new Error('append_to_file: concurrent modification, max retries exceeded');
}

async function handleReadFile(args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv): Promise<unknown> {
  const path = args['path'] as string;
  const key = `spaces/${ctx.spaceId}/${path}`;
  const obj = await env.NAELAO_WORKSPACE.get(key);
  if (!obj) throw new Error('file_not_found: ' + path);
  const content = await obj.text();
  return { content, size: obj.size };
}

async function handleWriteFile(args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv): Promise<unknown> {
  const path = args['path'] as string;
  const content = args['content'] as string;
  const key = `spaces/${ctx.spaceId}/${path}`;
  await env.NAELAO_WORKSPACE.put(key, content);
  return { ok: true, bytes: content.length };
}

async function handleAppendFile(args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv): Promise<unknown> {
  const path = args['path'] as string;
  const content = args['content'] as string;
  const key = `spaces/${ctx.spaceId}/${path}`;
  await atomicAppend(env.NAELAO_WORKSPACE, key, content);
  return { ok: true };
}

async function handleListFiles(args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv): Promise<unknown> {
  const path = (args['path'] as string | undefined) ?? '';
  const prefix = `spaces/${ctx.spaceId}/${path}`;
  const listed = await env.NAELAO_WORKSPACE.list({ prefix });
  return {
    files: listed.objects.map(o => ({
      name: o.key.slice(prefix.length),
      size: o.size,
      updatedAt: o.uploaded.toISOString(),
    })),
  };
}

async function handleDeleteFile(args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv): Promise<unknown> {
  const path = args['path'] as string;
  const key = `spaces/${ctx.spaceId}/${path}`;
  await env.NAELAO_WORKSPACE.delete(key);
  return { ok: true };
}

async function handleWebSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = args['query'] as string;
  const resp = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
  if (!resp.ok) return { results: [] };
  const data = await resp.json() as { RelatedTopics?: Array<{ Text?: string; FirstURL?: string }> };
  return {
    results: (data.RelatedTopics ?? []).slice(0, args['numResults'] as number ?? 5).map(t => ({
      title: t.Text ?? '',
      url: t.FirstURL ?? '',
    })),
  };
}

async function handleCreateThread(args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv): Promise<unknown> {
  const title = args['title'] as string | undefined;
  const threadId = crypto.randomUUID();
  const do_ = env.NAELAO_THREADS_DO.get(env.NAELAO_THREADS_DO.idFromName('thread:' + threadId));
  await do_.fetch(new Request('http://do/threads/create', {
    method: 'POST',
    body: JSON.stringify({ spaceId: ctx.spaceId, title }),
  }));
  return { threadId };
}

async function handleAddMessage(args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv): Promise<unknown> {
  const threadId = args['threadId'] as string;
  const content = args['content'] as string;
  const do_ = env.NAELAO_THREADS_DO.get(env.NAELAO_THREADS_DO.idFromName('thread:' + threadId));
  const resp = await do_.fetch(new Request('http://do/messages/add', {
    method: 'POST',
    body: JSON.stringify({ threadId, role: 'assistant', content }),
  }));
  const data = await resp.json<{ data: { message: { id: string } } }>();
  return { messageId: data.data.message.id };
}

const BUILT_IN_TOOLS: Record<string, (args: Record<string, unknown>, ctx: RunContext, env: ToolExecutorEnv) => Promise<unknown>> = {
  read_file: handleReadFile,
  write_file: handleWriteFile,
  append_to_file: handleAppendFile,
  list_files: handleListFiles,
  delete_file: handleDeleteFile,
  web_search: handleWebSearch,
  create_thread: handleCreateThread,
  add_message: handleAddMessage,
};

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  runContext: RunContext,
  env: ToolExecutorEnv
): Promise<unknown> {
  const builtIn = BUILT_IN_TOOLS[name];
  if (builtIn) {
    return builtIn(args, runContext, env);
  }

  const idempotencyKey = runContext.walEntryId
    ? `${runContext.runId}:${runContext.walEntryId}`
    : runContext.runId;

  const resp = await env.NAELAO_MCP_HUB.fetch(
    new Request('https://placeholder/v1/tools/' + runContext.spaceId + '/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Naelao-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        toolName: name,
        args,
        agentId: runContext.agentId,
        runId: runContext.runId,
        walEntryId: runContext.walEntryId ?? '',
      }),
    })
  );

  return resp.json();
}
