import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const MAX_PATHS = 20;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const DENIED_SEGMENT = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.config|browser|browser-profile|cache|caches|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|cookies?(?:\..*)?|sessions?(?:\..*)?|node_modules|\.npm|\.pnpm|\.yarn)$/i;

export function safePrivateStatePath(path) {
  if (typeof path !== "string" || !path || path.length > 192 || path.includes("\\") || path.startsWith("/")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)) throw new Error("private_state_path_invalid");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || DENIED_SEGMENT.test(part))) throw new Error("private_state_path_invalid");
  return parts.join("/");
}

async function assertPrivateAncestors(path, workspaceRoot) {
  const base = resolve(workspaceRoot);
  const full = resolve(base, ".naelao", "private", path);
  if (!full.startsWith(`${base}/`)) throw new Error("private_state_path_invalid");
  const parts = [".naelao", "private", ...path.split("/")];
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("private_state_symlink_rejected");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return full;
}

export async function readPrivateStatePaths(paths, workspaceRoot) {
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) throw new Error("private_state_request_invalid");
  const unique = new Set();
  const filesBase64 = {};
  const missingPaths = [];
  let totalBytes = 0;
  for (const raw of paths) {
    const path = safePrivateStatePath(raw);
    if (unique.has(path)) throw new Error("private_state_request_invalid");
    unique.add(path);
    const full = await assertPrivateAncestors(path, workspaceRoot);
    let info;
    try { info = await lstat(full); }
    catch (error) {
      if (error.code === "ENOENT") { missingPaths.push(path); continue; }
      throw error;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("private_state_file_limit");
    const bytes = await readFile(full);
    if (bytes.byteLength !== info.size) throw new Error("private_state_file_changed_during_read");
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("private_state_total_limit");
    filesBase64[path] = bytes.toString("base64");
  }
  return { files_base64: filesBase64, missing_paths: missingPaths };
}

export async function writePrivateStatePaths(filesBase64, workspaceRoot) {
  if (!filesBase64 || typeof filesBase64 !== "object" || Array.isArray(filesBase64)
    || Object.keys(filesBase64).length > MAX_PATHS) throw new Error("private_state_request_invalid");
  let totalBytes = 0;
  const written = [];
  const preserved = [];
  for (const [raw, encoded] of Object.entries(filesBase64)) {
    const path = safePrivateStatePath(raw);
    if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("private_state_file_invalid");
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.byteLength > MAX_FILE_BYTES) throw new Error("private_state_file_limit");
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("private_state_total_limit");
    const full = await assertPrivateAncestors(path, workspaceRoot);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    await assertPrivateAncestors(path, workspaceRoot);
    try {
      await writeFile(full, bytes, { flag: "wx", mode: 0o600 });
      written.push(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      preserved.push(path);
    }
  }
  return { written_paths: written, preserved_paths: preserved };
}
