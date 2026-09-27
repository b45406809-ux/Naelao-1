// Tier-5 harness — runs INSIDE the Cloudflare Container.
// Listens on :8080. Two routes:
//
// POST /build  { code }  ->  { built, tests_passed, logs }
//   The §02 micro-tool build/test gate (BusinessDO legacy path):
//   1. write the submitted code to a temp module
//   2. type-check / transpile it (esbuild)
//   3. import it and run its exported runTests() -> { passed, results[] }
//
// POST /exec  { name, code, args }  ->  { ok, result?, error?, logs? }
//   General Tier-5 script execution (script-engine execution-ladder §8): the script
//   exports `export async function run(args, ctx) { ... return result; }`. Bundled with
//   esbuild (so it can use Node builtins/npm deps installed in the image) then imported
//   and invoked with the agent's args. `ctx.workspaceDir` (also the process cwd for the
//   duration of the run) is /workspace — Tier-5 scripts get a real OS (filesystem,
//   child_process), unlike Tiers 2-4.
//
//   §A1.17 Phase R: /workspace is this container's OWN local disk — it persists across calls
//   to the SAME warm container instance with NO R2 round-trip, and starts genuinely EMPTY on a
//   cold start. Phase K's every-/exec-call blind full materialize/collect (workspace_files /
//   workspace_files_out, bounded 300 files / 2MB / 25MB) is gone: an agent explicitly moves
//   what it needs via the workspace.copy/move/list prebuilt (POST /workspace/{read,write,list,
//   delete} below), the same way it would reason about two genuinely different filesystems.
//
// POST /workspace/write  { files: {relPath: content} }        -> { ok }
// POST /workspace/read   { paths?: [relPath, ...] }            -> { files: {relPath: content} }
//   (paths omitted = every file currently under /workspace, same bound as before)
// POST /workspace/list   {}                                    -> { files: [relPath, ...] }
// POST /workspace/delete { paths: [relPath, ...] }              -> { ok }

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startBinaryBridge } from "./binary-bridge.mjs";
import { ArtifactFS } from "./artifact-fs.mjs";

const execFileAsync = promisify(execFile);

const PORT = 8080;
const EXEC_TIMEOUT_MS = 55_000;
const WORKSPACE_DIR = "/workspace";
// Mirrors ToolSandboxDO's own sync bounds — the harness enforces its side independently so a
// runaway script can't OOM/hang the container even if the DO's caps were somehow bypassed.
const MAX_WORKSPACE_FILES = 300;
const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;

function safeWorkspacePath(path) {
  const value = String(path).replaceAll("\\", "/");
  if (value.startsWith("/.avos") || value === ".avos" || value.startsWith(".avos/")) throw new Error("agent state is not a deliverable");
  const relativePath = value.startsWith("/workspace/") ? value.slice(11) : value.replace(/^\/+/, "");
  const parts = relativePath.split("/");
  if (!relativePath || parts.some((part) => !part || part === "." || part === "..")) throw new Error("workspace path traversal rejected");
  return parts.join("/");
}

async function materializeWorkspace(files) {
  await mkdir(WORKSPACE_DIR, { recursive: true });
  for (const [relPath, content] of Object.entries(files ?? {})) {
    const dest = join(WORKSPACE_DIR, safeWorkspacePath(relPath));
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
      if (entry.name === ".avos" || entry.name === "node_modules") continue;
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

// §A1.17 Phase R: explicit read of specific paths (workspace.copy('container','r2', path)) —
// falls back to collectWorkspace()'s full walk when no paths are given (workspace.list-adjacent
// callers that want everything).
async function readWorkspacePaths(paths) {
  if (!paths || paths.length === 0) return collectWorkspace();
  const out = {};
  for (const relPath of paths.slice(0, MAX_WORKSPACE_FILES)) {
    try {
      const safePath = safeWorkspacePath(relPath);
      const full = join(WORKSPACE_DIR, safePath);
      const info = await stat(full);
      if (info.size > MAX_WORKSPACE_FILE_BYTES) continue;
      out[safePath] = await readFile(full, "utf8");
    } catch {
      // missing/unreadable — simply absent from the result, not an error for the whole batch
    }
  }
  return out;
}

async function listWorkspacePaths() {
  const names = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (names.length >= MAX_WORKSPACE_FILES) return;
      const full = join(dir, entry.name);
      if (entry.name === ".avos" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) names.push(relative(WORKSPACE_DIR, full));
    }
  }
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await walk(WORKSPACE_DIR);
  return names;
}

