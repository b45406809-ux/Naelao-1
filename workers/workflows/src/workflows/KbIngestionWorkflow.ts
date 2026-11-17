/**
 * KbIngestionWorkflow
 *
 * CF Workflow for ingesting large KB documents that exceed single-request limits.
 * Raw content is pre-stored in R2 by the caller; this workflow fetches, chunks,
 * embeds, and indexes the content via the KNOWLEDGE_WORKER internal API.
 *
 * Steps:
 *   1. fetch-content            — retrieve raw content from scoped R2 staging, validate ≤5MB
 *   2. update-status-processing — mark document as processing
 *   3. count-chunks + bounded chunk-and-embed batches
 *   4. update-status-indexed    — mark document as indexed with chunk count
 *   5. cleanup-raw              — delete the raw staging object from R2
 *
 * Gap IDs fulfilled: G-B16, G-B17 (async large-doc ingestion)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { mintInternalToken, readBoundedResponseText } from "@naelao/http";
import { chunkStructuredMarkdown, chunkTextWithOffsets, chunkSourceCoordinates, type StructuralChunk, type TextChunkWithOffsets } from "@naelao/rag";
import type { Env } from "../env";

export interface IngestionParams {
  docId: string;
  spaceId: string;
  tenantId: string;
  projectId: string;
  r2Key: string;      // Key in KB_BUCKET where raw content is staged
  title: string;
  contentType: string;
  requiredRoleRank?: number;
  allowedUserIds?: string[];
}

// 5 MB content limit per workflow run
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

type IngestionChunk = TextChunkWithOffsets | StructuralChunk;

function chunkKnowledgeText(text: string, contentType: string): IngestionChunk[] {
  return contentType === "pdf" || contentType === "docx" || contentType === "xlsx" ? chunkStructuredMarkdown(text) : chunkTextWithOffsets(text);
}

export class KbIngestionWorkflow extends WorkflowEntrypoint<Env, IngestionParams> {
  async run(
    event: WorkflowEvent<IngestionParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = event.payload;
    let chunkCount = 0;
    const documentPath = `/internal/spaces/${encodeURIComponent(params.spaceId)}/kb/documents/${encodeURIComponent(params.docId)}`;
    const internalHeaders = async () => ({
      "X-Naelao-Tenant-Id": params.tenantId,
      "X-Naelao-Internal-Token": await mintInternalToken(this.env.PLATFORM_SECRET, params.tenantId),
    });

    try {
      if (![params.docId, params.spaceId, params.tenantId, params.projectId, params.r2Key, params.title, params.contentType]
        .every((value) => typeof value === "string" && value.length > 0) ||
          params.docId.length > 128 || params.spaceId.length > 256 || params.tenantId.length > 256 ||
          params.projectId.length > 256 || params.title.length > 500 || params.contentType.length > 64 ||
          params.r2Key.length > 512 || !params.r2Key.startsWith("staging/") || params.r2Key.includes("..") || params.r2Key.includes("\\")) {
        throw new Error("Invalid KB ingestion workflow parameters");
      }
      const expectedStagingPrefix = `staging/${params.tenantId}/${params.spaceId}/${params.projectId}/${params.docId}/`;
      if (!params.r2Key.startsWith(expectedStagingPrefix) ||
          (params.requiredRoleRank !== undefined && (!Number.isSafeInteger(params.requiredRoleRank) || params.requiredRoleRank < 0 || params.requiredRoleRank > 50)) ||
          (params.allowedUserIds !== undefined && (!Array.isArray(params.allowedUserIds) || params.allowedUserIds.length > 100 ||
            params.allowedUserIds.some((id) => typeof id !== "string" || !id || id.length > 256)))) {
        throw new Error("Invalid KB ingestion scope or access policy");
      }

      // G-BC03: Per-step retry config with exponential backoff
      const networkRetry = {
        retries: { limit: 3, delay: 1000, backoff: "exponential" as const },
        timeout: 30_000,
      };

      // ── Step 1: Fetch raw content from R2 ──────────────────────────────────
      const stagedObject = await step.do("fetch-content", networkRetry, async () => {
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

        const contentBytes = new TextEncoder().encode(content).byteLength;
        if (contentBytes > MAX_CONTENT_BYTES) {
          throw new Error(
            `Document content exceeds 5MB byte limit: size=${contentBytes}`,
          );
        }

        console.log(
          `[KbIngestion] Fetched r2Key="${params.r2Key}", length=${content.length} chars`,
        );
        return { contentLength: content.length, size: sizeHeader, etag: obj.etag };
      });

      // ── Step 2: Mark document as processing ────────────────────────────────
      await step.do("update-status-processing", networkRetry, async () => {
        const resp = await this.env.KNOWLEDGE_WORKER.fetch(
          `https://knowledge-worker${documentPath}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...(await internalHeaders()) },
          body: JSON.stringify({ status: "processing", project_id: params.projectId }),
          },
        );

        if (!resp.ok) {
          let text = "";
          try { text = (await readBoundedResponseText(resp, 8 * 1024)).slice(0, 300); } catch { text = "response_body_unavailable"; }
          throw new Error(
            `Failed to set status=processing for doc ${params.docId}: (${resp.status}) ${text}`,
          );
        }

        return { ok: true };
      });

      // ── Step 3: Count chunks, then embed bounded batches ───────────────────
      // Keeping each call below 50 chunks avoids one long request/5 MiB JSON body.
      // The content is re-read from R2 per step instead of being serialized into workflow state.
      chunkCount = await step.do("count-chunks", networkRetry, async () => {
        const obj = await this.env.KB_BUCKET.get(params.r2Key);
        if (!obj) {
          throw new Error(
            `R2 object disappeared between steps: key="${params.r2Key}"`,
          );
        }
        if (obj.size > MAX_CONTENT_BYTES) throw new Error(`Document exceeds 5MB limit: size=${obj.size} bytes, docId=${params.docId}`);
        if (obj.size !== stagedObject.size || obj.etag !== stagedObject.etag) {
          throw new Error("Staged document changed between workflow steps");
        }
        const content = await obj.text();
        const contentBytes = new TextEncoder().encode(content).byteLength;
        if (contentBytes > MAX_CONTENT_BYTES) throw new Error(`Document content exceeds 5MB byte limit: size=${contentBytes}`);
        return chunkKnowledgeText(content, params.contentType).length;
      });

      await step.do("set-total-chunks", networkRetry, async () => {
        const resp = await this.env.KNOWLEDGE_WORKER.fetch(`https://knowledge-worker${documentPath}/status`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(await internalHeaders()) },
          body: JSON.stringify({ status: "processing", chunk_count: chunkCount, project_id: params.projectId }),
        });
        if (!resp.ok) throw new Error(`Failed to set chunk count for doc ${params.docId}: (${resp.status})`);
        return { chunkCount };
      });

      for (let offset = 0; offset < chunkCount; offset += 50) {
        await step.do(`chunk-and-embed-${offset}`, { ...networkRetry, timeout: 29_000 }, async () => {
          const obj = await this.env.KB_BUCKET.get(params.r2Key);
          if (!obj || obj.size !== stagedObject.size || obj.etag !== stagedObject.etag) {
            throw new Error("Staged document changed or disappeared between workflow steps");
          }
          const content = await obj.text();
          const chunks = chunkKnowledgeText(content, params.contentType);
          if (chunks.length !== chunkCount) throw new Error("Staged document chunk count changed between workflow steps");
          const batch = chunks.slice(offset, offset + 50);
          const coordinates = chunkSourceCoordinates(content, batch);
          const resp = await this.env.KNOWLEDGE_WORKER.fetch(`https://knowledge-worker${documentPath}/ingest-chunks`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await internalHeaders()) },
            body: JSON.stringify({
              chunks: batch.map((chunk) => chunk.content), chunkCoordinates: coordinates,
              projectId: params.projectId, chunkOffset: offset,
              byteOffset: coordinates[0]?.byteStart ?? 0, lineOffset: coordinates[0]?.lineStart ?? 1,
              requiredRoleRank: params.requiredRoleRank ?? 0, allowedUserIds: params.allowedUserIds ?? [],
            }),
          });
          if (!resp.ok) {
            let text = "";
            try { text = (await readBoundedResponseText(resp, 8 * 1024)).slice(0, 300); } catch { text = "response_body_unavailable"; }
            throw new Error(`Chunk ingestion failed for doc ${params.docId}: (${resp.status}) ${text}`);
          }
          return { offset, chunks: batch.length };
        });
      }

      // ── Step 4: Mark document as indexed ──────────────────────────────────
      await step.do("update-status-indexed", networkRetry, async () => {
        const resp = await this.env.KNOWLEDGE_WORKER.fetch(
          `https://knowledge-worker${documentPath}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...(await internalHeaders()) },
            body: JSON.stringify({ status: "indexed", chunk_count: chunkCount, project_id: params.projectId }),
          },
        );

        if (!resp.ok) {
          let text = "";
          try { text = (await readBoundedResponseText(resp, 8 * 1024)).slice(0, 300); } catch { text = "response_body_unavailable"; }
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
          `https://knowledge-worker${documentPath}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...(await internalHeaders()) },
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
