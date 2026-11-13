import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const config = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");

describe("Notifications queue consumer limits", () => {
  it("bounds primary and dead-letter consumers in every deployment environment", () => {
    const blocks = [...config.matchAll(/^\[\[([^\]]+)\]\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)]
      .filter((match) => match[1]?.endsWith("queues.consumers"))
      .map((match) => match[2] ?? "");

    expect(blocks).toHaveLength(6);
    expect(blocks.map((block) => block.match(/^queue\s*=\s*"([^"]+)"$/m)?.[1])).toEqual([
      "naelao-notifications-queue", "naelao-notifications-dlq",
      "naelao-notifications-queue-staging", "naelao-notifications-dlq-staging",
      "naelao-notifications-queue-production", "naelao-notifications-dlq-production",
    ]);
    for (const block of blocks) {
      expect(block).toMatch(/^max_batch_size\s*=\s*10$/m);
      expect(block).toMatch(/^max_batch_timeout\s*=\s*10$/m);
      expect(block).toMatch(/^max_retries\s*=\s*3$/m);
    }
  });
});
