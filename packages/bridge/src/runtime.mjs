import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, readFile, writeFile, rename, realpath, lstat, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, relative, join, basename, isAbsolute, sep } from "node:path";
import { homedir, cpus, totalmem, platform, arch } from "node:os";
import { machineProofBytes, tunnelHash, validateMachineApps } from "@naelao/agent-sdk";
import { createLinuxSandboxExecutor } from "./linux-sandbox.mjs";

const FRAME_LIMIT = 65536, OUTPUT_LIMIT = 1048576;
const executeLocalIsolated = createLinuxSandboxExecutor();
function baseUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("bridge_https_endpoint_required");
  return url.origin;
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
async function readIdentity(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 65536 || platform() !== "win32" && (entry.mode & 0o077) !== 0) throw new Error("bridge_private_identity_permissions_required");
  const state = JSON.parse(await readFile(path, "utf8"));
  if (state.schema !== 1 || !state.machine?.machineId || !state.encryptedPrivateKey || !state.endpoint || !Array.isArray(state.consent?.roots) || !Array.isArray(state.consent?.commands)) throw new Error("bridge_identity_invalid");
  return state;
}
async function passphrase(options) {
  if (options.passphraseFile) {
    const entry = await lstat(options.passphraseFile);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096 || platform() !== "win32" && (entry.mode & 0o077) !== 0) throw new Error("bridge_passphrase_permissions_required");
  }
  const secret = options.passphraseFile ? (await readFile(options.passphraseFile, "utf8")).trim() : process.env.NAELAO_BRIDGE_KEY_PASSPHRASE;
  if (!secret || secret.length < 12) throw new Error("Set NAELAO_BRIDGE_KEY_PASSPHRASE or --passphrase-file to protect the persistent machine key (minimum 12 characters).");
  return secret;
}
function hardware(options, models = options.models ?? []) {
  const capabilities = new Set(options.capabilities?.length ? options.capabilities : ["storage:folder"]);
  if (options.allowSandboxedShell === true && platform() === "linux" && existsSync("/usr/bin/bwrap")) capabilities.add("bash");
  return { platform: platform(), arch: arch(), cpuCount: cpus().length, memoryBytes: totalmem(), capabilities: [...capabilities].slice(0, 64), models };
}
function modelIds(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const ids = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id ?? row?.name ?? row?.model;
    if (typeof id === "string" && id.trim() && id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id) && !ids.includes(id.trim())) ids.push(id.trim());
    if (ids.length >= 64) break;
  }
  return ids;
}
/** Query only a user-consented loopback inference service. Model IDs are metadata; capabilities
 * such as reasoning or tool use are not inferred from names. */
