import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

const SPACE_EGRESS_BOUNDARIES = [
  "workers/notifications/src/index.ts",
  "workers/mcp-hub/src/index.ts",
  "workers/knowledge/src/index.ts",
  "workers/credentials/src/index.ts",
  "workers/spaces/src/product-end-user-routes.ts",
  "workers/threads/src/index.ts",
  "workers/mini-agi/src/index.ts",
] as const;

describe("space air-gap boundary wiring", () => {
  it("keeps every space-bound final egress boundary on the shared fail-closed policy", async () => {
    const sources = await Promise.all(SPACE_EGRESS_BOUNDARIES.map(async (relativePath) => ({
      relativePath,
      source: await readFile(resolve(root, relativePath), "utf8"),
    })));

    for (const { relativePath, source } of sources) {
      expect(source, relativePath).toContain("isSpaceNetworkEgressDenied");
    }
  });

  it("keeps the execution host fail-closed for cloud/browser paths", async () => {
    const source = await readFile(resolve(root, "workers/agents/src/script-engine/code-runner.ts"), "utf8");
    expect(source).toContain("airGappedOnly");
    expect(source).toContain("globalOutbound: null");
    expect(source).toContain("air-gapped execution only permits the authorized local workstation backend");
  });
});
