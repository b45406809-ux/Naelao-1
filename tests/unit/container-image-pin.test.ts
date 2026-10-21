import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agent sandbox container base images", () => {
  it("pins every Node sandbox to the same audited image digest", () => {
    const digest = "sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
    for (const file of ["Dockerfile.toolsandbox", "Dockerfile.documents", "Dockerfile.media"]) {
      const dockerfile = readFileSync(new URL(`../../workers/agents/${file}`, import.meta.url), "utf8");
      expect(dockerfile.match(/^FROM\s+(.+)$/m)?.[1]).toBe(`node:22-slim@${digest}`);
    }
  });
});
