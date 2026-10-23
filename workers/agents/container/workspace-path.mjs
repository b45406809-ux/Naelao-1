import { lstat } from "node:fs/promises";
import { join } from "node:path";

/** Convert a guest supplied path into a deliverable path rooted below the workspace. */
export function safeWorkspacePath(path) {
  const value = String(path).replaceAll("\\", "/");
  if (value.startsWith("/.avos") || value === ".avos" || value.startsWith(".avos/"))
    throw new Error("agent state is not a deliverable");
  const relativePath = value.startsWith("/workspace/") ? value.slice(11) : value.replace(/^\/+/, "");
  const parts = relativePath.split("/");
  if (!relativePath || relativePath.length > 1024 || relativePath.includes("\0") || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255))
    throw new Error("workspace path traversal rejected");
  if (parts.some((part) => [".avos", ".naelao", ".git", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp", ".artifactfs-staging"].includes(part)
    || part === ".env" || part.startsWith(".env.") && part !== ".env.example")) throw new Error("workspace control/cache/secret path rejected");
  return parts.join("/");
}

/** Reject an existing symlink anywhere between the workspace root and a target path. */
export async function assertWorkspaceAncestors(path, workspaceDir = "/workspace") {
  let current = workspaceDir;
  for (const part of safeWorkspacePath(path).split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("workspace symlink rejected");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
