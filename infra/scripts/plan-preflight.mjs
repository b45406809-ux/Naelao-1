import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const json = process.argv.includes("--json");
const root = fileURLToPath(new URL("../..", import.meta.url));
const nodeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVersion.split(".").map(Number);
const results = [];

function add(name, status, detail, required = false) {
  results.push({ name, status, detail, required });
}

function command(name, command, args, required = false) {
  try {
    const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const result = spawnSync(executable, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      shell: process.platform === "win32" && executable.endsWith(".cmd"),
    });
    if (result.status === 0) add(name, "PASS", (result.stdout || "").trim().split(/\r?\n/)[0] || "available", required);
    else add(name, "LIVE_REQUIRED", (result.error?.message || result.stderr || `exit ${result.status}`).trim().split(/\r?\n/)[0], required);
  } catch (error) {
    add(name, "LIVE_REQUIRED", error instanceof Error ? error.message : String(error), required);
  }
}

add("Node.js", nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5) ? "PASS" : "WARN", `${nodeVersion}; package requires >=22.5.0`, true);
command("pnpm", "pnpm", ["--version"], true);
command("Wrangler", "pnpm", ["exec", "wrangler", "--version"]);
for (const [name, executable, args] of [
  ["Docker", "docker", ["--version"]],
  ["WSL2", "wsl", ["--status"]],
  ["Ollama", "ollama", ["--version"]],
  ["cloudflared", "cloudflared", ["--version"]],
  ["Zig", "zig", ["version"]],
  ["Rust", "rustc", ["--version"]],
  ["FFmpeg", "ffmpeg", ["-version"]],
]) command(name, executable, args);

async function portStatus(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (status) => { socket.destroy(); resolve(status); };
    socket.once("connect", () => finish("READY"));
    socket.once("error", () => finish("AVAILABLE"));
    socket.setTimeout(500, () => finish("AVAILABLE"));
  });
}

for (const [name, port] of [["dashboard", 3000], ["shell", 3100], ["router", 8080], ["spaces", 8788]]) {
  add(`service:${name}`, await portStatus(port), `127.0.0.1:${port}`);
}

const output = { ok: !results.some((result) => result.required && result.status === "FAIL"), nodeVersion, results };
if (json) console.log(JSON.stringify(output, null, 2));
else {
  console.log("Naelao plan preflight");
  for (const result of results) console.log(`${result.status.padEnd(14)} ${result.name}: ${result.detail}`);
}
process.exit(output.ok ? 0 : 1);
