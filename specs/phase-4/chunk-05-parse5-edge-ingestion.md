Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 4 — Chunk 05**: `specs/phase-4/chunk-05-parse5-edge-ingestion.md`.

---

```markdown
---
chunk_id: "phase-4-chunk-05"
phase: 4
include_files:
  - workers/knowledge/src/index.ts
  - workers/knowledge/wrangler.toml
  - packages/types/src/index.ts
repomix_include:
  - "workers/knowledge/src/index.ts"
  - "workers/knowledge/wrangler.toml"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/knowledge/src/parse5Ingestion.ts
  - workers/knowledge/src/index.ts
  - packages/types/src/knowledge.ts
  - packages/types/src/index.ts
---

# Phase 4 — Chunk 05: Cohere Parse 5 (`parse-v5.0`) Edge Ingestion Pipeline

## 1. Executive Summary & Architectural Vision

Traditional OCR engines (Tesseract, standard PDF text scrapers) break catastrophically when encountering complex real-world enterprise documents:
* Multi-column legal agreements where text spans across margins.
* Scanned medical faxes with diagnostic vital tables and handwritten notations.
* Trailing 12-month financial spreadsheets (T-12s) and rent rolls with nested cells.
* Maritime freight bills of lading with dense tariff matrices.

When traditional OCR outputs garbled, fragmented text with broken table alignment, downstream LLMs (Claude 3.7, Llama 3.3) hallucinate clause definitions and miss critical financial liabilities.

AVOS embeds **Cohere Parse 5 (`parse-v5.0`)**—a specialized 2.3B Vision-Language Model—as the authoritative ingestion engine in `workers/knowledge`. Parse 5 converts visual PDF pages and scans directly into structured, human-readable Markdown with table structures preserved verbatim.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                COHERE PARSE 5 EDGE INGESTION PIPELINE                                  │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Raw Scanned PDF / Document Upload via R2 (`/workspace/uploads/lease.pdf`) ]                          │
│                                           │                                                            │
│                                           ▼ (Stream bytes to Worker memory)                            │
│ ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 👁️ COHERE PARSE 5 VLM INGESTION (`workers/knowledge/src/parse5Ingestion.ts`)                       │ │
│ │ • Reads raw binary buffer; converts to base64.                                                     │ │
│ │ • Calls `https://api.cohere.com/v2/parse` (`model: "parse-v5.0"`).                                 │ │
│ │ • Converts multi-column layouts, footnotes, and complex tables into clean Markdown tables.         │ │
│ └─────────────────────────────────────────┬──────────────────────────────────────────────────────────┘ │
│                                           │                                                            │
│                                           ▼ (Output: Pristine Structured Markdown)                     │
│ ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 🗄️ STORAGE & RETRIEVAL DUAL-COMMIT                                                                 │ │
│ │ 1. Primary R2 Workspace Storage: Saves as `documents/{docId}.md` in the project filesystem.       │ │
│ │ 2. Vectorize Indexing: Chunks Markdown by semantic headers (`## § 4.2`) with Mini-AGI ACL tags.    │ │
│ └────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Ingestion Workflows Across Vertical Studios

The clean Markdown produced by Parse 5 feeds directly into the domain viewports and specialized reasoning loops of AVOS Vertical Cowork Studios:

1. **"Harvey for Law" (`doc_studio`):**
   * *Input:* 100-page scanned commercial leases, title deeds, indemnification matrices.
   * *Parse 5 Output:* Section numbers, definitions, and indemnity caps formatted in strict Markdown headings.
   * *Downstream Utility:* The Legal Operator compares clauses against Delaware General Corporation Law and renders side-by-side redlines on `DocumentRedlineCanvas`.
2. **"Harvey for Finance" (`finance_grid`):**
   * *Input:* Trailing 12-Month statements (T-12s), commercial rent rolls, debt schedules.
   * *Parse 5 Output:* Multi-column tables reconstructed into ASCII Markdown tables (`| Tenant | Base Rent | Expiration |`).
   * *Downstream Utility:* Re-hydrated directly into `SpreadsheetFormulaGrid` for net operating income (NOI) sensitivity modeling.
3. **"Harvey for Healthcare" (`clinical_soap`):**
   * *Input:* Hospital fax transmissions, printed diagnostic lab panels.
   * *Parse 5 Output:* Formatted vitals tables, historical medication dosages, lab references.
   * *Downstream Utility:* Medical agent maps entries directly to standard SOAP notes and validates CPT/ICD-10 codes.
4. **"Harvey for Logistics" (`customs_desk`):**
   * *Input:* International Bills of Lading (BoL), commercial invoices with 500 product line items.
   * *Parse 5 Output:* High-density product matrices with HS tariff codes, container numbers, and gross weights.
   * *Downstream Utility:* Port clearance agent checks codes against customs tariff databases to prevent demurrage penalties.

---

## 3. Technical Specifications & File Implementation Contracts

### A. TypeScript Type Definitions (`packages/types/src/knowledge.ts`)
Create `packages/types/src/knowledge.ts` and re-export in `packages/types/src/index.ts`:

