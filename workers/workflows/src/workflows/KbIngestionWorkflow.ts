/**
 * KbIngestionWorkflow
 *
 * CF Workflow for ingesting large KB documents that exceed single-request limits.
 * Raw content is pre-stored in R2 by the caller; this workflow fetches, chunks,
 * embeds, and indexes the content via the KNOWLEDGE_WORKER internal API.
 *
 * Steps:
 *   1. fetch-content            — retrieve raw content from R2, validate ≤5MB
 *   2. update-status-processing — mark document as processing
 *   3. chunk-and-embed          — split + forward chunks to knowledge worker
 *   4. update-status-indexed    — mark document as indexed with chunk count
 *   5. cleanup-raw              — delete the raw staging object from R2
 *
 * Gap IDs fulfilled: G-B16, G-B17 (async large-doc ingestion)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env";

export interface IngestionParams {
  docId: string;
  spaceId: string;
  tenantId: string;
  projectId: string;
  r2Key: string;      // Key in KB_BUCKET where raw content is staged
  title: string;
  contentType: string;
}

// 5 MB content limit per workflow run
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

// 10 KB target chunk size (character-based; actual split at word boundary)
const CHUNK_SIZE_CHARS = 10 * 1024;

/**
 * Split text into chunks of up to chunkSize characters,
 * preferring to break at the last whitespace before the boundary
 * to avoid mid-word cuts.
 */
function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    if (offset + chunkSize >= text.length) {
      // Last chunk — take whatever remains
      chunks.push(text.slice(offset));
      break;
    }

    // Find the last whitespace within the chunk window
    let end = offset + chunkSize;
    const slice = text.slice(offset, end);
    const lastSpace = slice.lastIndexOf(" ");

    if (lastSpace > 0) {
      end = offset + lastSpace;
    }

    chunks.push(text.slice(offset, end).trim());
    offset = end + 1; // skip the space we split on
  }

  return chunks.filter(c => c.length > 0);
}

export class KbIngestionWorkflow extends WorkflowEntrypoint<Env, IngestionParams> {
  async run(
    event: WorkflowEvent<IngestionParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = event.payload;
    let chunkCount = 0;

    try {
      // G-BC03: Per-step retry config with exponential backoff
      const networkRetry = {
        retries: { limit: 3, delay: 1000, backoff: "exponential" as const },
        timeout: 30_000,
      };

      // ── Step 1: Fetch raw content from R2 ──────────────────────────────────
      const { contentLength } = await step.do("fetch-content", networkRetry, async () => {
        const obj = await this.env.KB_BUCKET.get(params.r2Key);

        if (!obj) {
          throw new Error(
            `R2 object not found: key="${params.r2Key}" docId=${params.docId}`,
          );
        }

        // Validate size via Content-Length header before reading the full body
        const sizeHeader = obj.size;
        if (sizeHeader > MAX_CONTENT_BYTES) {
          throw new Error(
            `Document exceeds 5MB limit: size=${sizeHeader} bytes, docId=${params.docId}`,
          );
        }

        const content = await obj.text();

        if (content.length > MAX_CONTENT_BYTES) {
          throw new Error(
            `Document content exceeds 5MB character limit: length=${content.length}`,
          );
        }

        console.log(
          `[KbIngestion] Fetched r2Key="${params.r2Key}", length=${content.length} chars`,
        );
        return { contentLength: content.length };
      });

      // ── Step 2: Mark document as processing ────────────────────────────────
      await step.do("update-status-processing", networkRetry, async () => {
        const resp = await this.env.KNOWLEDGE_WORKER.fetch(
          `https://knowledge-worker/internal/docs/${params.docId}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "processing", project_id: params.projectId }),
          },
        );

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(
            `Failed to set status=processing for doc ${params.docId}: (${resp.status}) ${text}`,
          );
        }

        return { ok: true };
      });

      // ── Step 3: Chunk and embed via KNOWLEDGE_WORKER ────────────────────────
      // We re-fetch the content inside this step because WorkflowStep state is
      // JSON-serialized between steps — storing large strings across steps would
      // balloon serialized state. R2 fetches are idempotent so re-fetching is safe.
      chunkCount = await step.do("chunk-and-embed", { ...networkRetry, timeout: 29_000 }, async () => {
        const obj = await this.env.KB_BUCKET.get(params.r2Key);
        if (!obj) {
          throw new Error(
            `R2 object disappeared between steps: key="${params.r2Key}"`,
          );
        }
        const content = await obj.text();

        const chunks = splitIntoChunks(content, CHUNK_SIZE_CHARS);

        console.log(
          `[KbIngestion] Chunked docId=${params.docId} into ${chunks.length} chunk(s)`,
        );

        const resp = await this.env.KNOWLEDGE_WORKER.fetch(
          `https://knowledge-worker/internal/docs/${params.docId}/ingest-chunks`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Naelao-Tenant-Id": params.tenantId,
            },
            body: JSON.stringify({
              chunks,
              spaceId: params.spaceId,
              tenantId: params.tenantId,
              projectId: params.projectId,
              title: params.title,
              contentType: params.contentType,
            }),
          },
        );

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(
            `Chunk ingestion failed for doc ${params.docId}: (${resp.status}) ${text}`,
          );
        }

        return chunks.length;
      });

      // ── Step 4: Mark document as indexed ──────────────────────────────────
      await step.do("update-status-indexed", networkRetry, async () => {
        const resp = await this.env.KNOWLEDGE_WORKER.fetch(
          `https://knowledge-worker/internal/docs/${params.docId}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "indexed", chunk_count: chunkCount, project_id: params.projectId }),
          },
        );

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(
            `Failed to set status=indexed for doc ${params.docId}: (${resp.status}) ${text}`,
          );
        }

        console.log(
          `[KbIngestion] docId=${params.docId} indexed with ${chunkCount} chunk(s)`,
        );
        return { status: "indexed", chunkCount };
      });

      // ── Step 5: Delete raw staging object from R2 ──────────────────────────
      await step.do("cleanup-raw", async () => {
        await this.env.KB_BUCKET.delete(params.r2Key);

        console.log(`[KbIngestion] Deleted raw staging object r2Key="${params.r2Key}"`);
        return { deleted: true };
      });
    } catch (err) {
      // On any step failure: mark the document as failed and rethrow
      // so the workflow records the error and CF can retry/DLQ.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[KbIngestion] Failed for docId=${params.docId}: ${message}`);

      try {
        await this.env.KNOWLEDGE_WORKER.fetch(
          `https://knowledge-worker/internal/docs/${params.docId}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "failed", error: message, project_id: params.projectId }),
          },
        );
      } catch (statusErr) {
        // Best-effort — don't mask the original error
        console.error(
          `[KbIngestion] Also failed to set status=failed: ${statusErr}`,
        );
      }

      throw err;
    }
  }
}
