import { lstat, readFile, writeFile } from "node:fs/promises";

export const MACHINE_ARTIFACT_MAX_BYTES = 12 * 1024;

export async function readMachineArtifact(path) {
  const bytes = (await lstat(path)).size;
  if (bytes > MACHINE_ARTIFACT_MAX_BYTES) throw new Error("bridge_file_result_limit");
  return { encoding: "base64", content: (await readFile(path)).toString("base64"), bytes };
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
