import { ParsedDocumentResult, Parse5RequestOptions } from "@naelao/types";

export class CohereParse5Client {
  private apiKey: string;
  private endpoint: string = "https://api.cohere.com/v2/parse";

  constructor(apiKey: string) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error("COHERE_API_KEY is not configured on the knowledge worker.");
    }
    this.apiKey = apiKey.trim();
  }

  /**
   * Ingests a raw document buffer (PDF, PNG, TIFF) and converts it to
   * structured Markdown using Cohere Parse 5 (2.3B VLM).
   */
  async parseDocumentToMarkdown(
    fileBuffer: ArrayBuffer,
    options: Parse5RequestOptions = {}
  ): Promise<ParsedDocumentResult> {
    const startTime = Date.now();
    const model = options.model || "parse-v5.0";
    const outputFormat = options.outputFormat || "markdown";

    // 1. Convert ArrayBuffer to Base64 in V8 memory
    const base64Bytes = Buffer.from(fileBuffer).toString("base64");

    // 2. Dispatch to Cohere Parse API
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "AVOS-Edge-Ingestion/2.0"
      },
      body: JSON.stringify({
        model,
        document_bytes: base64Bytes,
        output_format: outputFormat
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Parse 5 API returned HTTP ${response.status}: ${errorText}`);
    }

    const payload = await response.json() as {
      markdown?: string;
      pages?: Array<{ text: string; page_number: number }>;
      meta?: { tables_count?: number };
    };

    const markdownText = payload.markdown || payload.pages?.map(p => p.text).join("\n\n") || "";
    const pageCount = payload.pages?.length || 1;
    const tablesDetected = payload.meta?.tables_count || (markdownText.match(/\|[\s-:]+\|/g)?.length || 0);

    return {
      docId: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      markdown: markdownText,
      pageCount,
      tablesDetected,
      durationMs: Date.now() - startTime,
      rawByteSize: fileBuffer.byteLength
    };
  }
}
