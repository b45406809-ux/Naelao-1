/** Shared by code execution and workspace RPCs so delegated branches address the same actor. */
export function workspaceBranchScope(branch?: string): string {
  if (!branch) return "";
  const normalized = branch.replaceAll("\\", "/");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(normalized) || normalized.includes(".."))
    throw new Error("workspaceBranch contains an invalid path");
  return `:branch:${normalized}`;
}
export function sandboxInstanceName(spaceId: string, projectId?: string, branch?: string): string {
  return `sandbox:${spaceId}:${projectId ?? "_assistant"}${workspaceBranchScope(branch)}`;
}
