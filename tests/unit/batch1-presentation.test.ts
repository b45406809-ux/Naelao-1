import { describe, expect, it } from "vitest";
import { ansiSegments, terminalText } from "../../apps/shell/src/lib/terminal-output.js";
import { estimateTextTokens, validProviderUsage } from "../../packages/agent-sdk/src/token-accounting.js";
describe("terminal and token presentation", () => {
  it("renders nested stdout/stderr without transport envelopes", () => {
    expect(terminalText(JSON.stringify({ ok: true, result: { stdout: "pass", stderr: "warn", runtime_receipt: { engine: "container" } } }))).toBe("pass\nwarn");
    expect(terminalText("ordinary output")).toBe("ordinary output");
  });
  it("preserves ANSI colors across accumulated stream chunks and removes control hyperlinks", () => {
    const output = "\x1b[32mPASS\x1b[0m\n<script>alert(1)</script>\x1b]8;;https://evil.test\x07link\x1b]8;;\x07";
    expect(ansiSegments(output)[0]).toMatchObject({ text: "PASS", color: "#34d399" });
    const text = ansiSegments(output).map(segment => segment.text).join("");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).not.toContain("evil.test");
    expect(ansiSegments("\x1b[32").map(s => s.text).join("")).toBe("");
  });
  it("keeps preflight estimates separate from validated authoritative usage", () => {
    expect(estimateTextTokens("x".repeat(385))).toBe(100);
    expect(validProviderUsage({ input_tokens: 132, output_tokens: 7 })).toEqual({ input_tokens: 132, output_tokens: 7 });
    for (const input_tokens of [NaN, Infinity, -1, 0.5, "100"]) expect(validProviderUsage({ input_tokens, output_tokens: 5 })).toBeUndefined();
    expect(validProviderUsage({ estimated_tokens: 100 })).toBeUndefined();
  });
});

describe("ephemeral scratchpad encryption", () => {
  it("never stores plaintext and rejects another session, key or modified ciphertext", async () => {
    const { createScratchpadKey, sealScratchpad, openScratchpad, parseScratchpadCiphertext } = await import("../../packages/agent-sdk/src/scratchpad.js");
    const key = await createScratchpadKey(), content = await sealScratchpad("private medical note", key, "session-a");
    expect(content).not.toContain("medical"); expect(key.extractable).toBe(false);
    expect(parseScratchpadCiphertext(content)).toBeDefined();
    expect(await openScratchpad(content, key, "session-a")).toBe("private medical note");
    await expect(openScratchpad(content, key, "session-b")).rejects.toThrow();
    await expect(openScratchpad(content, await createScratchpadKey(), "session-a")).rejects.toThrow();
    expect(parseScratchpadCiphertext("plaintext")).toBeUndefined();
  });
});
