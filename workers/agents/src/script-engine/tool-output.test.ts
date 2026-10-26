import { describe, expect, it } from "vitest";
import { estimateTokens, offloadToolOutput, toolOutputReadBucket, TOOL_OUTPUT_TOKEN_LIMIT } from "./tool-output.js";

describe("tool output context estimate", () => {
  it("uses a conservative estimate for multibyte text instead of counting UTF-16 units", () => {
    const chinese = "漢".repeat(5_000);
    expect(chinese.length).toBe(5_000);
    expect(estimateTokens(chinese)).toBeGreaterThan(TOOL_OUTPUT_TOKEN_LIMIT);
  });

  it("counts astral characters by their UTF-8 width", () => {
    expect(estimateTokens("😀")).toBe(2);
    expect(estimateTokens("x".repeat(3_000))).toBe(1_000);
  });

  it("compresses repetitive private tool logs before encryption and transparently restores windows", async () => {
    const values = new Map<string, { value: string; metadata: Record<string, string> }>();
    const bucket = {
      put: async (key: string, value: string, options: { customMetadata: Record<string, string> }) => { values.set(key, { value, metadata: options.customMetadata }); },
      get: async (key: string) => { const value = values.get(key); return value ? { customMetadata: value.metadata, text: async () => value.value } : null; },
      head: async (key: string) => { const value = values.get(key); return value ? { size: value.value.length, customMetadata: value.metadata } : null; },
    } as unknown as R2Bucket;
    const env = {
      tenantId: "tenant-1", spaceId: "space-1", agentId: "assistant", runId: "run-1", platformSecret: "test-secret",
      scriptsBucket: bucket, scheduleToolOutputExpiry: async () => undefined,
    } as never;
    const raw = "routine build log line: tests passed, no errors\n".repeat(2_000);
    const envelope = await offloadToolOutput(env, raw) as { output_path: string };
    const [storageKey, stored] = [...values.entries()][0]!;
    expect(stored.metadata.compression).toBe("gzip-base64-v1");
    expect(Number(stored.metadata.compressedBytes)).toBeLessThan(Number(stored.metadata.plaintextBytes) / 5);
    const result = await toolOutputReadBucket(env).get(storageKey);
    expect(result).not.toBeNull();
    const full = await result!.text();
    expect(full).toBe(raw);
    const window = await toolOutputReadBucket(env).get(storageKey, { range: { offset: 0, length: 48 } });
    expect(await window!.text()).toBe(raw.slice(0, 48));
    expect(envelope.output_path).toMatch(/^\/\.avos\/tmp\/tool_out_/);
  });
});
