import { readBoundedResponseJson } from "@naelao/http";

export interface ParseV5Env { COHERE_API_KEY?: string }
const MAX_PARSE_RESPONSE_BYTES = 16 * 1024 * 1024;

type ParseResponse = {
  markdown?: string;
  text?: string;
  document?: { markdown?: string; text?: string };
  results?: Array<{ markdown?: string; text?: string }>;
};

/** Send the original bytes to Cohere's layout-aware parser and return its Markdown verbatim. */
export async function createParseV5Request(
  fileBuffer: ArrayBuffer | Uint8Array,
  mimeType: string,
  env: ParseV5Env,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!env.COHERE_API_KEY) throw Object.assign(new Error("Cohere Parse is not configured"), { status: 503 });
  if (!mimeType) throw Object.assign(new Error("mimeType is required"), { status: 400 });
  const bytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);
  if (!bytes.byteLength) throw Object.assign(new Error("document is empty"), { status: 400 });
  const form = new FormData();
  form.set("model", "parse-v5.0");
  form.set("output_format", "markdown");
  form.set("document", new Blob([bytes], { type: mimeType }), "document");
  const response = await fetcher("https://api.cohere.com/v2/parse", {
    method: "POST",
    headers: { authorization: `Bearer ${env.COHERE_API_KEY}`, accept: "application/json" },
    body: form,
  });
  if (!response.ok) throw Object.assign(new Error(`Cohere Parse failed (${response.status})`), { status: 502 });
  let parsed: ParseResponse;
  try {
    parsed = await readBoundedResponseJson<ParseResponse>(response, MAX_PARSE_RESPONSE_BYTES);
  } catch {
    throw Object.assign(new Error("Cohere Parse returned an invalid or oversized response"), { status: 502 });
  }
  const markdown = parsed.markdown ?? parsed.document?.markdown ?? parsed.text ??
    parsed.document?.text ?? parsed.results?.map((result) => result.markdown ?? result.text ?? "").join("\n\n");
  if (!markdown?.trim()) throw Object.assign(new Error("Cohere Parse returned no Markdown"), { status: 502 });
  return markdown;
}
