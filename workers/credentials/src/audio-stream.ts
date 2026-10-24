/** Binary streaming egress for the host's fixed OpenRouter speech endpoint. Keep enough trailing
 * bytes to detect credentials split across chunks before any part of the credential is emitted. */
export function checkedAudioStream(options: {
  source: ReadableStream<Uint8Array>;
  secrets: readonly string[];
  maxBytes?: number;
  completed(bytes: Uint8Array): Promise<void>;
  interrupted(): Promise<void>;
}): ReadableStream<Uint8Array> {
  const needles = options.secrets.filter(Boolean).map(s => new TextEncoder().encode(s));
  const hold = Math.max(0, ...needles.map(n => n.length - 1));
  const reader = options.source.getReader();
  const chunks: Uint8Array[] = [];
  let tail = new Uint8Array(), total = 0, ended = false, chunkCount = 0;
  // KMP makes scanning independent of the secret length and adversarial repeated prefixes.
  const matchers = needles.map(needle => {
    const table = new Uint32Array(needle.length);
    for (let i = 1, p = 0; i < needle.length; i++) {
      while (p && needle[i] !== needle[p]) p = table[p - 1]!;
      if (needle[i] === needle[p]) p++;
      table[i] = p;
    }
    return { needle, table, matched: 0 };
  });
  const fail = async () => {
    if (ended) return;
    ended = true;
    await reader.cancel().catch(() => {});
    await options.interrupted().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (ended) return;
          if (done) {
            const bytes = new Uint8Array(total); let offset = 0;
            for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
            await options.completed(bytes);
            ended = true;
            if (tail.length) controller.enqueue(tail);
            controller.close(); reader.releaseLock(); return;
          }
          if (++chunkCount > 32768) throw new Error("audio_chunk_limit");
          total += value.length;
          if (total > (options.maxBytes ?? 8 * 1024 * 1024)) throw new Error("audio_response_too_large");
          for (const m of matchers) for (const byte of value) {
            while (m.matched && byte !== m.needle[m.matched]) m.matched = m.table[m.matched - 1]!;
            if (byte === m.needle[m.matched]) m.matched++;
            if (m.matched === m.needle.length) throw new Error("audio_credential_echo_blocked");
          }
          chunks.push(value.slice());
          const merged = new Uint8Array(tail.length + value.length); merged.set(tail); merged.set(value, tail.length);
          const emitted = Math.max(0, merged.length - hold);
          tail = merged.slice(emitted);
          if (emitted) { controller.enqueue(merged.slice(0, emitted)); return; }
        }
      } catch (error) { await fail(); controller.error(error); }
    },
    async cancel() { await fail(); },
  });
}
export function isOpenRouterSpeechStream(url: string, method: string, responseMode: unknown): boolean {
  return responseMode === "audio" && method === "POST" && url === "https://openrouter.ai/api/v1/audio/speech";
}
