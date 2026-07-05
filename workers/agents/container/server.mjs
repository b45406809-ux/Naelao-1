// Tier-5 harness — runs INSIDE the Cloudflare Container.
// Listens on :8080. Two routes:
//
// POST /build  { code }  ->  { built, tests_passed, logs }
//   The §02 micro-tool build/test gate (BusinessDO legacy path):
//   1. write the submitted code to a temp module
//   2. type-check / transpile it (esbuild)
//   3. import it and run its exported runTests() -> { passed, results[] }
//
// POST /exec  { name, code, args, workspace_files? }  ->  { ok, result?, error?, logs?, workspace_files_out? }
//   General Tier-5 script execution (script-engine execution-ladder §8): the script
//   exports `export async function run(args, ctx) { ... return result; }`. Bundled with
//   esbuild (so it can use Node builtins/npm deps installed in the image) then imported
//   and invoked with the agent's args. `ctx.workspaceDir` (also the process cwd for the
//   duration of the run) is /workspace — Tier-5 scripts get a real OS (filesystem,
//   child_process), unlike Tiers 2-4.
//
//   §A1.17 Phase K: `workspace_files` (relPath -> text content), when present, is the calling
//   ToolSandboxDO's R2 workspace sync — materialized under /workspace BEFORE the script runs,
//   walked back into `workspace_files_out` AFTER it returns, so the DO can write changes (and
//   deletions) back to R2. This container has no native R2 mount; this request-scoped
//   materialize/collect is what makes /workspace behave as if it were persistently mounted.

import { createServer } from "node:http";
import { writeFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { build } from "esbuild";

const PORT = 8080;
const EXEC_TIMEOUT_MS = 55_000;
const WORKSPACE_DIR = "/workspace";
// Mirrors ToolSandboxDO's own sync bounds — the harness enforces its side independently so a
// runaway script can't OOM/hang the container even if the DO's caps were somehow bypassed.
const MAX_WORKSPACE_FILES = 300;
const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;

async function materializeWorkspace(files) {
  await mkdir(WORKSPACE_DIR, { recursive: true });
  for (const [relPath, content] of Object.entries(files ?? {})) {
    const dest = join(WORKSPACE_DIR, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
  }
}

async function collectWorkspace() {
  const out = {};
  let count = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_WORKSPACE_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_WORKSPACE_FILE_BYTES) continue;
        try {
          out[relative(WORKSPACE_DIR, full)] = await readFile(full, "utf8");
          count++;
        } catch {
          // Binary/unreadable-as-utf8 file — skip rather than corrupt it (matches the
          // platform's existing R2-workspace convention of text-only content).
        }
      }
    }
  }
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await walk(WORKSPACE_DIR);
  return out;
}

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

async function execScript(name, code, args, workspaceFiles) {
  const dir = await mkdtemp(join(tmpdir(), "exec-"));
  const src = join(dir, "script.ts");
  const out = join(dir, "script.mjs");
  // §A1.17 Phase K: only materialize/collect /workspace when the caller (ToolSandboxDO) is
  // actually doing the R2 sync dance — a bare /exec call with no workspace_files (e.g. local
  // dev without SCRIPTS_R2 bound) skips this entirely rather than touching a shared directory
  // for no reason.
  const syncWorkspace = workspaceFiles !== undefined;
  try {
    if (syncWorkspace) await materializeWorkspace(workspaceFiles);
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
    const result = await Promise.race([mod.run(args ?? {}, { workspaceDir: WORKSPACE_DIR }), timeout]);
    return { ok: true, result, ...(syncWorkspace ? { workspace_files_out: await collectWorkspace() } : {}) };
  } catch (err) {
    // Collect on failure too — a script that wrote files before throwing shouldn't lose that
    // work (e.g. a multi-step Python job that fails partway through step 3 of 5).
    return {
      ok: false,
      error: String(err).slice(0, 2000),
      ...(syncWorkspace ? { workspace_files_out: await collectWorkspace().catch(() => undefined) } : {}),
    };
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
  // §A1.17 Phase K: an /exec body can now carry a project's synced workspace_files (bounded to
  // ~25MB by ToolSandboxDO) on top of the script code itself — raised from the original 5MB.
  const MAX_BODY_BYTES = 30_000_000;
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > MAX_BODY_BYTES) req.destroy(); });
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      if (!parsed.code) { res.writeHead(400).end(JSON.stringify({ error: "code required" })); return; }
      const result = isExec
        ? await execScript(parsed.name ?? "script", parsed.code, parsed.args, parsed.workspace_files)
        : await buildAndTest(parsed.code);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500).end(JSON.stringify(
        isExec ? { ok: false, error: String(err) } : { built: false, tests_passed: false, logs: String(err) }
      ));
    }
  });
}).listen(PORT, () => console.log(`tool-sandbox harness listening on :${PORT}`));
