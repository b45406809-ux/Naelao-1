import { readBoundedResponseJson } from "@naelao/http";

export interface ParseV5Env { COHERE_API_KEY?: string }
const MAX_PARSE_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PARSE_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_PARSE_MARKDOWN_CHARS = 1_048_576;
const PARSE_TIMEOUT_MS = 30_000;

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
  if (bytes.byteLength > MAX_PARSE_INPUT_BYTES) throw Object.assign(new Error("document exceeds the Parse input limit"), { status: 413 });
  const form = new FormData();
  form.set("model", "parse-v5.0");
  form.set("output_format", "markdown");
  form.set("document", new Blob([bytes], { type: mimeType }), "document");
  let response: Response;
  try {
    response = await fetcher("https://api.cohere.com/v2/parse", {
      method: "POST",
      headers: { authorization: `Bearer ${env.COHERE_API_KEY}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    });
  } catch {
    throw Object.assign(new Error("Cohere Parse request failed or timed out"), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error(`Cohere Parse failed (${response.status})`), { status: 502 });
  let parsed: ParseResponse;
  try {
    parsed = await readBoundedResponseJson<ParseResponse>(response, MAX_PARSE_RESPONSE_BYTES);
  } catch {
    throw Object.assign(new Error("Cohere Parse returned an invalid or oversized response"), { status: 502 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Cohere Parse returned an invalid response shape"), { status: 502 });
  }
  const document = parsed.document && typeof parsed.document === "object" ? parsed.document : undefined;
  const direct = [parsed.markdown, document?.markdown, parsed.text, document?.text]
    .find((value): value is string => typeof value === "string");
  const resultMarkdown = Array.isArray(parsed.results)
    ? parsed.results.map((result) => {
        if (!result || typeof result !== "object") return "";
        return typeof result.markdown === "string" ? result.markdown : typeof result.text === "string" ? result.text : "";
      }).filter(Boolean).join("\n\n")
    : "";
  const markdown = direct ?? resultMarkdown;
  if (!markdown.trim()) throw Object.assign(new Error("Cohere Parse returned no Markdown"), { status: 502 });
  if (markdown.length > MAX_PARSE_MARKDOWN_CHARS) {
    throw Object.assign(new Error("Cohere Parse Markdown exceeds the document limit"), { status: 413 });
  }
  return markdown;
}
