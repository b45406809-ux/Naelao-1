import { deriveSpaceDataKey, encryptAuthenticated, decryptAuthenticated, type EncryptedEnvelope } from "@naelao/crypto";
import { gunzipSync, gzipSync } from "fflate";
import { sha256Text } from "./r2-cas.js";
import type { ScriptEngineEnv } from "./types.js";

export const TOOL_OUTPUT_TOKEN_LIMIT = 1_500;
/** Conservative multilingual estimate: UTF-8 bytes undercount neither CJK nor astral text. */
export function estimateTokens(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return Math.ceil(bytes / 3);
}
const PREVIEW_CHARS = Math.floor(TOOL_OUTPUT_TOKEN_LIMIT * 3.85) - 600;
const pathPattern = /^\/\.avos\/tmp\/tool_out_[a-f0-9-]+\.log$/;
const TOOL_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function packToolOutput(text: string): { payload: string; compressedBytes: number; compression: "gzip-base64-v1" | "none" } {
  const raw = new TextEncoder().encode(text);
  const packed = `gzip-base64-v1:${toBase64(gzipSync(raw, { level: 1 }))}`;
  return packed.length < text.length
    ? { payload: packed, compressedBytes: new TextEncoder().encode(packed).byteLength, compression: "gzip-base64-v1" }
    : { payload: text, compressedBytes: raw.byteLength, compression: "none" };
}
function unpackToolOutput(payload: string, compression: string | undefined, expectedBytes: number): string {
  if (compression !== "gzip-base64-v1") return payload;
  if (!payload.startsWith("gzip-base64-v1:") || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > TOOL_OUTPUT_MAX_BYTES) throw new Error("tool_output_compression_metadata_invalid");
  const expanded = gunzipSync(fromBase64(payload.slice("gzip-base64-v1:".length)));
  if (expanded.byteLength !== expectedBytes) throw new Error("tool_output_decompression_size_mismatch");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(expanded);
}

function boundedOutputEnvelope(input: {
  outputPath: string;
  instruction: string;
  estimatedTokens: number;
  previewSource: string;
}): { output_path: string; instruction: string; _truncated: true; estimated_tokens: number; preview: string } {
  let low = 0;
  let high = input.previewSource.length;
  while (low < high) {
    const candidateLength = Math.ceil((low + high) / 2);
    const candidate = {
      output_path: input.outputPath,
      instruction: input.instruction,
      _truncated: true as const,
      estimated_tokens: input.estimatedTokens,
      preview: input.previewSource.slice(0, candidateLength),
    };
    if (estimateTokens(JSON.stringify(candidate)) <= TOOL_OUTPUT_TOKEN_LIMIT) low = candidateLength;
    else high = candidateLength - 1;
  }
  return {
    output_path: input.outputPath,
    instruction: input.instruction,
    _truncated: true,
    estimated_tokens: input.estimatedTokens,
    preview: input.previewSource.slice(0, low),
  };
}

/** Private outputs never live in shared Git/workspace prefixes. No caller supplies scope. */
export function toolOutputKey(env: ScriptEngineEnv, path: string): string {
  if (!pathPattern.test(path)) throw new Error("invalid_tool_output_path");
  const session = env.outputSessionId ?? env.runId;
  if (!session) throw new Error("tool_output_session_required");
  const scope = [env.tenantId, env.spaceId, env.projectId ?? "", env.agentId, session].map(encodeURIComponent).join("/");
  return `private/tool-output/${scope}/${path.slice(path.lastIndexOf("/") + 1)}`;
}

