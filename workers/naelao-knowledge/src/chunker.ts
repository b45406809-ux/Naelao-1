export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkText(
  text: string,
  maxTokens = 400,
  overlapTokens = 50
): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    if (currentTokens + sentenceTokens > maxTokens && current.length > 0) {
      chunks.push(current.trim());
      const words = current.split(' ');
      const overlapWords = words.slice(-Math.ceil(overlapTokens / 1.3));
      current = overlapWords.join(' ') + ' ' + sentence;
      currentTokens = estimateTokens(current);
    } else {
      current += (current ? ' ' : '') + sentence;
      currentTokens += sentenceTokens;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

export function extractText(content: string, mimeType: string): string {
  switch (mimeType) {
    case 'text/plain':
      return content;
    case 'text/html':
      return content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    case 'application/json':
      try {
        return JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        return content;
      }
    default:
      return content;
  }
}
