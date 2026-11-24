/** Shared by code execution and workspace RPCs so every Project branch addresses its one main actor. */
export function workspaceBranchScope(branch?: string): string {
  if (!branch) return "";
  const normalized = branch.replaceAll("\\", "/");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(normalized) || normalized.includes(".."))
    throw new Error("workspaceBranch contains an invalid path");
  return `:branch:${normalized}`;
}
export function sandboxInstanceName(spaceId: string, projectId?: string, _branch?: string): string {
  // Branch identity and checked workspace isolation travel in the request scope. A Project
  // branch must never allocate another Cloudflare Container Durable Object.
  return `sandbox:${spaceId}:${projectId ?? "_assistant"}`;
}
