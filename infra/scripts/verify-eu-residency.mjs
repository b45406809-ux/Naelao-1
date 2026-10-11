import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const workersDir = resolve(root, "workers");
const manifestArg = process.argv.find((value) => value.startsWith("--manifest="));

function blocks(text, heading) {
  const pattern = new RegExp(`\\[\\[${heading}\\]\\]([\\s\\S]*?)(?=\\n\\[|$)`, "g");
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function quoted(block, key) {
  return block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
}

export async function inventory() {
  const rows = [];
  for (const entry of await readdir(workersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(workersDir, entry.name, "wrangler.toml");
    let text;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    for (const block of blocks(text, "d1_databases")) {
      const id = quoted(block, "database_id");
      if (id) rows.push({ worker: entry.name, kind: "d1", resource: id, binding: quoted(block, "binding") ?? "" });
    }
    for (const block of blocks(text, "r2_buckets")) {
      const name = quoted(block, "bucket_name");
      if (name) rows.push({ worker: entry.name, kind: "r2", resource: name, binding: quoted(block, "binding") ?? "" });
    }
  }
  return rows;
}

export function verify(rows, manifest) {
  const failures = [];
  const resources = new Map((manifest.resources ?? []).map((item) => [`${item.kind}:${item.resource}`, item]));
  for (const row of rows) {
    const proof = resources.get(`${row.kind}:${row.resource}`);
    if (!proof) failures.push(`${row.worker}:${row.binding} has no creation proof for ${row.kind}:${row.resource}`);
    else if (proof.jurisdiction !== "eu" || proof.createdInJurisdiction !== true)
      failures.push(`${row.kind}:${row.resource} is not proven EU-created`);
    else if (typeof proof.evidence !== "string" || !proof.evidence.trim())
      failures.push(`${row.kind}:${row.resource} has no creation evidence reference`);
  }
  if (manifest.regionalServices?.enabled !== true || !manifest.regionalServices?.evidence?.trim())
    failures.push("Regional Services is not evidenced as enabled");
  if (manifest.customerMetadataBoundary?.enabled !== true || !manifest.customerMetadataBoundary?.evidence?.trim())
    failures.push("Customer Metadata Boundary is not evidenced as enabled");
  return [...new Set(failures)];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const rows = await inventory();
  if (!manifestArg) {
    console.log(JSON.stringify({ resources: rows, uniqueResources: new Set(rows.map((row) => `${row.kind}:${row.resource}`)).size }, null, 2));
    if (process.argv.includes("--enforce")) process.exitCode = 2;
  } else {
    const manifest = JSON.parse(await readFile(resolve(root, manifestArg.slice("--manifest=".length)), "utf8"));
    const failures = verify(rows, manifest);
    console.log(JSON.stringify({ checkedBindings: rows.length, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  }
}
