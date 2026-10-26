import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";

export const MACHINE_ARTIFACT_MAX_BYTES = 12 * 1024;

export async function readMachineArtifact(path) {
  // Open without following a last-component symlink, then cap actual reads. A prior stat
  // followed by readFile could race a growing file and allocate an unbounded buffer.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MACHINE_ARTIFACT_MAX_BYTES) throw new Error("bridge_file_result_limit");
    const buffer = Buffer.alloc(MACHINE_ARTIFACT_MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > MACHINE_ARTIFACT_MAX_BYTES) throw new Error("bridge_file_result_limit");
    const content = buffer.subarray(0, bytes);
    return { encoding: "base64", content: content.toString("base64"), bytes };
  } finally { await file.close(); }
}

export async function writeMachineArtifact(path, params, signal) {
  const encoded = params.content;
  if (typeof encoded !== "string" || encoded.length > 4 * Math.ceil(MACHINE_ARTIFACT_MAX_BYTES / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("bridge_file_result_limit");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MACHINE_ARTIFACT_MAX_BYTES || bytes.toString("base64") !== encoded) throw new Error("bridge_file_result_limit");
  await writeFile(path, bytes, { signal, ...(params.create_only === true ? { flag: "wx" } : {}) });
  return { written: true, bytes: bytes.length };
}
