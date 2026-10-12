import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const active = new Map();
const outputs = new Map();
export function executionOutput(id) { return outputs.get(id)?.value ?? { stdout: "", stderr: "" }; }
const MAX_OUTPUT = 2 * 1024 * 1024;
const SAFE_ENV = new Set(["LANG", "LC_ALL", "TERM", "DISPLAY", "TZ"]);
export function guestEnvironment(extra = {}) {
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/runtime", TMPDIR: "/tmp/guest" };
  for (const [key, value] of Object.entries(extra)) if (SAFE_ENV.has(key) && typeof value === "string" && value.length <= 1024) env[key] = value;
  return env;
}
export function cancelExecution(id) { active.get(id)?.cancel("container_cancelled"); }
export function cancelAllExecutions() { for (const process of active.values()) process.cancel("container_shutting_down"); }
export function runGuest(command, argv, { id, cwd = "/workspace", env, signal, timeoutMs = 55000, message } = {}) {
  if (!id || active.has(id)) return Promise.reject(new Error("container_execution_id_conflict"));
  if (signal?.aborted) return Promise.reject(new Error("container_cancelled"));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) return Promise.reject(new Error("container_deadline_invalid"));
  // The small trusted supervisor runs as root; ONLY guest children are unprivileged. setpriv
  // clears supplementary groups and ALL capability sets, and prevents privilege reacquisition.
  // A fixed default-policy provider binding is required. Do not use durable_object image mode.
  const child = spawn("/usr/bin/setpriv", ["--reuid=10001", "--regid=10001", "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", command, ...argv], {
    cwd, env: guestEnvironment(env), detached: true,
    stdio: message ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", bytes = 0, result, failure, settled = false;
    for (const [key, output] of outputs) if (output.expiresAt < Date.now()) outputs.delete(key);
    while (outputs.size >= 32) outputs.delete(outputs.keys().next().value);
    const snapshot = { value: { stdout: "", stderr: "" }, expiresAt: Date.now() + 120000 };
    outputs.set(id, snapshot);
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const cancel = (reason) => { failure ??= new Error(reason); kill(); };
    active.set(id, { cancel });
    const abort = () => cancel("container_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => cancel("container_deadline_exceeded"), timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); active.delete(id); signal?.removeEventListener("abort", abort);
      // Kill ordinary descendants even if the entrypoint exits successfully. The DO destroys
      // the provider instance at hard cancellation/deadline to catch detached descendants too.
      kill();
      if (failure) reject(failure);
      else resolve({ stdout, stderr, status: code ?? 1, ...(message ? { result: result ?? { ok: false, error: "container_child_no_result" } } : {}) });
    };
    for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) cancel("container_output_limit"); else { append(decoder.write(chunk)); snapshot.value = { stdout, stderr }; } });
      stream?.on("end", () => { append(decoder.end()); snapshot.value = { stdout, stderr }; });
    }
    child.on("message", value => {
      if (result !== undefined) return;
      try {
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_OUTPUT) cancel("container_result_limit"); else result = value;
      } catch { cancel("container_result_invalid"); }
    });
    child.once("error", error => { failure = error; finish(1); });
    child.once("close", finish);
    if (message) child.once("spawn", () => child.send(message, error => { if (error) cancel("container_child_channel_failed"); }));
    if (signal?.aborted) abort();
  });
}
