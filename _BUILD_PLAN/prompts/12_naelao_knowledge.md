# Prompt: workers/naelao-knowledge/src/ (3 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy first, Stripe later via BillingProvider interface. Errors: { error: { code: 'SNAKE_CASE', message: 'text' } }. All routes prefixed /v1/. compatibility_date: 2025-01-01.

Generate THREE files for workers/naelao-knowledge/src/.

CRITICAL (G-G10): Vectorize binding MUST be declared in wrangler.jsonc as:
  "vectorize": [{ "binding": "NAELAO_VECTORIZE", "index_name": "naelao-knowledge-base" }]
The index must be created with: wrangler vectorize create naelao-knowledge-base --dimensions=768 --metric=cosine

Env:
  NAELAO_VECTORIZE: VectorizeIndex
  NAELAO_SPACE_DO: DurableObjectNamespace
  NAELAO_ANALYTICS_QUEUE: Queue
  AI: Ai  (Cloudflare AI binding for embeddings)
  NAELAO_R2: R2Bucket  (store original documents)
  NAELAO_JWT_SECRET: string

=== File 1: src/chunker.ts ===

Token-aware text chunker (G-E11 fix - word count is WRONG, use actual token estimation):

  function estimateTokens(text: string): number
  - Approximate: text.length / 4  (average 4 chars per token for English)
  - This is conservative and safe - actual tokenizer not available in CF Workers

  function chunkText(text: string, maxTokens?: number, overlapTokens?: number): string[]
  - maxTokens default: 400 (not 512 - leave headroom)
  - overlapTokens default: 50
  - Split on sentence boundaries when possible (look for '. ', '! ', '? ')
  - Return array of chunk strings

  function extractText(content: string, mimeType: string): string
  - For 'text/plain': return content directly
  - For 'text/html': strip HTML tags using regex (no DOM available)
  - For 'application/json': JSON.stringify with pretty print
  - For others: return content as-is

=== File 2: src/embedder.ts ===

  async function embedText(text: string, ai: Ai): Promise<number[]>
  - Uses @cf/baai/bge-base-en-v1.5 model (768 dimensions)
  - await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] })
  - Returns float array

  async function upsertChunks(vectorize: VectorizeIndex, docId: string, spaceId: string, chunks: string[], ai: Ai): Promise<void>
  - Embed each chunk
  - Upsert to Vectorize with metadata: { spaceId, docId, chunkIndex }
  - ID format: docId + ':chunk:' + chunkIndex
  - Batch upserts: vectorize.upsert([{ id, values, metadata }])

  async function deleteDocChunks(vectorize: VectorizeIndex, docId: string, chunkCount: number): Promise<void>
  - Build IDs: [docId+':chunk:0', ..., docId+':chunk:'+(chunkCount-1)]
  - Call vectorize.deleteByIds(ids) in batches of 1000 (GDPR/G-G22 fix)

=== File 3: src/index.ts ===

Hono Worker with Queue consumer.

Routes:
  POST /v1/knowledge/:spaceId/ingest
    { title: string; content: string; mimeType?: string; projectId?: string }
    -> Store doc metadata in SpaceDO with status='queued'
    -> Enqueue to NAELAO_ANALYTICS_QUEUE with { type: 'knowledge_index', docId, spaceId, content, title, mimeType }
    -> Return { docId; status: 'queued' }

  GET /v1/knowledge/:spaceId/documents
    -> Fetch doc list from SpaceDO (status, title, chunkCount, createdAt, errorMessage)

  GET /v1/knowledge/:spaceId/documents/:docId/status
    -> Return { status; errorMessage? } - used by UI to poll indexing progress (G-E07 fix)

  DELETE /v1/knowledge/:spaceId/documents/:docId
    -> Mark deleted in SpaceDO
    -> Delete Vectorize chunks (call deleteDocChunks) - GDPR fix (G-G22)
    -> Return { ok: true }

  POST /v1/knowledge/:spaceId/search
    { query: string; topK?: number; projectId?: string }
    -> Embed query
    -> CRITICAL (G-G20): filter: { spaceId: { $eq: spaceId } }  NOT { spaceId: spaceId }
    -> Post-filter: results.matches.filter(m => m.metadata?.spaceId === spaceId)
    -> Return { results: [{ docId, chunkIndex, score, text? }] }

Queue consumer for async indexing:
  export default { queue(batch, env) { ... } }
  For each message with type='knowledge_index':
    1. Update SpaceDO doc status to 'indexing'
    2. extractText, chunkText
    3. upsertChunks to Vectorize
    4. Update SpaceDO doc status to 'ready', chunkCount=N
    On error: update status to 'failed', errorMessage=err.message (G-E07 fix)

