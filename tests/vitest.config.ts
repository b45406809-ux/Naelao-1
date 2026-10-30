import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";

// Root worker tests import workspace packages from their TypeScript source. Without these aliases,
// Vite resolves each package's published `dist` entry, which may be stale in a clean checkout and
// gives root tests behavior that differs from the owning worker/package test configuration.
const packageAliases = readdirSync(new URL("../packages/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const packageUrl = new URL(`../packages/${entry.name}/`, import.meta.url);
    const manifestUrl = new URL("package.json", packageUrl);
    if (!existsSync(fileURLToPath(manifestUrl))) return [];
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
      name?: string;
      exports?: Record<string, string | { default?: string; import?: string; types?: string }>;
    };
    if (!manifest.name?.startsWith("@naelao/")) return [];
    const entries: Array<[string, string]> = [];
    const sourceDirectory = new URL("src/", packageUrl);
    if (existsSync(fileURLToPath(sourceDirectory))) {
      entries.push([`${manifest.name}/src/`, fileURLToPath(sourceDirectory)]);
    }
    for (const [exportName, descriptor] of Object.entries(manifest.exports ?? {})) {
      const target = typeof descriptor === "string" ? descriptor : descriptor.default ?? descriptor.import ?? descriptor.types;
      if (!target) continue;
      const sourceBase = target.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts");
      const candidates = [sourceBase, sourceBase.replace(/\.ts$/, ".js")];
      const source = candidates.map((path) => new URL(path, packageUrl)).find((url) => existsSync(fileURLToPath(url)));
      if (source) entries.push([exportName === "." ? manifest.name : `${manifest.name}${exportName.slice(1)}`, fileURLToPath(source)]);
    }
    if (!entries.some(([name]) => name === manifest.name)) {
      const sourceUrl = ["src/index.ts", "src/index.js"].map((path) => new URL(path, packageUrl)).find((url) => existsSync(fileURLToPath(url)));
      if (sourceUrl) entries.push([manifest.name, fileURLToPath(sourceUrl)]);
    }
    return entries;
  })
  .sort(([left], [right]) => right.length - left.length);

export default defineConfig({
  // Keep the repository-level suite rooted in tests/. Without an explicit root Vitest 4 walks
  // package and Worker tests too, running them under this Node-only config and producing false
  // failures (wrong aliases, Wrangler cwd, and Worker runtime setup).
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      ...packageAliases.map(([find, replacement]) => ({ find, replacement })),
      // Allow worker code that imports the CF runtime module to load under Node.
      { find: "cloudflare:workers", replacement: fileURLToPath(new URL("./stubs/cloudflare-workers.ts", import.meta.url)) },
      { find: "agents/voice", replacement: fileURLToPath(new URL("./stubs/agents-voice.ts", import.meta.url)) },
      { find: "agents", replacement: fileURLToPath(new URL("./stubs/agents.ts", import.meta.url)) },
      // Shell source uses this app-local alias; its components are imported by focused unit tests.
      { find: "@", replacement: fileURLToPath(new URL("../apps/shell/src/", import.meta.url)) },
    ],
  },
  test: {
    server: { deps: { inline: ["@cloudflare/dynamic-workflows", "@cloudflare/containers"] } },
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
