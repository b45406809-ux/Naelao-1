import { describe, expect, it } from "vitest";
import { distillSkillFromTrace } from "./distill.js";
import {
  distillSkillFromVideo,
  synthesizeVideoSkill,
} from "./video-distill.js";
import { SkillLibrary } from "./skill-library.js";
import { assessSkillHealth, recordRecentOutcome } from "./skill-health.js";
import { composeSystemPrompt } from "./reasoner.js";

class MemoryBucket {
  objects = new Map<string, string>();
  etags = new Map<string, string>();
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined
      ? null
      : {
          etag: this.etags.get(key) ?? "e0",
          json: async () => JSON.parse(value),
          size: new TextEncoder().encode(value).byteLength,
          text: async () => value,
          arrayBuffer: async () => new TextEncoder().encode(value).buffer,
        };
  }
  async put(
    key: string,
    value: string | ArrayBuffer,
    options?: { onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string } }
  ) {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key))
      return null;
    if (
      options?.onlyIf?.etagMatches &&
      options.onlyIf.etagMatches !== this.etags.get(key)
    )
      return null;
    this.objects.set(
      key,
      typeof value === "string" ? value : new TextDecoder().decode(value)
    );
    const etag = "e" + (Number(this.etags.get(key)?.slice(1) ?? 0) + 1);
    this.etags.set(key, etag);
    return { etag };
  }
  async list({ prefix = "" }: { prefix?: string } = {}) {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

describe("skill distillation", () => {
  it("parameterizes trace literals and writes canonical and /.avos artifacts", async () => {
    const bucket = new MemoryBucket();
    const result = await distillSkillFromTrace(
      [
        {
          name: "search",
          params: { query: "plumbers", limit: 10, includeArchived: false },
          ok: true,
        },
      ],
      "find-leads",
      {
        library: new SkillLibrary(bucket as unknown as R2Bucket, "s1"),
        workspace: {
          bucket: bucket as unknown as R2Bucket,
          prefix: "spaces/s1/projects/p1/workspace/",
        },
      }
    );
    expect(result.code).toContain('args["search_query"]');
    expect(result.code).toContain('"includeArchived": false');
    expect(
      bucket.objects.get(
        "spaces/s1/projects/p1/workspace/.avos/skills/find-leads/code.ts"
      )
    ).toBe(result.code);
    expect(
      bucket.objects.get(
        "spaces/s1/projects/p1/workspace/.avos/skills/find-leads/SCRIPT.md"
      )
    ).toContain("requires_tier: 2");
  });

  it("synthesizes semantic video drafts with parameterized inputs and a final assertion", () => {
    const result = synthesizeVideoSkill([
      { type: "NAVIGATE", url: "https://example.com" },
      {
        type: "TYPE",
        target: { role: "textbox", name: "Search" },
        value: "private example",
        parameter: "query",
      },
      { type: "CLICK", target: { role: "button", name: "Go" } },
      { type: "ASSERT", target: { role: "button", name: "Done" } },
    ]);
    expect(result.steps).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("private example");
    expect(result.parameters).toHaveLength(1);
    expect(() =>
      synthesizeVideoSkill([
        { type: "NAVIGATE", url: "https://example.com" },
        { type: "CLICK", selector: "#submit" },
      ])
    ).toThrow("semantic_target_required");
  });
  it("reads a scoped bounded video and stages an unverified private skill, never a runnable Space script", async () => {
    const bucket = new MemoryBucket();
    await bucket.put("spaces/s1/projects/p1/workspace/demo.mp4", "video bytes");
    const result = await distillSkillFromVideo(
      {
        scriptsBucket: bucket as unknown as R2Bucket,
        workspaceBucket: bucket as unknown as R2Bucket,
        spaceId: "s1",
        projectId: "p1",
        userId: "u1",
        agentId: "a1",
        tenantId: "t1",
        videoSkillAnalyzer: {
          analyze: async () => [
            { type: "NAVIGATE", url: "https://example.com" },
            { type: "CLICK", target: { role: "button", name: "Go" } },
            { type: "ASSERT", target: { role: "button", name: "Done" } },
          ],
        },
      },
      { videoPath: "demo.mp4", skillName: "video-demo" }
    );
    expect(result).toMatchObject({
      ok: true,
      verified: false,
      status: "draft",
      actions: 3,
    });
    expect(bucket.objects.has("spaces/s1/scripts/video-demo/code.ts")).toBe(
      false
    );
    expect(
      bucket.objects.has(
        "spaces/s1/assistant-learning/projects/p1/users/u1/video-demo.json"
      )
    ).toBe(true);
  });

  it("injects signatures without source leakage", () => {
    const prompt = composeSystemPrompt(
      undefined,
      undefined,
      undefined,
      '- `auto:sync` - Sync records - {"force":"boolean"}'
    );
    expect(prompt).toContain("# AVAILABLE COMMANDS & SKILLS");
    expect(prompt).toContain("auto:sync");
    expect(prompt).not.toContain("export async function");
  });

  it("moves health through unproven, proven, degrading, and broken", () => {
    let recent = recordRecentOutcome(undefined, { ok: true, at: 1 });
    expect(
      assessSkillHealth({
        success_count: 1,
        failure_count: 0,
        recent_outcomes: recent,
      }).state
    ).toBe("unproven");
    recent = recordRecentOutcome(recent, { ok: true, at: 2 });
    recent = recordRecentOutcome(recent, { ok: true, at: 3 });
    expect(
      assessSkillHealth({
        success_count: 3,
        failure_count: 0,
        recent_outcomes: recent,
      }).state
    ).toBe("proven");
    recent = recordRecentOutcome(recent, { ok: false, at: 4, error: "drift" });
    recent = recordRecentOutcome(recent, { ok: false, at: 5, error: "drift" });
    expect(
      assessSkillHealth({
        success_count: 3,
        failure_count: 2,
        recent_outcomes: recent,
      }).state
    ).toBe("degrading");
    recent = recordRecentOutcome(recent, { ok: false, at: 6, error: "drift" });
    expect(
      assessSkillHealth({
        success_count: 3,
        failure_count: 3,
        recent_outcomes: recent,
      }).state
    ).toBe("broken");
  });
});
