import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";

const PINNED_IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
function within(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
}

/** Docker Desktop guest for macOS/Windows. The host mount list is always owner-consented,
 * image is pinned and preloaded, networking is disabled, and root/capabilities are dropped. */
export function createContainerSandboxExecutor({ spawn = nodeSpawn, realpathFn = realpath, os = process.platform } = {}) {
  return async function executeContainerSandbox(params, { signal, roots, output }) {
    if (!["darwin", "win32"].includes(os)) throw new Error("bridge_container_sandbox_platform_unsupported");
    if (!Array.isArray(roots) || roots.length > 32 || typeof params?.command !== "string"
      || !params.command.trim() || params.command.length > 8192 || !PINNED_IMAGE.test(params.sandboxImage ?? "")) {
      throw new Error("bridge_container_sandbox_request_invalid");
    }
    const canonicalRoots = [];
    for (const entry of roots) {
      const original = typeof entry === "string" ? entry : entry?.path;
      const access = typeof entry === "string" ? "readwrite" : entry?.access;
      if (!["read", "write", "readwrite"].includes(access) || typeof original !== "string") throw new Error("bridge_sandbox_root_access_invalid");
      const path = await realpathFn(original);
      if (!isAbsolute(original) || path !== original || /[\r\n,]/.test(path)) throw new Error("bridge_consented_root_changed");
      canonicalRoots.push({ path, access });
    }
    const requestedCwd = typeof params.cwd === "string" ? await realpathFn(params.cwd) : canonicalRoots[0]?.path;
    if (canonicalRoots.length ? !canonicalRoots.some(root => within(root.path, requestedCwd)) : requestedCwd !== undefined) throw new Error("bridge_working_directory_denied");
    if (signal?.aborted) throw new Error("bridge_request_cancelled");

    const tempDir = await mkdtemp(join(tmpdir(), "naelao-docker-sandbox-"));
    const cidfile = join(tempDir, "container-id");
    const id = randomUUID();
    const guestPath = path => {
      const root = canonicalRoots.find(candidate => within(candidate.path, path));
      if (!root) return undefined;
      const index = canonicalRoots.indexOf(root);
      const suffix = relative(root.path, path).split(sep).filter(Boolean).join("/");
      return `/mnt/naelao/${index}${suffix ? `/${suffix}` : ""}`;
    };
    const workdir = requestedCwd === undefined ? "/tmp" : guestPath(requestedCwd);
    if (requestedCwd !== undefined && !workdir) { await rm(tempDir, { recursive: true, force: true }); throw new Error("bridge_working_directory_denied"); }
    const args = ["run", "--rm", "--pull=never", "--cidfile", cidfile, "--name", `naelao-${id}`,
      "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--pids-limit=64", "--memory=512m", "--cpus=1", "--user=65534:65534",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m", "--workdir", workdir];
    canonicalRoots.forEach((root, index) => args.push("--mount", `type=bind,source=${root.path},target=/mnt/naelao/${index},${root.access === "read" ? "readonly" : "rw"}`));
    args.push(params.sandboxImage, "/bin/sh", "-lc", params.command);

    let child;
    let stdout = "", stderr = "", settled = false, killTimer;
    const cleanupContainer = async () => {
      let containerId;
      try { containerId = (await readFile(cidfile, "utf8")).trim(); } catch { return; }
      if (!/^[a-f0-9]{12,64}$/i.test(containerId)) return;
      await new Promise(resolve => { const killer = spawn("docker", ["rm", "--force", containerId], { stdio: "ignore", windowsHide: true }); killer.once("error", resolve); killer.once("close", resolve); });
    };
    try {
      return await new Promise((resolve, reject) => {
        const terminate = () => {
          if (child && !settled) {
            try { child.kill("SIGTERM"); } catch { /* already exited */ }
            void cleanupContainer();
            killTimer ??= setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* exited */ } void cleanupContainer(); }, 1000);
          }
        };
        const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener("abort", terminate); clearTimeout(killTimer); error ? reject(error) : resolve(value); };
        signal?.addEventListener("abort", terminate, { once: true });
        child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        child.stdout.on("data", chunk => { const text = chunk.toString("utf8"); stdout = (stdout + text).slice(-65536); output("stdout", text); });
        child.stderr.on("data", chunk => { const text = chunk.toString("utf8"); stderr = (stderr + text).slice(-65536); output("stderr", text); });
        child.once("error", error => finish(error));
        child.once("close", code => signal?.aborted ? finish(new Error("bridge_request_cancelled")) : finish(null, { exitCode: code ?? 1, stdout, stderr }));
      });
    } finally {
      clearTimeout(killTimer);
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}
