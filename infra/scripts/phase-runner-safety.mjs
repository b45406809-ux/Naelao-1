import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const PROVIDER_SECRET_NAMES = [
  "GEMINI_API_KEYS",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEYS",
  "GOOGLE_API_KEY",
  "GROQ_API_KEYS",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
];

export function childEnvironmentWithoutProviderSecrets(environment = process.env) {
  const childEnvironment = { ...environment };
  for (const name of PROVIDER_SECRET_NAMES) delete childEnvironment[name];
  return childEnvironment;
}

export async function readBoundedResponseText(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Response byte limit must be a positive safe integer");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("response body exceeds configured byte limit");
        throw new Error("Provider response exceeded byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

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
