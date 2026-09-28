import type { SubagentContext, SubagentVerbResult } from "@naelao/agent-sdk";
export interface FileMapEntry { path: string; bytes: number }
export interface AtomicChunk { id: string; task: string; paths: string[] }
export interface ChunkedWorkflowAdapters {
  context: SubagentContext;
  spawn(chunk: AtomicChunk, context: SubagentContext): Promise<SubagentVerbResult>;
  accumulate(input: { branch: string; taskId: string; modifiedFiles: string[]; chunkId: string }): Promise<{ commitId: string }>;
}
export async function compressedRepositoryMap(ctx: SubagentContext): Promise<FileMapEntry[]> {
  const files = (await ctx.fs.glob("**/*")).sort();
  return Promise.all(files.map(async (path) => ({ path, bytes: new TextEncoder().encode(await ctx.fs.read(path)).byteLength })));
}
export function partitionAtomicChunks(task: string, map: FileMapEntry[], chunkSize = 12): AtomicChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize must be a positive integer");
  const chunks: AtomicChunk[] = [];
  for (let offset = 0; offset < map.length; offset += chunkSize) {
    const paths = map.slice(offset, offset + chunkSize).map((entry) => entry.path);
    chunks.push({ id: `chunk-${chunks.length + 1}`, task: `${task}\nImplement only this atomic file set:\n${paths.join("\n")}`, paths });
  }
  return chunks.length ? chunks : [{ id: "chunk-1", task, paths: [] }];
}
export async function executeChunkedSubagentWorkflow(taskId: string, task: string, adapters: ChunkedWorkflowAdapters) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) throw new Error("Invalid task id");
  const map = await adapters.context.step.do("build-compressed-repository-map", () => compressedRepositoryMap(adapters.context));
  const branch = `task/${taskId}/accumulator`;
  const results = [];
  for (const chunk of partitionAtomicChunks(task, map)) {
    const result = await adapters.context.step.do(`subagent-${chunk.id}`, () => adapters.spawn(chunk, adapters.context));
    if (!result.ok) throw new Error(result.error ?? `${chunk.id} failed`);
    const commit = result.modifiedFiles.length ? await adapters.context.step.do(`accumulate-${chunk.id}`, () => adapters.accumulate({ branch, taskId, modifiedFiles: result.modifiedFiles, chunkId: chunk.id })) : undefined;
    results.push({ chunkId: chunk.id, ...result, ...(commit ? { commitId: commit.commitId } : {}) });
  }
  return { ok: true, branch, repositoryMap: map, chunks: results };
}
