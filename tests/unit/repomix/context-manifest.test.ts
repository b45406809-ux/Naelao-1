import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deterministicSeed, expandContextManifest, sliceSource, validateContextManifest } from "../../../repomix/lib/context-manifest.mjs";

const index: any = {
  files: {
    "workers/router/src/index.ts": { package: "router", imports: ["packages/auth/src/index.ts"], routes: [{ method: "GET", path: "/spaces/:spaceId/projects" }], bindings: ["SPACES_WORKER"], symbols: ["api"], tests: ["tests/router.test.ts"] },
    "packages/auth/src/index.ts": { package: "auth", imports: [], routes: [], bindings: [], symbols: ["authorize"], tests: [] },
    "tests/router.test.ts": { package: null, imports: [], routes: [], bindings: [], symbols: [], tests: [] },
    "workers/router/package.json": { package: "router", imports: [], routes: [], bindings: [], symbols: [], tests: [] },
    "workers/router/tsconfig.json": { package: "router", imports: [], routes: [], bindings: [], symbols: [], tests: [] },
    "workers/router/wrangler.toml": { package: "router", imports: [], routes: [], bindings: ["SPACES_WORKER"], symbols: [], tests: [] },
  },
  packages: { router: { root: "workers/router", files: [], dependencies: [] }, auth: { root: "packages/auth", files: [], dependencies: [] } }, reverse_imports: {},
};
const raw = { read_files: ["workers/router/src/index.ts"], edit_files: ["workers/router/src/index.ts"], new_files: ["tests/new.test.ts"], test_files: ["tests/router.test.ts"], bindings: ["SPACES_WORKER"], migrations: [], request_paths: ["GET /spaces/:spaceId/projects"], commands: ["typecheck"], checklist: ["authorize before binding access"], symbols: { "workers/router/src/index.ts": ["api"] } };

describe("dependency-aware context manifests", () => {
  it("validates paths and expands imports, tests, package config, and matching bindings", () => {
    const manifest = validateContextManifest(raw, index);
    expect(expandContextManifest(manifest, index)).toEqual(expect.arrayContaining(["packages/auth/src/index.ts", "tests/router.test.ts", "workers/router/package.json", "workers/router/tsconfig.json", "workers/router/wrangler.toml"]));
  });
  it("rejects invented and traversing paths", () => {
    expect(() => validateContextManifest({ ...raw, edit_files: ["../secret"] }, index)).toThrow(/unknown or unsafe/);
    expect(() => validateContextManifest({ ...raw, new_files: ["workers/router/src/index.ts"] }, index)).toThrow(/does not exist/);
    expect(validateContextManifest({ ...raw, new_files: ["tests/new.test.ts"], test_files: ["tests/new.test.ts"] }, index).test_files).toContain("tests/new.test.ts");
  });
  it("uses route, symbol, binding, and path metadata rather than filename alone", () => {
    expect(deterministicSeed("authorize SPACES_WORKER GET /spaces projects", index, 2)).toContain("workers/router/src/index.ts");
  });
  it("creates complete AST symbol slices instead of dropping large TypeScript files", async () => {
    const root = await mkdtemp(join(tmpdir(), "repomix-slice-"));
    const filler = "const filler = 'x'.repeat(10);\n".repeat(7000);
    await writeFile(join(root, "large.ts"), `import { x } from './x';\n${filler}\nexport function target() { return x; }\nexport function unrelated() { return 1; }\n`);
    const sliced = await sliceSource(root, "large.ts", ["target"], []);
    expect(sliced.complete).toBe(false);
    expect(sliced.content).toContain("function target");
    expect(sliced.content).not.toContain("function unrelated");
    expect(sliced.content).toContain("import { x }");
  });
});