/** A bounded model view, with durable full output accessible by ordinary windowed Read. */
export async function offloadToolOutput(env: ScriptEngineEnv, output: unknown): Promise<unknown> {
  if (output === undefined) return output;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens <= TOOL_OUTPUT_TOKEN_LIMIT) return output;
  if (!env.scheduleToolOutputExpiry) throw new Error("tool_output_expiry_unavailable");
  const path = `/.avos/tmp/tool_out_${crypto.randomUUID()}.log`;
  // Failure to persist is a failure to deliver this result, not permission to silently lose it.
  const storageKey = toolOutputKey(env, path);
  const key = await deriveSpaceDataKey(env.platformSecret ?? "", env.tenantId, env.spaceId);
  const packed = packToolOutput(text);
  const envelope = await encryptAuthenticated(packed.payload, key, storageKey);
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  await (env.workspaceBucket ?? env.scriptsBucket).put(storageKey, JSON.stringify(envelope), {
    customMetadata: { sealed: "space-aes-gcm-v1", plaintextBytes: String(new TextEncoder().encode(text).byteLength), compressedBytes: String(packed.compressedBytes), compression: packed.compression, sha256: await sha256Text(text), expiresAt: String(expiresAt) },
  });
  try {
    await env.scheduleToolOutputExpiry(storageKey, expiresAt);
  } catch (error) {
    await (env.workspaceBucket ?? env.scriptsBucket).delete(storageKey).catch(() => undefined);
    throw new Error(`tool_output_expiry_registration_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const instruction = `Full output saved to ${path}. Use Read with line_start/line_end or read_file with offset/length.`;
  return boundedOutputEnvelope({ outputPath: path, instruction, estimatedTokens,
    previewSource: terminalOutputText(output).slice(0, PREVIEW_CHARS) });
}

/** Terminal display keeps stdout/stderr, not the transport envelope. */
export function terminalOutputText(output: unknown): string {
  if (typeof output === "string") {
    try { return terminalOutputText(JSON.parse(output)); } catch { return output; }
  }
  if (!output || typeof output !== "object") return output === undefined ? "" : String(output);
  const value = output as Record<string, unknown>;
  if (value._truncated && typeof value.preview === "string") return `${value.preview}\n${value.instruction ?? ""}`;
  const streams = [value.stdout, value.stderr].filter((entry): entry is string => typeof entry === "string");
  if (streams.length) return streams.join("\n");
  for (const field of ["result", "output", "content"]) {
    if (value[field] !== undefined) return terminalOutputText(value[field]);
  }
  return JSON.stringify(output, null, 2);
}

/** Transparently decrypt private logs for windowed Read; other workspace objects are unchanged. */
export function toolOutputReadBucket(env: ScriptEngineEnv): R2Bucket {
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  return new Proxy(bucket, { get(target, property) {
    if (property === "head") return async (storageKey: string) => {
      const obj = await target.head(storageKey);
      if (!storageKey.startsWith("private/tool-output/") || !obj) return obj;
      if (Number(obj.customMetadata?.expiresAt ?? 0) <= Date.now()) return null;
      const size = Number(obj.customMetadata?.plaintextBytes);
      if (obj.customMetadata?.sealed !== "space-aes-gcm-v1" || !Number.isSafeInteger(size) || size < 0) throw new Error("tool_output_metadata_invalid");
      return { ...obj, size };
    };
    if (property !== "get") { const member = Reflect.get(target, property); return typeof member === "function" ? member.bind(target) : member; }
    return async (storageKey: string, options?: R2GetOptions) => {
      if (!storageKey.startsWith("private/tool-output/")) return target.get(storageKey, options);
      const obj = await target.get(storageKey);
      if (!obj || Number(obj.customMetadata?.expiresAt ?? 0) <= Date.now()) return null;
      if (obj.customMetadata?.sealed !== "space-aes-gcm-v1") throw new Error("tool_output_sealing_required");
      const plainBytes = Number(obj.customMetadata?.plaintextBytes);
      if (!Number.isSafeInteger(plainBytes) || plainBytes < 0 || plainBytes > TOOL_OUTPUT_MAX_BYTES) throw new Error("tool_output_metadata_invalid");
      const key = await deriveSpaceDataKey(env.platformSecret ?? "", env.tenantId, env.spaceId);
      const payload = await decryptAuthenticated(JSON.parse(await obj.text()) as EncryptedEnvelope, key, storageKey);
      const text = unpackToolOutput(payload, obj.customMetadata?.compression, plainBytes);
      const full = new TextEncoder().encode(text);
      const range = options?.range;
      const offset = range && "offset" in range ? range.offset ?? 0 : 0;
      const length = range && "length" in range ? range.length ?? full.length : full.length;
      const bytes = range ? full.slice(offset, offset + length) : full;
      return { ...obj, size: full.byteLength, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer };
    };
  } });
}
