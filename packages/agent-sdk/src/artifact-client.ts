/** Typed service-binding adapter for the Artifact worker's Git-for-agents API. */
const MAX_ARTIFACT_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_ERROR_BYTES = 8 * 1024;
const MAX_ARTIFACT_REQUEST_BYTES = 2 * 1024 * 1024;

function stringifyBoundedRequestBody(value: unknown): string {
  const active = new WeakSet<object>();
  let nodes = 0, chars = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 16) throw new Error("repository_request_too_large");
    if (typeof item === "string") {
      chars += item.length;
      if (chars > MAX_ARTIFACT_REQUEST_BYTES) throw new Error("repository_request_too_large");
      return;
    }
    if (item === null || item === undefined || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("repository_request_body_invalid");
      return;
    }
    if (typeof item !== "object") throw new Error("repository_request_body_invalid");
    if (active.has(item)) throw new Error("repository_request_body_invalid");
    active.add(item);
    if (Array.isArray(item)) {
      if (item.length > 10_000) throw new Error("repository_request_too_large");
      for (const child of item) visit(child, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("repository_request_body_invalid");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== "string") || keys.length > 10_000) throw new Error("repository_request_body_invalid");
      for (const key of keys as string[]) {
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor)) throw new Error("repository_request_body_invalid");
        chars += key.length;
        if (chars > MAX_ARTIFACT_REQUEST_BYTES) throw new Error("repository_request_too_large");
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
  };
  visit(value, 0);
  const body = JSON.stringify(value);
  if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > MAX_ARTIFACT_REQUEST_BYTES)
    throw new Error("repository_request_too_large");
  return body;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error("repository_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error("repository_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new Error("repository_invalid_response_encoding");
  }
}

export interface RepositoryCommitMetadata {
  agent_role: string;
  user_goal: string;
  rationale: string;
  task_id: string;
  thread_id: string;
  tool_turn_id: string;
}

export interface RepositoryComparison {
  base: string;
  head: string;
  ahead: number;
  behind: number;
  files: Array<{ path: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number; patch: string }>;
}

export interface PullRequestDiff {
  baseBranch: string; forkBranch: string; baseCommit: string; headCommit: string;
  additions: number; deletions: number; files: RepositoryComparison["files"];
}

export interface DivergenceStatus { commitsBehind: number; baseCommit: string; upstreamHead: string }
export type ReconcileResult = DivergenceStatus & {
  status: "UP_TO_DATE" | "AUTO_REBASED" | "REVIEW_REQUIRED";
  overlappingFiles: string[]; upstreamFiles?: string[]; threeWayDiff?: RepositoryComparison["files"];
  commit_id?: string;
};

export interface ArtifactFetcher {
  fetch(input: Request): Promise<Response>;
}

export class ArtifactRepositoryClient {
  private readonly base: string;
  constructor(
    private readonly binding: ArtifactFetcher,
    spaceId: string,
    projectId: string,
    private readonly headers: () => Headers | Promise<Headers>,
  ) {
    this.base = `http://artifact-worker/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/repository`;
  }

  private async request<T>(operation: string, init: RequestInit = {}, query?: URLSearchParams): Promise<T> {
    const headers = new Headers(await this.headers());
    if (typeof init.body === "string") {
      if (init.body.length > MAX_ARTIFACT_REQUEST_BYTES
        || new TextEncoder().encode(init.body).byteLength > MAX_ARTIFACT_REQUEST_BYTES) throw new Error("repository_request_too_large");
    } else if (init.body !== undefined && init.body !== null) {
      throw new Error("repository_request_body_invalid");
    }
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.binding.fetch(new Request(`${this.base}/${operation}${query ? `?${query}` : ""}`, { ...init, headers }));
    if (!response.ok) {
      let detail = "";
      try {
        detail = await readBoundedResponseText(response, MAX_ARTIFACT_ERROR_BYTES);
      } catch (error) {
        detail = error instanceof Error ? error.message : "response_unreadable";
      }
      throw new Error(`repository_${operation}_failed:${response.status}:${detail.slice(0, 200)}`);
    }
    const text = await readBoundedResponseText(response, MAX_ARTIFACT_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("repository_invalid_response_json");
    }
  }

  createRepo() { return this.request<{ branch: string; commit_id: string | null }>("createRepo", { method: "POST", body: stringifyBoundedRequestBody({}) }); }
  getRepo() { return this.request<{ branch: string; commit_id: string | null }>("getRepo"); }
  async commit(message: string, metadata: RepositoryCommitMetadata, branch = "main") {
    return this.request<{ commit_id: string; tree_id: string }>("commit", { method: "POST", body: stringifyBoundedRequestBody({ message, metadata, branch }) });
  }
  getCommit(oid: string) { return this.request<Record<string, unknown>>("getCommit", {}, new URLSearchParams({ oid })); }
  getTree(at?: string) { return this.request<{ data: unknown[]; commit_id: string | null }>("getTree", {}, new URLSearchParams(at ? { at } : {})); }
  compare(baseRef: string, headRef: string) { return this.request<RepositoryComparison>("compare", {}, new URLSearchParams({ baseRef, headRef })); }
  async createTaskBranch(name: string, from?: string) { return this.request<{ branch: string; commit_id: string | null }>("createTaskBranch", { method: "POST", body: stringifyBoundedRequestBody({ name, from }) }); }
  async forkForPrivateScratchpad(name: string, from?: string) { return this.request<{ branch: string; commit_id: string | null }>("forkForPrivateScratchpad", { method: "POST", body: stringifyBoundedRequestBody({ name, from, temporary: true }) }); }
  async rollbackToTurn(commitOid: string, branch = "main") { return this.request<{ commit_id: string }>("rollbackToTurn", { method: "POST", body: stringifyBoundedRequestBody({ commit_id: commitOid, branch }) }); }
  getBlame(path: string, at?: string) { return this.request<Record<string, unknown>>("getBlame", {}, new URLSearchParams({ path, ...(at ? { at } : {}) })); }
  generatePullRequestDiff(baseBranch: string, forkBranch: string) {
    return this.request<PullRequestDiff>("generatePullRequestDiff", {}, new URLSearchParams({ baseBranch, forkBranch }));
  }
  async submitPullRequest(details: { baseBranch?: string; forkBranch: string; title: string; author: string; reasoning: string }) {
    return this.request<{ card: Record<string, unknown>; event: Record<string, unknown> }>("submitPullRequest", { method: "POST", body: stringifyBoundedRequestBody(details) });
  }
  async mergePullRequest(baseBranch: string, forkBranch: string, reviewerId: string, reviewerRank: "admin" | "owner", metadata?: RepositoryCommitMetadata) {
    return this.request<{ commit_id: string; fast_forward: boolean; event: Record<string, unknown> }>("mergePullRequest", { method: "POST", body: stringifyBoundedRequestBody({ baseBranch, forkBranch, reviewerId, reviewerRank, metadata }) });
  }
  getDivergenceStatus(baseRef: string, currentRef: string) {
    return this.request<DivergenceStatus>("getDivergenceStatus", {}, new URLSearchParams({ baseRef, currentRef }));
  }
  async reconcileUpstream(targetBranch: string, options: { upstreamBranch?: string; metadata?: RepositoryCommitMetadata } = {}) {
    return this.request<ReconcileResult>("reconcileUpstream", { method: "POST", body: stringifyBoundedRequestBody({ targetBranch, ...options }) });
  }
}
