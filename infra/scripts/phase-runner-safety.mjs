import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function resolveRepoOutputPath(candidate, repositoryRoot) {
  if (typeof candidate !== "string" || candidate.trim() === "" || path.isAbsolute(candidate)) {
    throw new Error("Generated file path must be a non-empty relative path");
  }
  const root = realpathSync(repositoryRoot);
  const absolute = path.resolve(root, candidate);
  if (!isWithin(root, absolute)) {
    throw new Error(`Generated path escapes the repository: ${candidate}`);
  }

  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = realpathSync(ancestor);
  if (!isWithin(root, realAncestor)) {
    throw new Error(`Generated path traverses a symlink outside the repository: ${candidate}`);
  }
  if (existsSync(absolute) && !isWithin(root, realpathSync(absolute))) {
    throw new Error(`Generated path resolves outside the repository: ${candidate}`);
  }
  return absolute;
}

export function parseGeneratedPatchPaths(patch, repositoryRoot) {
  const paths = new Set();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    let match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) match = line.match(/^diff --git "a\/([^"\\]+)" "b\/([^"\\]+)"$/);
    if (!match || match[1] !== match[2]) {
      throw new Error("Generated patch contains an unsupported or renamed path");
    }
    const target = match[1];
    const components = target.split(/[\\/]/);
    if (components.includes("..") || components.includes(".git")) {
      throw new Error(`Generated patch path is outside the repository: ${target}`);
    }
    resolveRepoOutputPath(target, repositoryRoot);
    paths.add(target);
  }
  if (paths.size === 0) throw new Error("Generated patch contains no file paths");
  return [...paths];
}