async function deleteWorkspacePaths(paths) {
  for (const relPath of paths ?? []) {
    await rm(join(WORKSPACE_DIR, relPath), { force: true }).catch(() => {});
  }
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
      await build({
        entryPoints: [src],
        outfile: out,
        bundle: true,
        format: "esm",
        platform: "node",
        logLevel: "silent",
      });
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
    if (Array.isArray(result?.results))
      logs.push(...result.results.map(String));
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
  // §A1.17 Phase R: /workspace is untouched here — it's whatever this warm container's own
  // disk already has from a prior call plus whatever workspace.copy explicitly staged in. No
  // implicit materialize/collect around the run anymore (see the file header comment).
  try {
    await writeFile(src, code, "utf8");
    try {
      await build({
        entryPoints: [src],
        outfile: out,
        bundle: true,
        format: "esm",
        platform: "node",
        logLevel: "silent",
      });
    } catch (err) {
      return {
        ok: false,
        error: `build failed: ${String(err).slice(0, 1000)}`,
      };
    }
    const mod = await import(`file://${out}`);
    if (typeof mod.run !== "function") {
      return {
        ok: false,
        error: `script '${name}' does not export an async function named 'run'`,
      };
    }
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("execution timed out")),
        EXEC_TIMEOUT_MS
      )
    );
    const result = await Promise.race([
      mod.run(args ?? {}, { workspaceDir: WORKSPACE_DIR }),
      timeout,
    ]);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 2000) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const WORKSPACE_ROUTES = new Set([
  "/workspace/read",
  "/workspace/write",
  "/workspace/list",
  "/workspace/delete",
  "/workspace/rehydrate",
]);
const DISPLAY_ROUTES = new Set([
  "/computer/action",
  "/computer/screenshot",
  "/display/capture",
  "/display/mouse",
  "/display/type",
]);
const SESSION_ROUTES = new Set(["/shell"]);
const ARTIFACT_ROUTES = new Set(["/artifact/mount", "/artifact/read", "/artifact/write", "/artifact/flush"]);
let artifactFs;
let shuttingDown = false;

