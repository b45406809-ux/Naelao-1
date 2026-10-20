/** Typed service-binding adapter for the Artifact worker's Git-for-agents API. */
const MAX_ARTIFACT_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_ERROR_BYTES = 8 * 1024;

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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
    const headers = await this.headers();
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

  createRepo() { return this.request<{ branch: string; commit_id: string | null }>("createRepo", { method: "POST", body: "{}" }); }
  getRepo() { return this.request<{ branch: string; commit_id: string | null }>("getRepo"); }
  commit(message: string, metadata: RepositoryCommitMetadata, branch = "main") {
    return this.request<{ commit_id: string; tree_id: string }>("commit", { method: "POST", body: JSON.stringify({ message, metadata, branch }) });
  }
  getCommit(oid: string) { return this.request<Record<string, unknown>>("getCommit", {}, new URLSearchParams({ oid })); }
  getTree(at?: string) { return this.request<{ data: unknown[]; commit_id: string | null }>("getTree", {}, new URLSearchParams(at ? { at } : {})); }
  compare(baseRef: string, headRef: string) { return this.request<RepositoryComparison>("compare", {}, new URLSearchParams({ baseRef, headRef })); }
  createTaskBranch(name: string, from?: string) { return this.request<{ branch: string; commit_id: string | null }>("createTaskBranch", { method: "POST", body: JSON.stringify({ name, from }) }); }
  forkForPrivateScratchpad(name: string, from?: string) { return this.request<{ branch: string; commit_id: string | null }>("forkForPrivateScratchpad", { method: "POST", body: JSON.stringify({ name, from, temporary: true }) }); }
  rollbackToTurn(commitOid: string, branch = "main") { return this.request<{ commit_id: string }>("rollbackToTurn", { method: "POST", body: JSON.stringify({ commit_id: commitOid, branch }) }); }
  getBlame(path: string, at?: string) { return this.request<Record<string, unknown>>("getBlame", {}, new URLSearchParams({ path, ...(at ? { at } : {}) })); }
  generatePullRequestDiff(baseBranch: string, forkBranch: string) {
    return this.request<PullRequestDiff>("generatePullRequestDiff", {}, new URLSearchParams({ baseBranch, forkBranch }));
  }
  submitPullRequest(details: { baseBranch?: string; forkBranch: string; title: string; author: string; reasoning: string }) {
    return this.request<{ card: Record<string, unknown>; event: Record<string, unknown> }>("submitPullRequest", { method: "POST", body: JSON.stringify(details) });
  }
  mergePullRequest(baseBranch: string, forkBranch: string, reviewerId: string, reviewerRank: "admin" | "owner", metadata?: RepositoryCommitMetadata) {
    return this.request<{ commit_id: string; fast_forward: boolean; event: Record<string, unknown> }>("mergePullRequest", { method: "POST", body: JSON.stringify({ baseBranch, forkBranch, reviewerId, reviewerRank, metadata }) });
  }
  getDivergenceStatus(baseRef: string, currentRef: string) {
    return this.request<DivergenceStatus>("getDivergenceStatus", {}, new URLSearchParams({ baseRef, currentRef }));
  }
  reconcileUpstream(targetBranch: string, options: { upstreamBranch?: string; metadata?: RepositoryCommitMetadata } = {}) {
    return this.request<ReconcileResult>("reconcileUpstream", { method: "POST", body: JSON.stringify({ targetBranch, ...options }) });
  }
}
