import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync("wrangler.toml", "utf8");

describe("Provisioner queue consumer limits", () => {
  it("runs one multi-call provisioning saga per invocation in every environment", () => {
    const consumers = [...config.matchAll(/^\[\[([^\]]+)\]\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)]
      .filter((match) => match[1]?.endsWith("queues.consumers"))
      .map((match) => match[2] ?? "")
      .filter((block) => /^queue\s*=\s*"naelao-provisioning-queue"$/m.test(block));

    expect(consumers).toHaveLength(3);
    for (const block of consumers) {
      expect(block).toMatch(/^max_batch_size\s*=\s*1$/m);
      expect(block).toMatch(/^max_concurrency\s*=\s*10$/m);
      expect(block).toMatch(/^max_retries\s*=\s*3$/m);
    }
  });
});
