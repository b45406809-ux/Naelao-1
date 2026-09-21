import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildRepositoryIndex } from "../../../repomix/lib/repository-index.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

describe("repository implementation index", () => {
  it("indexes real imports, routes, bindings, symbols, packages, and associated tests", async () => {
    const index: any = await buildRepositoryIndex(repoRoot, ".repomix-cache/test-repository-index.json");
    expect(index.files["workers/router/src/index.ts"].routes.length).toBeGreaterThan(0);
    expect(index.files["workers/router/wrangler.toml"].bindings).toContain("SPACES_WORKER");
    expect(index.files["workers/spaces/src/do/SpaceDO.ts"].symbols).toContain("SpaceDO");
    expect(index.packages["naelao-router"].root).toBe("workers/router");
    expect(index.packages["@naelao/http"].entry_files).toContain("packages/http/src/index.ts");
    expect(index.reverse_imports).toBeTypeOf("object");
  }, 30_000);
});
