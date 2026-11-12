import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "workers/agents/package.json");
const require = createRequire(packagePath);
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
const expectedEsbuild = manifest.devDependencies?.esbuild;
if (typeof expectedEsbuild !== "string") throw new Error("agents_esbuild_version_missing");

const esbuildManifest = require.resolve("esbuild/package.json");
const platformName = `@esbuild/${process.platform}-${process.arch}`;
const esbuildRequire = createRequire(esbuildManifest);
let platformManifest;
try { platformManifest = esbuildRequire.resolve(`${platformName}/package.json`); }
catch { throw new Error(`agents_container_platform_package_unavailable:${platformName}`); }
const actualEsbuild = JSON.parse(readFileSync(esbuildManifest, "utf8")).version;
if (actualEsbuild !== expectedEsbuild) throw new Error(`agents_esbuild_version_mismatch:${actualEsbuild}`);

const target = join(root, "workers/agents/container/.vendor/node_modules");
mkdirSync(join(target, "@esbuild"), { recursive: true });
cpSync(dirname(esbuildManifest), join(target, "esbuild"), { recursive: true, dereference: true, force: true });
cpSync(dirname(platformManifest), join(target, platformName), { recursive: true, dereference: true, force: true });
console.log(`Staged esbuild ${actualEsbuild} and ${platformName} for the Agents container build.`);
