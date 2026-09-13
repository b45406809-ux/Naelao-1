/** Cohere Parse 5 ingestion boundary. Parse output, rather than local OCR, is authoritative. */
export interface Parse5Env { COHERE_API_KEY?: string; }
export interface Parse5Result { markdown: string; requestId?: string; }

const PARSE_URL = "https://api.cohere.com/v2/parse";

/** Sends the original R2 bytes without a lossy text/OCR conversion. */
export async function parseR2DocumentWithParse5(
  env: Parse5Env,
  bytes: ArrayBuffer,
  contentType: string,
  fileName: string,
): Promise<Parse5Result> {
  if (!env.COHERE_API_KEY) throw new Error("Cohere Parse 5 is not configured");
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: contentType }), fileName);
  form.set("model", "parse-v5.0");
  const response = await fetch(PARSE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.COHERE_API_KEY}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Cohere Parse 5 failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { markdown?: string; content?: { markdown?: string }; id?: string };
  const markdown = payload.markdown ?? payload.content?.markdown;
  if (!markdown) throw new Error("Cohere Parse 5 returned no Markdown");
  return { markdown, requestId: payload.id };
}
