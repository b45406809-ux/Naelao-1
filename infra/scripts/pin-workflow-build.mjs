import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Run after producing the actual deployment bundle; no mutable source-version surrogate.
const [bundle, receipt] = process.argv.slice(2);
if (!bundle || !receipt) throw new Error("Usage: node infra/scripts/pin-workflow-build.mjs <actual-agent-worker-bundle> <receipt.json>");
const bytes = await readFile(resolve(bundle));
const digest = createHash("sha256").update(bytes).digest("hex");
await writeFile(resolve(receipt), JSON.stringify({ schema: 1, bundle: resolve(bundle), bytes: bytes.length, WORKFLOW_BUILD_ID: digest }, null, 2) + "\n", { flag: "wx" });
console.log("WORKFLOW_BUILD_ID=" + digest);
