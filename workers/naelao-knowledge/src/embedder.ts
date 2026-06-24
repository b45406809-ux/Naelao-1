export async function embedText(text: string, ai: Ai): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data: number[][] };
  return result.data[0] ?? [];
}

export async function upsertChunks(
  vectorize: VectorizeIndex,
  docId: string,
  spaceId: string,
  chunks: string[],
  ai: Ai
): Promise<void> {
  const vectors: VectorizeVector[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const values = await embedText(chunk, ai);
    vectors.push({
      id: `${docId}:chunk:${i}`,
      values,
      metadata: { spaceId, docId, chunkIndex: i, text: chunk.slice(0, 500) },
    });
  }

  for (let i = 0; i < vectors.length; i += 100) {
    await vectorize.upsert(vectors.slice(i, i + 100));
  }
}

export async function deleteDocChunks(
  vectorize: VectorizeIndex,
  docId: string,
  chunkCount: number
): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < chunkCount; i++) {
    ids.push(`${docId}:chunk:${i}`);
  }

  for (let i = 0; i < ids.length; i += 1000) {
    await vectorize.deleteByIds(ids.slice(i, i + 1000));
  }
}
