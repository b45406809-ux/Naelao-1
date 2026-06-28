// Tier-5 build/test harness — runs INSIDE the Cloudflare Container.
// Listens on :8080 and builds + tests a micro-tool's TypeScript source.
//
// POST /build  { code }  ->  { built, tests_passed, logs }
//   1. write the submitted code to a temp module
//   2. type-check / transpile it (esbuild)
//   3. import it and run its exported runTests() -> { passed, results[] }
//
// A tool only passes if it builds AND its own tests pass — this is the §02 gate's
// executor. Scripts that need other runtimes (e.g. Python) can shell out from here.

import { createServer } from "node:http";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const PORT = 8080;

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

createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/build")) {
    res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
  req.on("end", async () => {
    try {
      const { code } = JSON.parse(body || "{}");
      if (!code) { res.writeHead(400).end(JSON.stringify({ error: "code required" })); return; }
      const result = await buildAndTest(code);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500).end(JSON.stringify({ built: false, tests_passed: false, logs: String(err) }));
    }
  });
}).listen(PORT, () => console.log(`tool-sandbox harness listening on :${PORT}`));
