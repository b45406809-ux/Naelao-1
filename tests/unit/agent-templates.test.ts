import { describe, expect, it } from "vitest";
import { app, type AgentsEnv } from "../../workers/agents/src/index.js";
import { customAgentToConfig } from "../../workers/agents/src/agent-templates.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "custom-worker-test-secret";
const TENANT_ID = "tenant-1";
const SPACE_ID = "space-1";

function makeEnv() {
  const files = new Map<string, string>();
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const env = {
    PLATFORM_SECRET: SECRET,
    SCRIPTS_R2: {
      async head(key: string) {
        const value = files.get(key);
        return value === undefined ? null : { key, etag: `etag-${value.length}` };
      },
      async get(key: string) {
        const value = files.get(key);
        return value === undefined ? null : { etag: `etag-${value.length}`, text: async () => value };
      },
      async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
        const text = typeof value === "string" ? value : new TextDecoder().decode(
          value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        );
        files.set(key, text);
        return { key };
      },
    },
    SPACES_WORKER: {
      async fetch(input: RequestInfo | URL) {
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        const body = request.method === "GET" ? undefined : await request.clone().json().catch(() => undefined);
        calls.push({ path, method: request.method, body });
        if (path.endsWith("/agent-definitions") && request.method === "POST") return Response.json({ id: (body as { id: string }).id }, { status: 201 });
        if (/\/agents\/[^/]+\/policy$/.test(path) && request.method === "PATCH") return Response.json({ ok: true });
        return new Response("not found", { status: 404 });
      },
    },
  } as unknown as AgentsEnv;
  return { env, files, calls };
}

async function authorizedRequest(body: Record<string, unknown>) {
  return new Request("https://agents.naelao.test/agents/custom", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": TENANT_ID,
      "x-naelao-user-id": "owner-1",
      "x-naelao-role": "owner",
      "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID),
    },
    body: JSON.stringify(body),
  });
}

describe("generic worker configuration", () => {
  it("combines user instructions and selected capabilities with the required runtime baseline", () => {
    const config = customAgentToConfig({
      name: "Research helper",
      instructions: "Research only the supplied question and cite sources.",
      prebuilt_scripts: ["web-search", "knowledge-base"],
      skills: ["source-review"],
      connectors: ["drive"],
    });
    expect(config.agentsMd).toContain("Research only the supplied question");
    expect(config.agentsMd).toContain("drive");
    expect(config.scripts.prebuilt).toEqual(expect.arrayContaining([
      "r2-workspace", "memory", "notifications", "web-search", "knowledge-base",
    ]));
    expect(config.skills.skills).toEqual([{ name: "source-review", tier: "space" }]);
  });

  it("creates a worker from user supplied configuration and persists its permissions", async () => {
    const { env, files, calls } = makeEnv();
    const response = await app.fetch(await authorizedRequest({
      space_id: SPACE_ID,
      name: "Research helper",
      instructions: "Research only the supplied question.",
      prebuilt_scripts: ["web-search"],
      skills: ["source-review"],
      connectors: ["drive"],
      approval_mode: "always_ask",
    }), env);
    expect(response.status).toBe(201);
    const result = await response.json() as { agent_id: string; custom: boolean };
    expect(result).toMatchObject({ custom: true });
    const prefix = `spaces/${SPACE_ID}/agents/${result.agent_id}/`;
    expect(files.get(`${prefix}agents.md`)).toContain("Research only the supplied question");
    expect(JSON.parse(files.get(`${prefix}scripts.json`) ?? "{}").prebuilt).toContain("web-search");
    expect(JSON.parse(files.get(`${prefix}skills.json`) ?? "{}").skills).toEqual([{ name: "source-review", tier: "space" }]);
    expect(calls.find((call) => call.path.endsWith("/agent-definitions"))?.method).toBe("POST");
    expect(calls.find((call) => call.path.endsWith("/policy"))?.body).toMatchObject({ approval_mode: "always_ask" });
  });

  it("requires instructions and a name, and rejects missing authentication", async () => {
    const { env } = makeEnv();
    const missingFields = await app.fetch(await authorizedRequest({ space_id: SPACE_ID, name: "No instructions", prebuilt_scripts: [] }), env);
    expect(missingFields.status).toBe(400);
    const unauthenticated = await app.fetch(new Request("https://agents.naelao.test/agents/custom", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: SPACE_ID, name: "X", instructions: "Y" }),
    }), env);
    expect(unauthenticated.status).toBe(401);
  });

  it("does not expose the retired fixed persona catalogs", async () => {
    const { env } = makeEnv();
    for (const path of ["/agent-templates", "/archetypes"]) {
      const response = await app.fetch(new Request(`https://agents.naelao.test${path}`, {
        headers: { "x-naelao-tenant-id": TENANT_ID, "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT_ID) },
      }), env);
      expect(response.status).toBe(404);
    }
  });
});
