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
  chmod,
  chown,
  mkdtemp,
  readFile,
  readdir,
  lstat,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGuest, cancelExecution, cancelAllExecutions } from "./process-supervisor.mjs";
import { ArtifactFS } from "./artifact-fs.mjs";

const execFileAsync = promisify(execFile);

const PORT = 8080;
const EXEC_TIMEOUT_MS = 55_000;
const WORKSPACE_DIR = "/workspace";
// Mirrors ToolSandboxDO's own sync bounds — the harness enforces its side independently so a
// runaway script can't OOM/hang the container even if the DO's caps were somehow bypassed.
const MAX_WORKSPACE_FILES = 300;
const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;

async function assertWorkspaceAncestors(path) {
  let current = WORKSPACE_DIR;
  for (const part of safeWorkspacePath(path).split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("workspace symlink rejected");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function safeWorkspacePath(path) {
  const value = String(path).replaceAll("\\", "/");
  if (value.startsWith("/.avos") || value === ".avos" || value.startsWith(".avos/")) throw new Error("agent state is not a deliverable");
  const relativePath = value.startsWith("/workspace/") ? value.slice(11) : value.replace(/^\/+/, "");
  const parts = relativePath.split("/");
  if (!relativePath || parts.some((part) => !part || part === "." || part === "..")) throw new Error("workspace path traversal rejected");
  if (parts.some((part) => [".avos", ".naelao", ".git", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp"].includes(part) || part === ".env" || part.startsWith(".env.") && part !== ".env.example")) throw new Error("workspace control/cache/secret path rejected");
  return parts.join("/");
}

async function materializeWorkspace(files, binary = false) {
  await mkdir(WORKSPACE_DIR, { recursive: true });
  for (const [relPath, content] of Object.entries(files ?? {})) {
    await assertWorkspaceAncestors(relPath);
    const dest = join(WORKSPACE_DIR, safeWorkspacePath(relPath));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, binary ? Buffer.from(content, "base64") : content, binary ? undefined : "utf8");
  }
}

function encodedFile(bytes, encoding) {
  return encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
}

async function collectWorkspace(encoding = "text") {
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
      if (count >= MAX_WORKSPACE_FILES) throw new Error("workspace snapshot file limit exceeded");
      const full = join(dir, entry.name);
      if ([".avos", ".naelao", ".git", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp"].includes(entry.name) || entry.name === ".env" || entry.name.startsWith(".env.") && entry.name !== ".env.example") continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("workspace snapshot file size limit exceeded");
        try {
          out[relative(WORKSPACE_DIR, full)] = encodedFile(await readFile(full), encoding);
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
async function readWorkspacePaths(paths, encoding = "text") {
  if (!paths || paths.length === 0) return collectWorkspace(encoding);
  const out = {};
  if (paths.length > MAX_WORKSPACE_FILES) throw new Error("workspace read file limit exceeded");
  for (const relPath of paths) {
    try {
      const safePath = safeWorkspacePath(relPath);
      await assertWorkspaceAncestors(safePath);
      const full = join(WORKSPACE_DIR, safePath);
      const info = await stat(full);
      if (info.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("workspace read file size limit exceeded");
       out[safePath] = encodedFile(await readFile(full), encoding);
    } catch (error) {
      if (encoding === "base64") throw error;
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
      if (names.length >= MAX_WORKSPACE_FILES) throw new Error("workspace listing file limit exceeded");
      const full = join(dir, entry.name);
      if ([".avos", ".naelao", ".git", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp"].includes(entry.name) || entry.name === ".env" || entry.name.startsWith(".env.") && entry.name !== ".env.example") continue;
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
    const safe = safeWorkspacePath(relPath);
    await assertWorkspaceAncestors(safe);
    await rm(join(WORKSPACE_DIR, safe), { force: true });
  }
}

async function buildAndTest(code, execution) {
  const logs = [];
  const dir = await mkdtemp(join(tmpdir(), "tool-"));
  const src = join(dir, "tool.ts");
  const out = join(dir, "tool.mjs");
  try {
    await writeFile(src, code, "utf8");

    // 1+2. Build (this is also the type/transpile gate).
    try {
      await chown(dir, 10001, 10001); await chmod(dir, 0o700);
      const compiled = await runGuest(process.execPath, ["/app/compile-runner.mjs"], { ...execution, message: { src, out } });
      if (!compiled.result.ok) throw new Error(compiled.result.error);
      logs.push("build: ok");
    } catch (err) {
      logs.push(`build: failed — ${String(err).slice(0, 1000)}`);
      return { built: false, tests_passed: false, logs: logs.join("\n") };
    }

    // 3. Run the tool's own tests.
    await chmod(dir, 0o755);
    const child = await runGuest(process.execPath, ["/app/child-runner.mjs"], {
      ...execution, message: { modulePath: out, mode: "tests" },
    });
    if (!child.result.ok) throw new Error(child.result.error);
    const result = child.result.result;
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

async function execScript(name, code, args, execution) {
  const dir = await mkdtemp(join(tmpdir(), "exec-"));
  const src = join(dir, "script.ts");
  const out = join(dir, "script.mjs");
  // §A1.17 Phase R: /workspace is untouched here — it's whatever this warm container's own
  // disk already has from a prior call plus whatever workspace.copy explicitly staged in. No
  // implicit materialize/collect around the run anymore (see the file header comment).
  try {
    await writeFile(src, code, "utf8");
    try {
      await chown(dir, 10001, 10001); await chmod(dir, 0o700);
      const compiled = await runGuest(process.execPath, ["/app/compile-runner.mjs"], { ...execution, message: { src, out } });
      if (!compiled.result.ok) throw new Error(compiled.result.error);
    } catch (err) {
      return {
        ok: false,
        error: `build failed: ${String(err).slice(0, 1000)}`,
      };
    }
    await chmod(dir, 0o755);
    const child = await runGuest(process.execPath, ["/app/child-runner.mjs"], {
      ...execution, message: { modulePath: out, mode: "run", args: args ?? {} },
    });
    return { ...child.result, logs: (child.stdout + child.stderr).slice(0, 16000) };
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
let controlToken;

createServer((req, res) => {
  const path = req.url ?? "";
  // Initialization precedes any guest. Container ports must only be reachable through the
  // owning DO; a guest cannot read the root supervisor's token or authorize its own RPC.
  if (req.method === "POST" && path === "/control/init" && (!controlToken || req.headers["x-naelao-container-control"] === controlToken)) {
    const token = req.headers["x-naelao-container-control"];
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) { res.writeHead(403).end(); return; }
    controlToken = token;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })); return;
  }
  if (!controlToken || req.headers["x-naelao-container-control"] !== controlToken) { res.writeHead(403).end(); return; }
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, guest_uid: 10001, guest_capabilities: "none", no_new_privileges: true })); return;
  }
  if (req.method === "POST" && path === "/cancel") {
    cancelExecution(req.headers["x-naelao-execution-id"]);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === "POST" && path.endsWith("/shutdown")) {
    shuttingDown = true;
    cancelAllExecutions();
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
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  const MAX_BODY_BYTES = 10_000_000; // §A1.17 Phase R: no more bundled workspace_files, back to a script-code-sized budget
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > MAX_BODY_BYTES) req.destroy();
  });
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      const timeoutMs = Math.min(EXEC_TIMEOUT_MS, Number(req.headers["x-naelao-timeout-ms"] ?? EXEC_TIMEOUT_MS));
      const execution = { id: String(req.headers["x-naelao-execution-id"] ?? crypto.randomUUID()), signal: controller.signal, timeoutMs };
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
        const cwd = resolve(String(parsed.session?.cwd || WORKSPACE_DIR));
        if (cwd !== WORKSPACE_DIR && !cwd.startsWith(`${WORKSPACE_DIR}/`)) throw new Error("shell cwd escapes workspace");
        const marker = `__NAELAO_STATE_${crypto.randomUUID()}__`;
        const script = `${String(parsed.command ?? "")}\n__status=$?\nprintf '\\n${marker}%s\\n' "$__status"\npwd -P\nprintf '${marker}ENV\\n'\nenv -0`;
        const { stdout, stderr } = await runGuest("/bin/bash", ["-lc", script], {
          ...execution, cwd, env: parsed.session?.env ?? {},
        });
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
          await materializeWorkspace(parsed.files_base64 ?? parsed.files, Boolean(parsed.files_base64));
          result = { ok: true };
        } else if (path.endsWith("/workspace/rehydrate")) {
          const started = Date.now();
          await runGuest("/usr/local/bin/npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { ...execution, cwd: WORKSPACE_DIR });
          result = { ok: true, duration_ms: Date.now() - started };
        } else if (path.endsWith("/workspace/read"))
          result = parsed.encoding === "base64"
            ? { files_base64: await readWorkspacePaths(parsed.paths, "base64") }
            : { files: await readWorkspacePaths(parsed.paths) };
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
        ? await execScript(parsed.name ?? "script", parsed.code, parsed.args, execution)
        : await buildAndTest(parsed.code, execution);
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

// The former unauthenticated TCP bridge could bypass the control-token boundary. A future
// binary transport must authenticate each scoped request before enabling this listener.
