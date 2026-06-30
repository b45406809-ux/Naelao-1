// Tier-5 harness — runs INSIDE the Cloudflare Container.
// Listens on :8080. Two routes:
//
// POST /build  { code }  ->  { built, tests_passed, logs }
//   The §02 micro-tool build/test gate (BusinessDO legacy path):
//   1. write the submitted code to a temp module
//   2. type-check / transpile it (esbuild)
//   3. import it and run its exported runTests() -> { passed, results[] }
//
// POST /exec  { name, code, args }  ->  { ok, result?, error?, logs }
//   General Tier-5 script execution (script-engine execution-ladder §8): the script
//   exports `export async function run(args, ctx) { ... return result; }`. Bundled with
//   esbuild (so it can use Node builtins/npm deps installed in the image) then imported
//   and invoked with the agent's args. `ctx` exposes nothing beyond what Node provides —
//   Tier-5 scripts get a real OS (filesystem, child_process), unlike Tiers 2-4.

import { createServer } from "node:http";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const PORT = 8080;
const EXEC_TIMEOUT_MS = 55_000;

async function buildAndTest(code) {
  const logs = [];
  const dir = await mkdtemp(join(tmpdir(), "tool-"));
  const src = join(dir, "tool.ts");
  const out = join(dir, "tool.mjs");
  try {
    await writeFile(src, code, "utf8");

    // 1+2. Build (this is also the type/transpile gate).
    try {
      await build({ entryPoints: [src], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
      logs.push("build: ok");
    } catch (err) {
      logs.push(`build: failed — ${String(err).slice(0, 1000)}`);
      return { built: false, tests_passed: false, logs: logs.join("\n") };
    }

    // 3. Run the tool's own tests.
    const mod = await import(`file://${out}`);
    if (typeof mod.runTests !== "function") {
      logs.push("tests: tool exports no runTests() — cannot verify it works");
      return { built: true, tests_passed: false, logs: logs.join("\n") };
    }
    const result = await mod.runTests();
    const passed = !!(result && result.passed);
    logs.push(`tests: ${passed ? "passed" : "failed"}`);
    if (Array.isArray(result?.results)) logs.push(...result.results.map(String));
    return { built: true, tests_passed: passed, logs: logs.join("\n") };
  } catch (err) {
    logs.push(`harness error: ${String(err).slice(0, 1000)}`);
    return { built: false, tests_passed: false, logs: logs.join("\n") };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function execScript(name, code, args) {
  const dir = await mkdtemp(join(tmpdir(), "exec-"));
  const src = join(dir, "script.ts");
  const out = join(dir, "script.mjs");
  try {
    await writeFile(src, code, "utf8");
    try {
      await build({ entryPoints: [src], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
    } catch (err) {
      return { ok: false, error: `build failed: ${String(err).slice(0, 1000)}` };
    }
    const mod = await import(`file://${out}`);
    if (typeof mod.run !== "function") {
      return { ok: false, error: `script '${name}' does not export an async function named 'run'` };
    }
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("execution timed out")), EXEC_TIMEOUT_MS)
    );
    const result = await Promise.race([mod.run(args ?? {}, {}), timeout]);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 2000) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

createServer((req, res) => {
  if (req.method !== "POST" || (!req.url?.endsWith("/build") && !req.url?.endsWith("/exec"))) {
    res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const isExec = req.url.endsWith("/exec");
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      if (!parsed.code) { res.writeHead(400).end(JSON.stringify({ error: "code required" })); return; }
      const result = isExec
        ? await execScript(parsed.name ?? "script", parsed.code, parsed.args)
        : await buildAndTest(parsed.code);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500).end(JSON.stringify(
        isExec ? { ok: false, error: String(err) } : { built: false, tests_passed: false, logs: String(err) }
      ));
    }
  });
}).listen(PORT, () => console.log(`tool-sandbox harness listening on :${PORT}`));