createServer((req, res) => {
  const path = req.url ?? "";
  if (req.method === "POST" && path.endsWith("/shutdown")) {
    shuttingDown = true;
    res.writeHead(200, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ ok: true, flushed: true }));
    return;
  }
  if (shuttingDown) {
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "container_shutting_down" }));
    return;
  }
  const isWorkspaceRoute = [...WORKSPACE_ROUTES].some((r) => path.endsWith(r));
  const isDisplayRoute = [...DISPLAY_ROUTES].some((r) => path.endsWith(r));
  const isSessionRoute = [...SESSION_ROUTES].some((r) => path.endsWith(r));
  const isArtifactRoute = [...ARTIFACT_ROUTES].some((r) => path.endsWith(r));
  if (
    req.method !== "POST" ||
    (!path.endsWith("/build") &&
      !path.endsWith("/exec") &&
      !isWorkspaceRoute &&
      !isDisplayRoute &&
      !isSessionRoute &&
      !isArtifactRoute)
  ) {
    res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const isExec = path.endsWith("/exec");
  const MAX_BODY_BYTES = 10_000_000; // §A1.17 Phase R: no more bundled workspace_files, back to a script-code-sized budget
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > MAX_BODY_BYTES) req.destroy();
  });
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      if (isArtifactRoute) {
        if (path.endsWith("/artifact/mount")) {
          if (!parsed.repository_url) throw new Error("repository_url required");
          artifactFs = new ArtifactFS({ root: WORKSPACE_DIR, repositoryUrl: parsed.repository_url, headers: parsed.headers ?? {} });
          const mounted = await artifactFs.mount(parsed.branch ?? "main");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...mounted })); return;
        }
        if (!artifactFs) throw new Error("ArtifactFS is not mounted");
        if (path.endsWith("/artifact/read")) {
          const bytes = await artifactFs.open(parsed.path);
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes); return;
        }
        if (path.endsWith("/artifact/write")) await artifactFs.write(parsed.path, Buffer.from(parsed.content_base64, "base64"));
        const result = path.endsWith("/artifact/flush")
          ? await artifactFs.flushAndCommit({ message: parsed.message ?? "container changes", metadata: parsed.metadata, expected_head: parsed.expected_head })
          : { ok: true };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result)); return;
      }
      if (isSessionRoute) {
        const cwd = String(parsed.session?.cwd || WORKSPACE_DIR);
        if (cwd !== WORKSPACE_DIR && !cwd.startsWith(`${WORKSPACE_DIR}/`)) throw new Error("shell cwd escapes workspace");
        const marker = `__NAELAO_STATE_${crypto.randomUUID()}__`;
        const script = `${String(parsed.command ?? "")}\n__status=$?\nprintf '\\n${marker}%s\\n' "$__status"\npwd -P\nprintf '${marker}ENV\\n'\nenv -0`;
        const { stdout, stderr } = await execFileAsync("bash", ["-lc", script], {
          cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(parsed.session?.env ?? {}) }, maxBuffer: 16 * 1024 * 1024,
        }).catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }));
        const text = String(stdout);
        const stateAt = text.lastIndexOf(`\n${marker}`);
        const visible = stateAt >= 0 ? text.slice(0, stateAt) : text;
        const state = stateAt >= 0 ? text.slice(stateAt + marker.length + 1) : "1\n" + cwd;
        const [statusLine, cwdLine, envBlock = ""] = state.split(`${marker}ENV\n`)[0].split("\n").length >= 2
          ? [state.split("\n")[0], state.split("\n")[1], state.split(`${marker}ENV\n`)[1] ?? ""] : ["1", cwd, ""];
        const env = Object.fromEntries(envBlock.split("\0").filter(Boolean).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: Number(statusLine) === 0, status: Number(statusLine), stdout: visible, stderr: String(stderr), session: { cwd: cwdLine || cwd, env } }));
        return;
      }
      if (isWorkspaceRoute) {
        let result;
        if (path.endsWith("/workspace/write")) {
          await materializeWorkspace(parsed.files);
          result = { ok: true };
        } else if (path.endsWith("/workspace/rehydrate")) {
          const started = Date.now();
          await execFileAsync("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
            cwd: WORKSPACE_DIR, timeout: 120_000,
            env: { ...process.env, npm_config_registry: process.env.EDGE_NPM_REGISTRY ?? "https://registry.npmjs.org" },
          });
          result = { ok: true, duration_ms: Date.now() - started };
        } else if (path.endsWith("/workspace/read"))
          result = { files: await readWorkspacePaths(parsed.paths) };
        else if (path.endsWith("/workspace/list"))
          result = { files: await listWorkspacePaths() };
        else {
          await deleteWorkspacePaths(parsed.paths);
          result = { ok: true };
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(result));
        return;
      }
      if (isDisplayRoute) {
        if (path.endsWith("/display/capture") || path.endsWith("/computer/screenshot")) {
          try {
            const { stdout: frame } = await execFileAsync("import", ["-window", "root", "png:-"], {
              encoding: "buffer", env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" }, maxBuffer: 16 * 1024 * 1024,
            });
            res.writeHead(200, { "content-type": "image/png" }).end(frame);
          } catch (error) {
            res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "display_capture_unavailable", detail: String(error) }));
          }
          return;
        }
        if (path.endsWith("/computer/action")) {
          const action = parsed.action;
          const args = [];
          if (action === "move") args.push("mousemove", "--sync", String(parsed.x), String(parsed.y));
          else if (action === "click") args.push("click", String({ left: 1, middle: 2, right: 3 }[parsed.button ?? "left"] ?? parsed.button ?? 1));
          else if (action === "double_click") args.push("click", "--repeat", "2", "--delay", String(parsed.delay_ms ?? 100), "1");
          else if (action === "drag") args.push("mousemove", "--sync", String(parsed.from_x), String(parsed.from_y), "mousedown", "1", "mousemove", "--sync", String(parsed.to_x), String(parsed.to_y), "mouseup", "1");
          else if (action === "key") args.push("key", "--clearmodifiers", String(parsed.key));
          else if (action === "type") args.push("type", "--clearmodifiers", "--delay", String(parsed.delay_ms ?? 12), String(parsed.text ?? ""));
          else { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unsupported_computer_action" })); return; }
          await execFileAsync("xdotool", args, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" }, timeout: 10_000 });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, action }));
          return;
        }
        if (path.endsWith("/display/mouse")) {
          const button = { left: 1, middle: 2, right: 3 }[parsed.button ?? "left"] ?? 1;
          await execFileAsync("xdotool", ["mousemove", "--sync", String(parsed.x ?? 0), String(parsed.y ?? 0), "click", String(button)], { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" } });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, x: parsed.x ?? 0, y: parsed.y ?? 0, button: parsed.button ?? "left" }));
          return;
        }
        if (path.endsWith("/display/type")) {
          await execFileAsync("xdotool", ["type", "--clearmodifiers", String(parsed.text ?? "")], { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" } });
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: true, text: parsed.text ?? "" }));
          return;
        }
      }
      if (!parsed.code) {
        res.writeHead(400).end(JSON.stringify({ error: "code required" }));
        return;
      }
      const result = isExec
        ? await execScript(parsed.name ?? "script", parsed.code, parsed.args)
        : await buildAndTest(parsed.code);
      if (isExec && artifactFs) {
        result.workspace_sync = await artifactFs.flushAndCommit({
          message: `container: ${parsed.name ?? "script"}`,
          metadata: { source: "tool-sandbox" }, expected_head: parsed.expected_head,
        });
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(result));
    } catch (err) {
      res
        .writeHead(500)
        .end(
          JSON.stringify(
            isExec || isWorkspaceRoute
              ? { ok: false, error: String(err) }
              : { built: false, tests_passed: false, logs: String(err) }
          )
        );
    }
  });
}).listen(PORT, () =>
  console.log(`tool-sandbox harness listening on :${PORT}`)
);

startBinaryBridge();
