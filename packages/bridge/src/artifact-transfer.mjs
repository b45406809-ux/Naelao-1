import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { link, lstat, open, readdir, rm, unlink, writeFile } from "node:fs/promises";

export const MACHINE_ARTIFACT_MAX_BYTES = 12 * 1024;
// Keep the bridge-side temporary file and host artifact buffers bounded while allowing
// realistic source files and media snippets to move in resumable 8 KiB protocol chunks.
export const MACHINE_ARTIFACT_MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
export const MACHINE_ARTIFACT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;

function fingerprint(info) { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":"); }
async function readBounded(file, maximumBytes) {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let bytes = 0;
  while (bytes < buffer.length) {
    const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
  }
  if (bytes > maximumBytes) throw new Error("bridge_file_result_limit");
  return buffer.subarray(0, bytes);
}
async function verifyExisting(path, total, digest) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== total) return false;
    const bytes = await readBounded(file, total);
    return bytes.length === total && (await file.stat()).size === total && createHash("sha256").update(bytes).digest("hex") === digest;
  } finally { await file.close(); }
}

async function cleanupExpiredStaging(directory) {
  const cutoff = Date.now() - MACHINE_ARTIFACT_STAGING_TTL_MS;
  let names;
  try { names = await readdir(directory); } catch { return; }
  for (const name of names) {
    if (!/^\.naelao-[a-f0-9]{64}\.part$/.test(name)) continue;
    const candidate = join(directory, name);
    try {
      const info = await lstat(candidate);
      if (info.isFile() && info.mtimeMs <= cutoff) await rm(candidate, { force: true });
    } catch { /* Staging cleanup is best-effort; the active transfer still validates its own file. */ }
  }
}

export async function readMachineArtifact(path, options = {}) {
  // Open without following a last-component symlink, then cap actual reads. A prior stat
  // followed by readFile could race a growing file and allocate an unbounded buffer.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new Error("bridge_file_result_limit");
    const chunked = options.offset !== undefined || options.length !== undefined;
    if (!chunked) {
      if (info.size > BigInt(MACHINE_ARTIFACT_MAX_BYTES)) throw new Error("bridge_file_result_limit");
      options = { offset: 0, length: Number(info.size) };
    }
    const offset = options.offset, length = options.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MACHINE_ARTIFACT_MAX_BYTES
      || BigInt(offset) > info.size || BigInt(offset + length) > info.size) throw new Error("bridge_file_range_invalid");
    const version = fingerprint(info);
    if (options.fingerprint !== undefined && options.fingerprint !== version) throw new Error("bridge_file_changed_during_transfer");
    const buffer = Buffer.alloc(length);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, offset + bytes);
      if (result.bytesRead === 0) throw new Error("bridge_file_changed_during_transfer");
      bytes += result.bytesRead;
    }
    if (fingerprint(await file.stat({ bigint: true })) !== version) throw new Error("bridge_file_changed_during_transfer");
    const result = { encoding: "base64", content: buffer.toString("base64"), bytes };
    return chunked ? { ...result, offset, total_bytes: Number(info.size), fingerprint: version } : result;
  } finally { await file.close(); }
}

export async function writeMachineArtifact(path, params, signal) {
  const encoded = params.content;
  if (typeof encoded !== "string" || encoded.length > 4 * Math.ceil(MACHINE_ARTIFACT_MAX_BYTES / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("bridge_file_result_limit");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MACHINE_ARTIFACT_MAX_BYTES || bytes.toString("base64") !== encoded) throw new Error("bridge_file_result_limit");
  if (params.transfer_id !== undefined) {
    const id = params.transfer_id, offset = params.offset, total = params.total_bytes, digest = params.sha256;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(total) || total <= 0 || total > MACHINE_ARTIFACT_MAX_TRANSFER_BYTES
      || !/^[a-f0-9]{64}$/.test(String(digest)) || offset + bytes.length > total || bytes.length === 0
      || typeof params.finalize !== "boolean") throw new Error("bridge_file_transfer_invalid");
    if (params.finalize) {
      try {
        if (await verifyExisting(path, total, digest)) return { written: true, bytes: bytes.length, total_bytes: total, sha256: digest, finalized: true, deduplicated: true };
        throw new Error("bridge_file_destination_exists");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (offset === 0) await cleanupExpiredStaging(dirname(path));
    const temporary = join(dirname(path), `.naelao-${id}.part`);
    let file;
    try { file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      file = await open(temporary, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    }
    try {
      if (!(await file.stat()).isFile()) throw new Error("bridge_file_transfer_invalid");
      if (signal?.aborted) throw new Error("bridge_request_cancelled");
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error("bridge_file_transfer_write_failed");
        written += result.bytesWritten;
      }
      await file.sync();
      if (!params.finalize) return { written: true, bytes: bytes.length, finalized: false };
      const info = await file.stat();
      if (info.size !== total) throw new Error("bridge_file_transfer_incomplete");
      const full = await readBounded(file, total);
      if (full.byteLength !== total || (await file.stat()).size !== total || createHash("sha256").update(full).digest("hex") !== digest) throw new Error("bridge_file_transfer_integrity_failed");
      if (signal?.aborted) throw new Error("bridge_request_cancelled");
      await link(temporary, path); // atomic create-only publish; EEXIST never overwrites.
      await unlink(temporary);
      return { written: true, bytes: bytes.length, total_bytes: total, sha256: digest, finalized: true };
    } finally { await file.close(); }
  }
  await writeFile(path, bytes, { signal, ...(params.create_only === true ? { flag: "wx" } : {}) });
  return { written: true, bytes: bytes.length };
}