```typescript
export interface Parse5RequestOptions {
  model?: string; // Default: "parse-v5.0"
  outputFormat?: "markdown" | "json";
}

export interface ParsedDocumentResult {
  docId: string;
  markdown: string;
  pageCount: number;
  tablesDetected: number;
  durationMs: number;
  rawByteSize: number;
}

export interface IngestDocumentPayload {
  spaceId: string;
  projectId?: string;
  title: string;
  fileBuffer: ArrayBuffer;
  contentType: string;
  visibility?: "public" | "private" | "role_restricted";
  minRoleRank?: number; // 1: Viewer -> 5: Owner
}
```

---

### B. Parse 5 Ingestion Client (`workers/knowledge/src/parse5Ingestion.ts`)
Create `workers/knowledge/src/parse5Ingestion.ts`. Implement base64 encoding, error handling, and API invocation:

```typescript
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
```

---

### C. Update Knowledge Worker (`workers/knowledge/src/index.ts`)
Add the dedicated enterprise ingestion route `POST /spaces/:spaceId/kb/documents/ingest-enterprise`:

```typescript
import { Hono } from "hono";
import { CohereParse5Client } from "./parse5Ingestion";
import { requireInternalHmac } from "@naelao/http";
import { wrapInUntrustedEnvelope } from "@naelao/security";

const app = new Hono<{ Bindings: Env }>();

// Enterprise Document Ingestion Route
app.post("/spaces/:spaceId/kb/documents/ingest-enterprise", async (c) => {
  const { spaceId } = c.req.param();
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const title = (formData.get("title") as string) || file?.name || "Untitled Enterprise Document";
  const projectId = (formData.get("project_id") as string) || "";
  const minRoleRank = parseInt((formData.get("min_role_rank") as string) || "1", 10);

  if (!file) {
    return c.json({ error: "Missing required 'file' binary field in multipart form" }, 400);
  }

  // 1. Verify Cohere API configuration
  const cohereKey = c.env.COHERE_API_KEY;
  if (!cohereKey) {
    return c.json({ error: "COHERE_API_KEY is not configured on this environment" }, 503);
  }

  const arrayBuffer = await file.arrayBuffer();
  const parser = new CohereParse5Client(cohereKey);

  // 2. Parse visual document bytes to structured Markdown
  let parseResult;
  try {
    parseResult = await parser.parseDocumentToMarkdown(arrayBuffer);
  } catch (err: any) {
    return c.json({ error: "Parse 5 processing failed", details: err.message }, 502);
  }

  // 3. Save pristine Markdown to Project Workspace in R2
  const r2Key = projectId 
    ? `spaces/${spaceId}/projects/${projectId}/documents/${parseResult.docId}.md`
    : `spaces/${spaceId}/documents/${parseResult.docId}.md`;

  await c.env.KNOWLEDGE_BUCKET.put(r2Key, parseResult.markdown, {
    customMetadata: {
      docId: parseResult.docId,
      title,
      spaceId,
      projectId,
      pageCount: String(parseResult.pageCount),
      tablesDetected: String(parseResult.tablesDetected)
    }
  });

  // 4. Chunk Markdown by headers and index into Vectorize with Mini-AGI ACL tags
  const chunks = parseResult.markdown.split(/\n(?=##?\s)/); // Split on H1/H2 headers
  const embeddings = await c.env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: chunks.map(chunk => chunk.slice(0, 1000))
  });

  const vectorRecords = chunks.map((chunk, idx) => ({
    id: `${parseResult.docId}_chunk_${idx}`,
    values: embeddings.data[idx],
    metadata: {
      doc_id: parseResult.docId,
      space_id: spaceId,
      project_id: projectId,
      min_role_rank: minRoleRank,
      title: `${title} (Part ${idx + 1})`,
      text: chunk
    }
  }));

  if (vectorRecords.length > 0) {
    await c.env.KB_VECTORS.upsert(vectorRecords);
  }

  return c.json({
    ok: true,
    docId: parseResult.docId,
    title,
    r2Key,
    pageCount: parseResult.pageCount,
    tablesDetected: parseResult.tablesDetected,
    chunkCount: vectorRecords.length,
    durationMs: parseResult.durationMs
  }, 201);
});

export default app;
```

---

### D. Update Knowledge Worker Configuration (`workers/knowledge/wrangler.toml`)
Ensure the `COHERE_API_KEY` secret is documented:

```toml
# workers/knowledge/wrangler.toml

[vars]
ENVIRONMENT = "production"

# Secret configured via: wrangler secret put COHERE_API_KEY --name naelao-knowledge
# COHERE_API_KEY = "..."
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/knowledge.ts` and re-export its interfaces from `packages/types/src/index.ts`.
2. Create `workers/knowledge/src/parse5Ingestion.ts` with the `CohereParse5Client` class.
3. Update `workers/knowledge/src/index.ts` to add the `POST /spaces/:spaceId/kb/documents/ingest-enterprise` route, wiring:
   * ArrayBuffer conversion.
   * `CohereParse5Client` parsing.
   * R2 storage write under `documents/{docId}.md`.
   * Semantic chunking and vector embedding via `@cf/baai/bge-small-en-v1.5`.
   * Vectorize upsert with `min_role_rank`, `space_id`, and `project_id` ACL metadata.
4. Run `node --check` syntax validation on the modified files to ensure zero TypeScript errors.
```
