import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let server;
let baseUrl;
let seen;
before(async () => {
  server = createServer((request, response) => {
    seen = { url: request.url, authorization: request.headers.authorization };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ services: [{ id: "mail" }] }));
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolveClose => server.close(resolveClose)));

test("CLI sends a scoped service-list request to AgentPort", async () => {
  const child = spawn(process.execPath, [resolve(here, "agentport.js"), "services", "list"], {
    env: { ...process.env, AGENTPORT_API_URL: baseUrl, AGENTPORT_API_KEY: "ap_live_test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk);
  const result = await new Promise(resolveExit => child.on("close", (code, signal) => resolveExit({ code, signal })));
  assert.equal(result.code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { services: [{ id: "mail" }] });
  assert.equal(seen.url, "/v1/services");
  assert.equal(seen.authorization, "Bearer ap_live_test");
});

test("CLI lists provider message references without fetching or sending content", async () => {
  const child = spawn(process.execPath, [resolve(here, "agentport.js"), "messages", "references", "--thread", "thread/1", "--agent", "agent 1"], {
    env: { ...process.env, AGENTPORT_API_URL: baseUrl, AGENTPORT_API_KEY: "ap_live_test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk);
  const result = await new Promise(resolveExit => child.on("close", (code, signal) => resolveExit({ code, signal })));
  assert.equal(result.code, 0, stderr);
  assert.equal(seen.url, "/v1/threads/thread%2F1/message-references?agentId=agent%201");
  assert.equal(seen.authorization, "Bearer ap_live_test");
});
