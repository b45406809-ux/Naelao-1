#!/usr/bin/env node
/**
 * Naelao Local Agent — reference client for "Local PC as a Container Target"
 * (spec gap G-3; §A1.17 Phase M).
 *
 * This is a small, dependency-free Node script (requires the global `WebSocket`, stable in
 * Node 22+) that a builder runs on their OWN machine to opt it in as a grant-checked execution
 * target for their space's agent. It opens ONE WebSocket to LocalTunnelDO (agents worker) and
 * relays read_file/write_file/exec requests — nothing more. The server has ALREADY checked the
 * request against that space's `local_grants` before it ever reaches this client (see
 * workers/agents/src/script-engine/prebuilt/local-machine.ts); the `--allow-dir`/
 * `--allow-command` flags here are an OPTIONAL second, independent check on this side, because
 * this machine is the one actually at risk if the server-side check were ever wrong.
 *
 * Usage:
 *   node naelao-local-agent.mjs \
 *     --url wss://agents.your-naelao-deployment.example \
 *     --space <spaceId> --user <userId> --token <connect-token> \
 *     --allow-dir /home/alice/project \
 *     --allow-command "npm test"
 *
 * Get --space/--user/--token by calling (as the space's owner/admin):
 *   POST /spaces/:spaceId/local-tunnel/connect-token
 * The token expires in 5 minutes — run this client promptly after minting one. On disconnect
 * this client exits rather than silently retrying with a dead token; mint a fresh token and
 * re-run to reconnect. To revoke access entirely, delete the grant(s)
 * (DELETE /spaces/:spaceId/local-grants/:grantId) — a revoked grant is denied on the NEXT
 * request even if this client is still connected, since the check runs server-side per call.
 */

import { readFile, writeFile } from "node:fs/promises";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const EXEC_TIMEOUT_MS = 25_000; // stays under LocalTunnelDO's 30s /exec timeout

function parseArgs(argv) {
  const args = { allowDirs: [], allowCommands: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--space") args.space = argv[++i];
    else if (a === "--user") args.user = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--allow-dir") args.allowDirs.push(argv[++i]);
    else if (a === "--allow-command") args.allowCommands.push(argv[++i]);
  }
  return args;
}

export function normalizePath(p) {
  const isAbsolute = p.startsWith("/");
  const parts = p.split("/").filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

export function isWithinAny(path, dirs) {
  if (dirs.length === 0) return true; // no client-side allowlist configured — trust the server's own grant check
  const normalized = normalizePath(path);
  return dirs.some((d) => {
    const dir = normalizePath(d).replace(/\/+$/, "");
    return normalized === dir || normalized.startsWith(dir + "/");
  });
}

export function isAllowedCommand(command, commands) {
  if (commands.length === 0) return true; // same as above — server already checked this
  return commands.includes(command);
}

export async function handleRequest(args, op, params) {
  if (op === "read_file") {
    if (!isWithinAny(params.path, args.allowDirs)) throw new Error(`local policy: '${params.path}' is outside this client's --allow-dir list`);
    return await readFile(params.path, "utf8");
  }
  if (op === "write_file") {
    if (!isWithinAny(params.path, args.allowDirs)) throw new Error(`local policy: '${params.path}' is outside this client's --allow-dir list`);
    await writeFile(params.path, params.content ?? "", "utf8");
    return { written: true };
  }
  if (op === "exec") {
    if (!isAllowedCommand(params.command, args.allowCommands)) throw new Error(`local policy: '${params.command}' is not in this client's --allow-command list`);
    const { stdout, stderr } = await exec(params.command, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return { stdout, stderr };
  }
  throw new Error(`unknown op: ${op}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.space || !args.user || !args.token) {
    console.error("Usage: naelao-local-agent.mjs --url <wss://...> --space <id> --user <id> --token <token> [--allow-dir <path> ...] [--allow-command <cmd> ...]");
    process.exit(1);
  }

  const connectUrl = `${args.url.replace(/\/$/, "")}/local-tunnel/connect?space=${encodeURIComponent(args.space)}&user=${encodeURIComponent(args.user)}&token=${encodeURIComponent(args.token)}`;
  console.log(`[naelao-local-agent] connecting to ${args.url} for space=${args.space} user=${args.user}`);
  if (args.allowDirs.length === 0 && args.allowCommands.length === 0) {
    console.warn("[naelao-local-agent] no --allow-dir/--allow-command configured — this client will not second-guess the server's grant check.");
  }

  const ws = new WebSocket(connectUrl);

  ws.addEventListener("open", () => {
    console.log("[naelao-local-agent] connected — waiting for requests");
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    } catch {
      return;
    }
    if (msg.type !== "request" || !msg.request_id) return;

    try {
      const result = await handleRequest(args, msg.op, msg.params || {});
      ws.send(JSON.stringify({ type: "response", request_id: msg.request_id, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "response", request_id: msg.request_id, ok: false, error: String(err?.message || err) }));
    }
  });

  ws.addEventListener("close", (event) => {
    console.error(`[naelao-local-agent] disconnected (code=${event.code}). Connect tokens are single-use-window (5 min) — mint a fresh one and re-run to reconnect.`);
    process.exit(event.code === 1000 ? 0 : 1);
  });

  ws.addEventListener("error", (event) => {
    console.error("[naelao-local-agent] connection error:", event.message || event);
  });
}

// Only run when invoked directly (`node naelao-local-agent.mjs ...`) — importing this module
// (e.g. from a test exercising the pure helpers above) must not open a real connection.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
