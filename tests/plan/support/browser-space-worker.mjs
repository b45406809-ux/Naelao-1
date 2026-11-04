/** Starts an isolated local Wrangler Spaces/SpaceDO backend for the browser journey suite. */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "package.json"));
const wrangler = require.resolve("wrangler");
const config = join(root, "tests/plan/runtime/spaces.wrangler.toml");
const persist = await mkdtemp(join(tmpdir(), "naelao-browser-space-do-"));
const port = Number(process.env.NAELAO_BROWSER_SPACE_PORT ?? 8788);
const childEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" };
const migration = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "naelao-blackboard-test", "--local", "--config", config, "--persist-to", persist], {
  cwd: root, env: childEnv, stdio: "inherit",
});
if (migration.status !== 0) {
  await rm(persist, { recursive: true, force: true });
  process.exit(migration.status ?? 1);
}

const worker = spawn(process.execPath, [wrangler, "dev", "--local", "--config", config, "--port", String(port), "--inspector-port", String(port + 10000), "--persist-to", persist, "--log-level", "error"], {
  cwd: root, env: childEnv, stdio: "inherit",
});
let closing = false;
async function stop(signal = "SIGTERM") {
  if (closing) return;
  closing = true;
  if (worker.exitCode === null) {
    worker.kill(signal);
    await Promise.race([new Promise(resolveExit => worker.once("exit", resolveExit)), new Promise(resolveTimer => setTimeout(resolveTimer, 5000))]);
  }
  if (worker.exitCode === null) worker.kill("SIGKILL");
  await rm(persist, { recursive: true, force: true });
}
process.once("SIGINT", () => void stop("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => void stop("SIGTERM").then(() => process.exit(0)));
worker.once("exit", async code => {
  if (!closing) {
    await stop();
    process.exitCode = code ?? 1;
  }
});
