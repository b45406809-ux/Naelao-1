import { describe, expect, it } from "vitest";
import { distillSkillFromTrace } from "../../workers/agents/src/script-engine/prebuilt/skill-distiller.js";

describe("demonstration-to-skill distillation", () => {
  it("verifies before saving beneath the AVOS shared skills namespace", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const indexed: unknown[] = [];
    const calls: Array<{ tier: number; args: Record<string, unknown> }> = [];
    const ctx = {
      env: {
        spaceId: "space-1",
        agentId: "agent-1",
        tenantId: "tenant-1",
        codeRunner: {
          run: async (request: { tier: number; args: Record<string, unknown> }) => {
            calls.push(request);
            return { ok: true, tier: 2, duration_ms: 1, tokens_used: 0 };
          },
        },
        fs: { write: async (path: string, content: string) => { writes.push({ path, content }); } },
        indexSkillMetadata: async (entry: unknown) => { indexed.push(entry); },
      },
      run: async () => ({}),
    };

    const result = await distillSkillFromTrace([
      { op: "browser.navigate", input: { url: "https://example.test", clientEmail: "founder@example.test" } },
    ], "contact-client", ctx as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tier).toBe(2);
    expect(writes[0]?.path).toBe("/.avos/shared/skills/contact-client.ts");
    expect(writes[0]?.content).toContain('args["clientEmail"]');
    expect(writes[0]?.content).not.toContain("founder@example.test");
    expect(indexed).toHaveLength(1);
    expect(result.path).toBe("/.avos/shared/skills/contact-client.ts");
  });

  it("does not persist an unverified skill", async () => {
    const write = async () => { throw new Error("must not write"); };
    const ctx = {
      env: {
        spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1",
        codeRunner: { run: async () => ({ ok: false, error: "selector missing", tier: 2, duration_ms: 1, tokens_used: 0 }) },
        fs: { write },
      },
      run: async () => ({}),
    };
    await expect(distillSkillFromTrace([{ op: "browser.click", input: { selector: "#save" } }], "save-form", ctx as never))
      .rejects.toThrow("Skill distillation failed verification: selector missing");
  });
});
