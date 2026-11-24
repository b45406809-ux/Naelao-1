import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Create task scratch storage that can never be nested under the canonical workspace. */
export async function createRuntimeScratchDirectory(prefix, {
  workspaceDirectory = "/workspace",
  scratchRoot = tmpdir(),
} = {}) {
  if (typeof prefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}-$/.test(prefix))
    throw new Error("runtime_scratch_prefix_invalid");
  const workspace = resolve(workspaceDirectory);
  const root = resolve(scratchRoot);
  const relativeRoot = relative(workspace, root);
  const nestedUnderWorkspace = relativeRoot === "" || !relativeRoot.startsWith(`..${sep}`) && relativeRoot !== ".." && !isAbsolute(relativeRoot);
  if (nestedUnderWorkspace) throw new Error("runtime_scratch_workspace_overlap");

  return mkdtemp(join(root, prefix));
}