export async function discoverLocalModelIds(options, fetchImpl = fetch) {
  if (options.allowInference !== true || !options.inferenceUrl) return [];
  const endpoint = loopbackUrl(options.inferenceUrl);
  for (const url of [new URL("/v1/models", endpoint.origin), new URL("/api/tags", endpoint.origin)]) {
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) continue;
      const text = await response.text();
      if (Buffer.byteLength(text) > 65_536) continue;
      const ids = modelIds(JSON.parse(text));
      if (ids.length) return ids;
    } catch { /* Offline or unsupported API: retain manually declared model IDs. */ }
  }
  return [];
}
async function discoveredHardware(options) {
  const discovered = await discoverLocalModelIds(options);
  const models = [...new Set([...(options.models ?? []), ...discovered])].slice(0, 64);
  const result = hardware(options, models);
  if (options.inventoryFile) {
    const file = await lstat(options.inventoryFile);
    if (!file.isFile() || file.size > 65536) throw new Error("bridge_inventory_file_invalid");
    const apps = JSON.parse(await readFile(options.inventoryFile, "utf8"));
    validateMachineApps(apps);
    result.apps = apps;
  }
  return result;
}
async function jsonFetch(url, body, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error" });
  const text = await response.text();
  if (Buffer.byteLength(text) > 65536) throw new Error("bridge_response_limit");
  const value = JSON.parse(text);
  if (!response.ok) throw new Error(value.error_code ?? value.error ?? "bridge_request_denied");
  return value;
}
async function consent(options) {
  const roots = [];
  for (const path of options.allowDirs ?? []) roots.push(await realpath(resolve(path)));
  const inference = options.allowInference === true;
  return { roots, commands: options.allowCommands ?? [], sandboxedShell: options.allowSandboxedShell === true, inference,
    ...(inference ? { inferenceUrl: loopbackUrl(options.inferenceUrl).toString() } : {}) };
}
export async function enrollBridge(options) {
  if (await lstat(options.identityFile).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("bridge_identity_already_exists");
  const ticket = JSON.parse(await readFile(options.enrollmentFile, "utf8"));
  if (ticket.expiresAt <= Date.now() || ticket.name !== options.name) throw new Error("bridge_enrollment_expired_or_name_mismatch");
  const endpoint = baseUrl(options.url), password = await passphrase(options), localConsent = await consent(options);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const enrolled = await jsonFetch(endpoint + "/tunnel/enroll", { tenantId: ticket.tenantId, spaceId: ticket.spaceId, name: ticket.name,
    token: ticket.enrollmentToken, publicKey: publicKey.export({ format: "jwk" }), hardware: await discoveredHardware(options) });
  const state = { schema: 1, endpoint, machine: enrolled.machine, sequence: enrolled.machine.sequence,
    encryptedPrivateKey: privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: password }), consent: localConsent };
  await atomicJson(options.identityFile, state);
  return { machineId: state.machine.machineId, name: state.machine.name, identityFile: options.identityFile };
}
async function authenticate(options, operation, data) {
  const state = await readIdentity(options.identityFile), password = await passphrase(options);
  const privateKey = createPrivateKey({ key: state.encryptedPrivateKey, format: "pem", passphrase: password });
  // Persist the next sequence BEFORE sending. Lost replies cannot make a restarted client
  // re-use a consumed proof. One daemon per identity is enforced by connectBridge's lock.
  state.sequence = Math.max(state.sequence, state.machine.sequence) + 1;
  await atomicJson(options.identityFile, state);
  const proof = { schema: 1, tenantId: state.machine.tenantId, spaceId: state.machine.spaceId, machineId: state.machine.machineId,
    keyVersion: state.machine.keyVersion, sequence: state.sequence, issuedAt: Date.now(), nonce: randomBytes(32).toString("hex"), operation, dataHash: await tunnelHash(JSON.stringify(data)) };
  const signature = sign(null, machineProofBytes(proof), privateKey).toString("base64url");
  const response = await jsonFetch(baseUrl(state.endpoint) + "/tunnel/authenticate", { proof, signature, ...(operation === "connect" ? { hardware: data } : operation === "rotate" ? { publicKey: data } : {}) });
  state.machine = response.machine;
  await atomicJson(options.identityFile, state);
  return { state, response };
}
async function identityMutation(options, action) {
  const lock = options.identityFile + ".lock";
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  try { return await action(); } finally { await rm(lock, { force: true }); }
}
export async function rotateBridgeIdentity(options) {
  return identityMutation(options, async () => {
  if (await lstat(options.identityFile + ".rotation-pending").then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("bridge_rotation_pending: use recover-rotation before another rotation");
  const password = await passphrase(options), { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const newKey = privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: password });
  // Keep an encrypted recovery candidate before rotation in case the response is lost.
  await atomicJson(options.identityFile + ".rotation-pending", { encryptedPrivateKey: newKey, publicKey: publicKey.export({ format: "jwk" }) });
  const { state } = await authenticate(options, "rotate", publicKey.export({ format: "jwk" }));
  state.encryptedPrivateKey = newKey; await atomicJson(options.identityFile, state);
  await rm(options.identityFile + ".rotation-pending");
  return { machineId: state.machine.machineId, keyVersion: state.machine.keyVersion };
  });
}
export async function removeBridgeIdentity(options) {
  return identityMutation(options, async () => {
  const { state } = await authenticate(options, "remove", {});
  return { machineId: state.machine.machineId, removed: state.machine.status === "removed", credentialRetainedEncrypted: true };
  });
}
/** Explicit recovery after an uncertain rotate response. No plaintext key leaves disk. */
export async function recoverBridgeRotation(options) {
  return identityMutation(options, async () => {
    const original = await readIdentity(options.identityFile);
    const pending = JSON.parse(await readFile(options.identityFile + ".rotation-pending", "utf8"));
    if (!pending.encryptedPrivateKey || !pending.publicKey) throw new Error("bridge_rotation_candidate_invalid");
    const candidate = { ...original, encryptedPrivateKey: pending.encryptedPrivateKey,
      machine: { ...original.machine, publicKey: pending.publicKey, keyVersion: original.machine.keyVersion + 1 } };
    await atomicJson(options.identityFile, candidate);
    try {
      const consented = await readIdentity(options.identityFile);
      const { state } = await authenticate(options, "connect", await discoveredHardware({ ...options,
        allowInference: consented.consent.inference === true, inferenceUrl: consented.consent.inferenceUrl }));
      await rm(options.identityFile + ".rotation-pending");
      return { recovered: true, machineId: state.machine.machineId, keyVersion: state.machine.keyVersion };
    } catch (error) {
      const current = await readIdentity(options.identityFile);
      await atomicJson(options.identityFile, { ...original, sequence: current.sequence });
      throw new Error("bridge_rotation_recovery_not_confirmed: retained encrypted candidate; inspect registry version before retrying");
    }
  });
}
function loopbackUrl(value) {
  const url = new URL(value ?? "http://127.0.0.1:11434/v1/chat/completions");
  if (url.protocol !== "http:" || url.username || url.password || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("bridge_inference_loopback_required");
  return url;
}
async function consentedPath(path, roots, writing = false) {
  const absolute = resolve(String(path));
  let actual;
  try { actual = await realpath(absolute); }
  catch (error) { if (!writing || error.code !== "ENOENT") throw error; actual = join(await realpath(dirname(absolute)), basename(absolute)); }
  if (!roots.some(root => { const suffix = relative(root, actual); return suffix === "" || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep); })) throw new Error("bridge_folder_consent_denied");
  return actual;
}
function pathWithin(root, target) {
  const suffix = relative(root, target);
  return suffix === "" || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
}
async function intersectExecutionRoots(localRoots, serverRoots) {
  if (!Array.isArray(serverRoots) || serverRoots.length > 32) throw new Error("bridge_execution_roots_invalid");
  const local = await Promise.all(localRoots.map(root => realpath(root)));
  const effective = [];
  for (const grant of serverRoots) {
    if (!grant || typeof grant.path !== "string" || !["read", "write", "readwrite"].includes(grant.access)) throw new Error("bridge_execution_root_invalid");
    const path = await realpath(grant.path);
    if (path === "/" || !local.some(root => pathWithin(root, path))) throw new Error("bridge_execution_root_outside_local_consent");
    effective.push({ path, access: grant.access });
  }
  return effective;
}
export async function connectBridge(options, dependencies = {}) {
  const identityFile = resolve(options.identityFile), lock = identityFile + ".lock";
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: "wx", mode: 0o600 }).catch(() => { throw new Error("bridge_identity_in_use_or_stale_lock: inspect the recorded process before removing its lock"); });
  const journalDir = identityFile + ".requests";
  await mkdir(journalDir, { recursive: true, mode: 0o700 }).catch(async error => { await rm(lock, { force: true }); throw error; });
  const shutdown = new AbortController(), active = new Map();
  const claimed = new Set(), tasks = new Set();
  let ws, generation = 0, heartbeat, renewal, backoff = 1000;
  const stop = () => { shutdown.abort(); for (const controller of active.values()) controller.abort(); ws?.close(1000, "service shutdown"); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const requestPath = id => { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("bridge_request_id_invalid"); return join(journalDir, id + ".json"); };
  try {
    if (await lstat(identityFile + ".rotation-pending").then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("bridge_rotation_pending: run recover-rotation first");
    while (!shutdown.signal.aborted) {
      try {
        const consented = await readIdentity(identityFile);
        const { state, response } = await authenticate({ ...options, identityFile }, "connect", await discoveredHardware({ ...options,
          allowInference: consented.consent.inference === true, inferenceUrl: consented.consent.inferenceUrl }));
        const url = new URL(state.endpoint); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/tunnel/" + [state.machine.tenantId, state.machine.spaceId, state.machine.machineId].map(encodeURIComponent).join("/") + "/connect";
        url.searchParams.set("ticket", response.ticket);
        ws = new (dependencies.WebSocket ?? WebSocket)(url);
        const connection = ws;
        let connectionGeneration = 0;
        const send = value => {
          const text = JSON.stringify(value);
          if (Buffer.byteLength(text) > FRAME_LIMIT) throw new Error("bridge_frame_limit");
          if (connection.readyState === 1) connection.send(text);
        };
        await new Promise((resolveConnection, rejectConnection) => {
          const finish = () => { clearInterval(heartbeat); clearTimeout(renewal); for (const controller of active.values()) controller.abort(); resolveConnection(); };
          ws.addEventListener("close", finish, { once: true });
          ws.addEventListener("error", () => { if (ws.readyState !== 1) { ws.close(); rejectConnection(new Error("bridge_connection_failed")); } });
          ws.addEventListener("message", event => { const task = (async () => {
            const text = String(event.data);
            if (Buffer.byteLength(text) > FRAME_LIMIT) throw new Error("bridge_inbound_frame_limit");
            const frame = JSON.parse(text);
            if (frame.type === "ready") {
              connectionGeneration = frame.generation; backoff = 1000;
              heartbeat = setInterval(() => send({ type: "heartbeat", generation: connectionGeneration }), 15000);
              renewal = setTimeout(() => connection.close(1000, "authenticate a fresh session"), Math.max(1000, frame.expiresAt - Date.now() - 15000));
              // Return prior durable receipts, never re-run their commands on reconnect.
              for (const file of (await readdir(journalDir)).filter(name => name.endsWith(".json")).slice(-128)) {
                const prior = JSON.parse(await readFile(join(journalDir, file), "utf8"));
                if (active.has(prior.id)) continue;
                if (prior.status === "prepared") { prior.status = "indeterminate"; await atomicJson(join(journalDir, file), prior); }
                send({ type: "reconcile", generation: connectionGeneration, original_generation: prior.generation,
                  request_id: prior.id, payload_hash: prior.payloadHash, status: prior.status, result: prior.result, error: prior.error });
              }
              return;
            }
            const generation = connectionGeneration;
            if (!generation || frame.generation !== generation) return;
            if (frame.type === "cancel") { active.get(frame.request_id)?.abort(); return; }
            if (frame.type !== "request") return;
            if (claimed.has(frame.request_id)) return;
            claimed.add(frame.request_id);
            try {
            const path = requestPath(frame.request_id);
            const previous = await readFile(path, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
            if (previous) {
              if (previous.payloadHash !== frame.payload_hash) throw new Error("bridge_request_payload_conflict");
              // A duplicate is a status receipt, never a second native command.
              send({ type: "response", generation, request_id: frame.request_id, status: previous.status === "prepared" ? "indeterminate" : previous.status,
                ok: previous.status === "succeeded", result: previous.result, error: previous.error }); return;
            }
            if (await tunnelHash(JSON.stringify([frame.op, frame.params, frame.execution_roots ?? null])) !== frame.payload_hash || !Number.isFinite(frame.invocation?.deadline)
              || frame.invocation.requestId !== frame.request_id || !frame.invocation.actorId || !frame.invocation.runId
              || frame.invocation.deadline <= Date.now() || frame.invocation.deadline > Date.now() + 60000) throw new Error("bridge_request_scope_invalid");
            const record = { id: frame.request_id, payloadHash: frame.payload_hash, generation, invocation: frame.invocation, status: "prepared" };
            await atomicJson(path, record);
            const controller = new AbortController(); active.set(frame.request_id, controller);
            const deadline = setTimeout(() => controller.abort(), Math.max(1, frame.invocation.deadline - Date.now()));
            let sequence = 0, outputBytes = 0;
            const output = (stream, chunk) => {
              const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
              outputBytes += Buffer.byteLength(text);
              if (outputBytes > OUTPUT_LIMIT) { controller.abort(); throw new Error("bridge_output_limit"); }
              let part = "", length = 0;
              const flush = () => { if (part) send({ type: "output", generation, request_id: frame.request_id, sequence: sequence++, stream, chunk: part }); part = ""; length = 0; };
              for (const character of text) { const size = Buffer.byteLength(character); if (length + size > 8192) flush(); part += character; length += size; }
              flush();
            };
            try {
              let result;
              if (frame.op === "read_file") {
                const file = await consentedPath(frame.params.path, state.consent.roots);
                const size = (await lstat(file)).size;
                if (frame.params.encoding === "base64") {
                  if (size > 12 * 1024) throw new Error("bridge_file_result_limit");
                  result = { encoding: "base64", content: (await readFile(file)).toString("base64"), bytes: size };
                } else {
                  if (size > 24000) throw new Error("bridge_file_result_limit");
                  result = await readFile(file, "utf8");
                }
              } else if (frame.op === "write_file") {
                const file = await consentedPath(frame.params.path, state.consent.roots, true);
                if (frame.params.encoding === "base64") {
                  const encoded = frame.params.content;
                  if (typeof encoded !== "string" || encoded.length > 4 * Math.ceil((12 * 1024) / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("bridge_file_result_limit");
                  const bytes = Buffer.from(encoded, "base64");
                  if (bytes.length > 12 * 1024 || bytes.toString("base64") !== encoded) throw new Error("bridge_file_result_limit");
                  await writeFile(file, bytes, { signal: controller.signal, ...(frame.params.create_only === true ? { flag: "wx" } : {}) });
                  result = { written: true, bytes: bytes.length };
                } else {
                  if (typeof frame.params.content !== "string" || Buffer.byteLength(frame.params.content) > 24000) throw new Error("bridge_file_result_limit");
                  await writeFile(file, frame.params.content, { signal: controller.signal, ...(frame.params.create_only === true ? { flag: "wx" } : {}) }); result = { written: true };
                }
              } else if (frame.op === "inference") {
                if (!state.consent.inference) throw new Error("bridge_inference_consent_required");
                const response = await fetch(loopbackUrl(options.inferenceUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frame.params), signal: controller.signal, redirect: "error" });
                const text = await response.text(); if (Buffer.byteLength(text) > 24000) throw new Error("bridge_inference_result_limit");
                if (!response.ok) throw new Error("bridge_local_model_failed"); result = JSON.parse(text);
              } else if (frame.op === "exec") {
                if (!state.consent.commands.includes(frame.params.command) && state.consent.sandboxedShell !== true) throw new Error("bridge_command_consent_denied");
                const executionRoots = await intersectExecutionRoots(state.consent.roots, frame.execution_roots);
                result = await (dependencies.executeIsolated ?? executeLocalIsolated)(frame.params, { signal: controller.signal, roots: executionRoots, output });
              } else throw new Error("bridge_operation_unknown");
              if (controller.signal.aborted) throw new Error("bridge_request_cancelled");
              record.status = "succeeded"; record.result = result;
              await atomicJson(path, record); send({ type: "response", generation, request_id: frame.request_id, ok: true, result });
            } catch (error) {
              record.status = controller.signal.aborted ? "indeterminate" : "failed"; record.error = String(error.message ?? error).slice(0, 2000);
              await atomicJson(path, record); send({ type: "response", generation, request_id: frame.request_id, status: record.status, ok: false, error: record.error });
            } finally { clearTimeout(deadline); active.delete(frame.request_id); }
            } finally { claimed.delete(frame.request_id); }
          })().catch(() => connection.close(1008, "bridge protocol rejected"));
            tasks.add(task); void task.finally(() => tasks.delete(task));
          });
        });
        await Promise.allSettled([...tasks]);
      } catch (error) {
        if (shutdown.signal.aborted) break;
        if (/revoked|unauthorized|expired_or_used/.test(String(error.message))) throw error;
      }
      if (!shutdown.signal.aborted) await new Promise(resolveWait => {
        const timer = setTimeout(resolveWait, backoff + Math.floor(Math.random() * 500));
        shutdown.signal.addEventListener("abort", () => { clearTimeout(timer); resolveWait(); }, { once: true });
      });
      backoff = Math.min(30000, backoff * 2);
    }
  } finally {
    stop(); clearInterval(heartbeat); clearTimeout(renewal);
    await Promise.allSettled([...tasks]);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await rm(lock, { force: true });
  }
}
export async function runBridge(argv) {
  const operation = argv[0] ?? "help", options = { allowDirs: [], allowCommands: [], models: [], capabilities: [] };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === "--allow-inference") { options.allowInference = true; continue; }
    if (flag === "--allow-sandboxed-shell") { options.allowSandboxedShell = true; continue; }
    if (!value || value.startsWith("--")) throw new Error("bridge_option_value_required:" + flag);
    const fields = { "--url": "url", "--name": "name", "--identity": "identityFile", "--enrollment-file": "enrollmentFile", "--passphrase-file": "passphraseFile", "--inference-url": "inferenceUrl", "--inventory-file": "inventoryFile" };
    const arrays = { "--allow-dir": "allowDirs", "--allow-command": "allowCommands", "--model": "models", "--capability": "capabilities" };
    if (fields[flag]) options[fields[flag]] = value;
    else if (arrays[flag]) options[arrays[flag]].push(value);
    else throw new Error("bridge_unknown_option:" + flag);
    index++;
  }
  if (operation === "help") { process.stdout.write("naelao-bridge login --url https://agents.example --name machine-name --enrollment-file ticket.json [--allow-dir path] [--allow-command exact-command | --allow-sandboxed-shell] [--allow-inference --inference-url http://127.0.0.1:11434/v1/chat/completions]\nnaelao-bridge connect|rotate|remove --identity path [--passphrase-file path]\n"); return; }
  if (!options.identityFile) {
    if (!options.name || !/^[a-z][a-z0-9-]{1,62}$/.test(options.name)) throw new Error("bridge_named_identity_required");
    options.identityFile = join(homedir(), ".naelao", "bridge", options.name + ".json");
  }
  if (operation === "login") return enrollBridge(options);
  if (operation === "connect") return connectBridge(options);
  if (operation === "rotate") return rotateBridgeIdentity(options);
  if (operation === "remove") return removeBridgeIdentity(options);
  if (operation === "recover-rotation") return recoverBridgeRotation(options);
  throw new Error("bridge_operation_unknown");
}
