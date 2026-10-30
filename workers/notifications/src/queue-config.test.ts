import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const config = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");

describe("Notifications queue consumer limits", () => {
  it("keeps serial provider delivery batches bounded in every deployment environment", () => {
    const blocks = [...config.matchAll(/^\[\[([^\]]+)\]\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)]
      .filter((match) => match[1]?.endsWith("queues.consumers"))
      .map((match) => match[2] ?? "");

    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).toMatch(/^max_batch_size\s*=\s*10$/m);
      expect(block).toMatch(/^max_batch_timeout\s*=\s*10$/m);
      expect(block).toMatch(/^max_retries\s*=\s*3$/m);
    }
  });
});
