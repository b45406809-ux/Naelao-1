import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "./index.js";

describe("internal customer voice Space bridge", () => {
  it("requires tenant HMAC and active Space ownership, then binds identity from the route", async () => {
    const forwarded: Request[] = [];
    const stub = { fetch: vi.fn(async (request: Request) => { forwarded.push(request); return Response.json({ ok: true }); }) };
    const env = {
      PLATFORM_SECRET: "voice-test-secret",
      PLATFORM_DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => sql.includes("FROM spaces") && values[0] === "space-a" && values[1] === "tenant-a" ? { id: "space-a" } : null }) }) },
      SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
    } as never;
    const url = "https://spaces.test/spaces/space-a/internal/voice/calls/start";
    const payload = { call_sid: `CA${"a".repeat(32)}`, caller_id: "+14155550100", space_id: "attacker-space" };
    const request = (token?: string) => new Request(url, { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", ...(token ? { "x-naelao-internal-token": token } : {}),
    }, body: JSON.stringify(payload) });
    expect((await spacesWorker.fetch(request(), env)).status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
    expect((await spacesWorker.fetch(request(await mintInternalToken("voice-test-secret", "tenant-a")), env)).status).toBe(200);
    expect(JSON.parse(await forwarded[0]!.text())).toMatchObject({ ...payload, space_id: "space-a" });
    expect(new URL(forwarded[0]!.url).pathname).toBe("/internal/voice/calls/start");
  });
});
