/**
 * Shared Env interface for the workflows worker.
 * Covers all bindings declared in wrangler.toml.
 */

// CF Workflows type — the Workflow binding returned by Wrangler
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkflowBinding = {
  create(opts: { id?: string; params?: any }): Promise<void>;
  get(id: string): Promise<unknown>;
};

export interface Env {
  ENVIRONMENT: string;
  /** Shared worker HMAC secret for signed calls to internal service routes. */
  PLATFORM_SECRET: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;

  // D1 — platform metadata, billing, users
  PLATFORM_DB: D1Database;

  // R2 — KB documents
  KB_BUCKET: R2Bucket;

  // Vectorize — KB semantic index
  KB_VECTORS: VectorizeIndex;

  // KV — quota cache / config
  QUOTA_CACHE: KVNamespace;

  // Queue — main event bus
  EVENTS_QUEUE: Queue;

  // Service bindings
  SPACES_WORKER: Fetcher;
  KNOWLEDGE_WORKER: Fetcher;

  // Workflow bindings (used by queue consumer to start workflows)
  SPACE_PROVISIONING: WorkflowBinding;
  DATA_ERASURE: WorkflowBinding;
  KB_INGESTION: WorkflowBinding;
  DUNNING: WorkflowBinding;
  QUEUE_HEALTH: WorkflowBinding;
}
