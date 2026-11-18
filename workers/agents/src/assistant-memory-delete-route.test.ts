import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import { app } from "./index.js";

const secret = "assistant-memory-delete-route-test";

async function auth(role = "product_end_user", userId = "member-a") {
  return {
    "x-naelao-tenant-id": "tenant-a",
    "x-naelao-user-id": userId,
    "x-naelao-role": role,
    "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
  };
}

function fixture(memberRole: string | null = "member") {
  const requests: Request[] = [];
  const stub = { fetch: vi.fn(async (input: Request | string) => {
    requests.push(input instanceof Request ? input : new Request(input));
    return Response.json({ deleted: true });
  }) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: {
      prepare: () => ({ bind: () => ({ first: async () => memberRole ? { role: memberRole } : null }) }),
    },
    NAELAO_AGENT_DO: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => stub) },
  } as never;
  return { env, stub, requests };
}

describe("Space Assistant personal memory deletion route", () => {
  it("forwards exact row identity with the authenticated actor after current membership check", async () => {
    const f = fixture();
    const response = await app.request("/spaces/space-a/assistant/memory/episodic/personal-row-1", {
      method: "DELETE", headers: await auth(),
    }, f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: true });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.method).toBe("DELETE");
    expect(new URL(f.requests[0]!.url).pathname).toBe("/memory/episodic/personal-row-1");
    expect(f.requests[0]?.headers.get("x-naelao-user-id")).toBe("member-a");
  });

  it("rejects a non-member without contacting the memory store", async () => {
    const f = fixture(null);
    const response = await app.request("/spaces/space-a/assistant/memory/fact/row-1", {
      method: "DELETE", headers: await auth(),
    }, f.env);
    expect(response.status).toBe(403);
    expect(f.requests).toHaveLength(0);
  });
});
