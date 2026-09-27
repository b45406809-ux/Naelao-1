/** Typed service-binding adapter for the Artifact worker's Git-for-agents API. */
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
    if (!response.ok) throw new Error(`repository_${operation}_failed:${response.status}:${await response.text()}`);
    return response.json() as Promise<T>;
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
}
