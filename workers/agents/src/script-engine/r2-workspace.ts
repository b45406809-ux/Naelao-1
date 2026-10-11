import type { ScriptEngineEnv, ScriptRunResult } from "./types.js";
import { workspacePrefix } from "./types.js";
import { deleteWorkspaceBytesCas, publishWorkspaceBytesCas, readBytesWithHash } from "./r2-cas.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export async function virtualFsRead(
  env: ScriptEngineEnv,
  path: string
): Promise<string | null> {
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const key = `${workspacePrefix(env)}${path.replace(/^\/+/, "")}`;
  const object = await readBytesWithHash(bucket, key);
  if (!object) return null;
  return textDecoder.decode(object.bytes);
}

export async function virtualFsWrite(
  env: ScriptEngineEnv,
  path: string,
  content: string,
  expectedHash: string | null
): Promise<void> {
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const key = `${workspacePrefix(env)}${path.replace(/^\/+/, "")}`;
  const { hash } = await publishWorkspaceBytesCas(env, bucket, key, textEncoder.encode(content), expectedHash);
  await env.onWorkspaceChange?.({ path, operation: "write" });
}

export async function virtualFsDelete(
  env: ScriptEngineEnv,
  path: string,
  expectedHash: string | null
): Promise<void> {
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const key = `${workspacePrefix(env)}${path.replace(/^\/+/, "")}`;
  const result = await deleteWorkspaceBytesCas(env, bucket, key, expectedHash);
  if (result.deleted) await env.onWorkspaceChange?.({ path, operation: "delete" });
}

export async function virtualFsList(
  env: ScriptEngineEnv,
  prefix = ""
): Promise<Array<{ path: string; size: number }>> {
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const base = `${workspacePrefix(env)}${prefix.replace(/^\/+/, "")}`;
  const objects: Array<{ path: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list(
      { prefix: base, ...(cursor ? { cursor } : {}), include: ["customMetadata"] }
    );
    for (const item of listing.objects) {
      if (item.customMetadata?.["deleted"] === "true") continue;
      if (!env.workspaceBranch && item.key.slice(workspacePrefix(env).length).startsWith("branches/")) continue;
      objects.push({
        path: item.key.slice(workspacePrefix(env).length),
        size: item.size,
      });
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function virtualFsGrep(
  env: ScriptEngineEnv,
  pattern: string,
  prefix = ""
): Promise<Array<{ path: string; line: number; match: string }>> {
  const list = await virtualFsList(env, prefix);
  const re = new RegExp(pattern, "g");
  const results: Array<{ path: string; line: number; match: string }> = [];
  for (const entry of list) {
    const content = await virtualFsRead(env, entry.path);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (re.test(lines[index]!)) {
        results.push({
          path: entry.path,
          line: index + 1,
          match: lines[index]!,
        });
        re.lastIndex = 0;
      }
    }
  }
  return results;
}

export async function executeVirtualShell(
  env: ScriptEngineEnv,
  op: "read" | "write" | "delete" | "list" | "grep",
  params: Record<string, unknown>
): Promise<ScriptRunResult> {
  const started = Date.now();
  try {
    if (op === "read") {
      const path = String(params.path ?? "");
      const out = await virtualFsRead(env, path);
      return {
        ok: out !== null,
        output: out,
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    if (op === "write") {
      const path = String(params.path ?? "");
      const content = String(params.content ?? "");
      if (!Object.prototype.hasOwnProperty.call(params, "expectedHash")) throw new Error("expectedHash is required for virtual filesystem writes");
      await virtualFsWrite(env, path, content, params.expectedHash === null ? null : String(params.expectedHash));
      return {
        ok: true,
        output: { path, written: true },
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    if (op === "delete") {
      const path = String(params.path ?? "");
      if (!Object.prototype.hasOwnProperty.call(params, "expectedHash")) throw new Error("expectedHash is required for virtual filesystem deletes");
      await virtualFsDelete(env, path, params.expectedHash === null ? null : String(params.expectedHash));
      return {
        ok: true,
        output: { path, deleted: true },
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    if (op === "list") {
      const prefix = String(params.prefix ?? "");
      return {
        ok: true,
        output: await virtualFsList(env, prefix),
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    if (op === "grep") {
      const pattern = String(params.pattern ?? "");
      return {
        ok: true,
        output: await virtualFsGrep(env, pattern, String(params.prefix ?? "")),
        tier: 1,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    return {
      ok: false,
      error: `unknown virtual shell op ${op}`,
      tier: 1,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      tier: 1,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }
}
