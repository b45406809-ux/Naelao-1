export const WORKSPACE_ROOT = "/workspace";
export const AVOS_ROOT = "/.avos";
export const AVOS_BIN = `${AVOS_ROOT}/bin`;

export function synthesizedCommandPath(command: string): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(command)) throw new Error("invalid_command_name");
  return `${AVOS_BIN}/${command}.ts`;
}

/** Normalize an agent-supplied deliverable path. Machine paths are never valid deliverables. */
export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== "string" || input.includes("\0"))
    throw new Error("invalid_workspace_path");
  const unix = input.replaceAll("\\", "/");
  if (
    unix === AVOS_ROOT ||
    unix.startsWith(`${AVOS_ROOT}/`) ||
    unix === ".avos" ||
    unix.startsWith(".avos/")
  ) {
    throw new Error("agent_state_is_not_a_deliverable");
  }
  if (unix.startsWith("/") && unix !== WORKSPACE_ROOT && !unix.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error("deliverable_must_be_in_workspace");
  }
  const relative =
    unix === WORKSPACE_ROOT
      ? ""
      : unix.startsWith(`${WORKSPACE_ROOT}/`)
        ? unix.slice(WORKSPACE_ROOT.length + 1)
        : unix.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("workspace_path_traversal");
    parts.push(part);
  }
  if (!parts.length) throw new Error("workspace_file_path_required");
  return parts.join("/");
}

/** Normalize a machine-only path and require that it remains below /.avos/. */
export function normalizeAvosPath(input: string): string {
  const unix = String(input).replaceAll("\\", "/");
  const relative = unix.startsWith(`${AVOS_ROOT}/`)
    ? unix.slice(AVOS_ROOT.length + 1)
    : unix.replace(/^\/+/, "");
  const parts = relative.split("/");
  if (
    !parts.length ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] === "workspace"
  ) {
    throw new Error("invalid_avos_path");
  }
  return `${AVOS_ROOT}/${parts.join("/")}`;
}

export function isDeliverablePath(input: string): boolean {
  try {
    normalizeWorkspacePath(input);
    return true;
  } catch {
    return false;
  }
}
