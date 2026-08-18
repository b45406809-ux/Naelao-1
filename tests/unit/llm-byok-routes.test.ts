import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Step 28: business-wide BYOK LLM keys (AI Studio / Groq). The agents-worker routes store the
// business's OWN provider key in the vault under `llm-byok:{provider}` (space-scoped, admin) and
// project only `configured:boolean` on read (never the key). The stub below mirrors the real
// credentials worker's store/list/delete contract closely enough to catch a regression: it
// rejects a space-scoped write without owner/admin, and remembers rows so list/delete are real.

const SECRET = "test-platform-secret";

function makeStatefulCredentialsStub() {
  let seq = 0;
  const rows: Array<{ id: string; name: string; value: string; scope: string }> = [];
  const worker = {
    async fetch(reqInput: Request) {
      const url = new URL(reqInput.url);
      const role = reqInput.headers.get("x-naelao-role") ?? "";
      const listMatch = /^\/spaces\/([^/]+)\/credentials$/.exec(url.pathname);
      const delMatch = /^\/spaces\/([^/]+)\/credentials\/([^/]+)$/.exec(url.pathname);

      if (reqInput.method === "POST" && listMatch) {
        if (!reqInput.headers.get("x-naelao-user-id")) return new Response("x-naelao-user-id required", { status: 400 });
        const body = await reqInput.json<{ name: string; value: string; scope?: string }>();
        if ((body.scope ?? "user") === "space" && role !== "owner" && role !== "admin") {
          return new Response("owner/admin required for space scope", { status: 403 });
        }
        // Upsert by name (the real worker replaces a same-(space,name,scope) row).
        const existing = rows.find((r) => r.name === body.name);
        if (existing) { existing.value = body.value; return Response.json({ id: existing.id, name: body.name }, { status: 200 }); }
        const id = `cred-${++seq}`;
        rows.push({ id, name: body.name, value: body.value, scope: body.scope ?? "user" });
        return Response.json({ id, name: body.name, scope: body.scope ?? "user" }, { status: 201 });
      }
      if (reqInput.method === "GET" && listMatch) {
        return Response.json({ credentials: rows.map((r) => ({ id: r.id, name: r.name, scope: r.scope })) });
      }
      if (reqInput.method === "DELETE" && delMatch) {
        const id = decodeURIComponent(delMatch[2]!);
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
        return Response.json({ ok: true });
      }
      return new Response(`not found: ${reqInput.method} ${url.pathname}`, { status: 404 });
    },
  };
  return { worker, rows };
}

async function makeEnv() {
  const { worker, rows } = makeStatefulCredentialsStub();
  const env = {
    PLATFORM_SECRET: SECRET,
    CREDENTIALS_WORKER: worker as unknown as Fetcher,
  } as unknown as AgentsEnv;
  const token = await mintInternalToken(SECRET, "tenant-a");
  const headers = {
    "content-type": "application/json",
    "x-naelao-tenant-id": "tenant-a",
    "x-naelao-user-id": "alice",
    "x-naelao-internal-token": token,
  };
  return { env, headers, rows };
}

describe("BYOK LLM key routes (step 28)", () => {
  it("stores a provider key (space-scoped) and reports it configured, never leaking the value", async () => {
    const { env, headers, rows } = await makeEnv();

    const put = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/llm-byok", {
        method: "PUT",
        headers,
        body: JSON.stringify({ provider: "google-ai-studio", key: "AIza-secret-123" }),
      }),
      env as never,
    );
    expect(put.status).toBe(200);

    // Stored space-scoped under the canonical name, with the real key.
    const stored = rows.find((r) => r.name === "llm-byok:google-ai-studio");
    expect(stored?.scope).toBe("space");
    expect(stored?.value).toBe("AIza-secret-123");

    const get = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/llm-byok", { headers }),
      env as never,
    );
    const body = (await get.json()) as { providers: Array<{ provider: string; configured: boolean }> };
    const google = body.providers.find((p) => p.provider === "google-ai-studio")!;
    const groq = body.providers.find((p) => p.provider === "groq")!;
    expect(google.configured).toBe(true);
    expect(groq.configured).toBe(false);
    // The response never carries the key value.
    expect(JSON.stringify(body)).not.toContain("AIza-secret-123");
  });

  it("removes a stored key (idempotent)", async () => {
    const { env, headers, rows } = await makeEnv();
    await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/llm-byok", {
        method: "PUT", headers, body: JSON.stringify({ provider: "groq", key: "gsk-abc" }),
      }),
      env as never,
    );
    expect(rows.some((r) => r.name === "llm-byok:groq")).toBe(true);

    const del = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/llm-byok/groq", { method: "DELETE", headers }),
      env as never,
    );
    expect(del.status).toBe(200);
    expect(rows.some((r) => r.name === "llm-byok:groq")).toBe(false);

    // Deleting again is a no-op success, not a 404.
    const again = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/llm-byok/groq", { method: "DELETE", headers }),
      env as never,
    );
    expect(again.status).toBe(200);
  });

  it("rejects an unknown provider", async () => {
    const { env, headers } = await makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/llm-byok", {
        method: "PUT", headers, body: JSON.stringify({ provider: "openai", key: "sk-x" }),
      }),
      env as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing key", async () => {
    const { env, headers } = await makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-a/llm-byok", {
        method: "PUT", headers, body: JSON.stringify({ provider: "groq" }),
      }),
      env as never,
    );
    expect(res.status).toBe(400);
  });
});
