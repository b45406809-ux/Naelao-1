import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { platform } from "node:os";

function within(root, target) {
  const suffix = relative(root, target);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
}

/** Linux local-PC executor. bubblewrap exposes only system runtime directories read-only and
 * owner-consented folders read/write. The host's general filesystem and network are hidden. */
export function createLinuxSandboxExecutor({ spawn = nodeSpawn, exists = existsSync, realpathFn = realpath, os = platform() } = {}) {
  return async function executeIsolated(params, { signal, roots, output }) {
    if (os !== "linux") throw new Error("bridge_os_sandbox_unavailable");
    if (!Array.isArray(roots) || roots.length > 32 || typeof params?.command !== "string"
      || !params.command.trim() || params.command.length > 8192) throw new Error("bridge_sandbox_request_invalid");
    if (!exists("/usr/bin/bwrap") || !exists("/bin/sh")) throw new Error("bridge_bubblewrap_unavailable");

    const approvedRoots = [];
    for (const entry of roots) {
      const original = typeof entry === "string" ? entry : entry?.path;
      const access = typeof entry === "string" ? "readwrite" : entry?.access;
      if (!["read", "write", "readwrite"].includes(access)) throw new Error("bridge_sandbox_root_access_invalid");
      const root = await realpathFn(original);
      if (!isAbsolute(original) || root !== original || root === "/") throw new Error("bridge_consented_root_changed");
      approvedRoots.push({ path: root, access });
    }
    const requestedCwd = typeof params.cwd === "string" ? await realpathFn(params.cwd) : approvedRoots[0]?.path ?? "/tmp";
    if (approvedRoots.length ? !approvedRoots.some(root => within(root.path, requestedCwd)) : requestedCwd !== "/tmp") throw new Error("bridge_working_directory_denied");

    const args = ["--die-with-parent", "--new-session", "--unshare-all", "--clearenv",
      "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", "/tmp",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
    for (const systemPath of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
      if (exists(systemPath)) args.push("--ro-bind", systemPath, systemPath);
    }
    // Bind only explicitly consented roots. Create their destination parents inside the
    // namespace first; no host parent directory is mounted as a side effect.
    const namespaceDirs = new Set();
    for (const root of approvedRoots) {
      const parents = [];
      for (let current = dirname(root.path); current !== "/" && current !== "."; current = dirname(current)) parents.push(current);
      for (const parent of parents.reverse()) namespaceDirs.add(parent);
      namespaceDirs.add(root.path);
    }
    for (const dir of [...namespaceDirs].sort((a, b) => a.length - b.length || a.localeCompare(b))) args.push("--dir", dir);
    for (const root of approvedRoots.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))) args.push(root.access === "read" ? "--ro-bind" : "--bind", root.path, root.path);
    args.push("--chdir", requestedCwd, "/bin/sh", "-c", params.command);

    return await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("bridge_request_cancelled"));
      const child = spawn("/usr/bin/bwrap", args, { stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
      let stdout = "", stderr = "", settled = false;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } } };
      const cleanup = () => { signal?.removeEventListener("abort", kill); };
      const finish = (error, value) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(value); };
      signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", chunk => { const text = chunk.toString("utf8"); stdout += text; output("stdout", text); });
      child.stderr.on("data", chunk => { const text = chunk.toString("utf8"); stderr += text; output("stderr", text); });
      child.on("error", error => finish(error));
      child.on("close", code => {
        if (signal?.aborted) return finish(new Error("bridge_request_cancelled"));
        finish(null, { exitCode: code ?? 1, stdout: stdout.slice(-65536), stderr: stderr.slice(-65536) });
      });
    });
  };
}
