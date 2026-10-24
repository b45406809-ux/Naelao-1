import { describe, expect, it, vi } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const secret = "test-platform-secret";

async function request(path: string, method = "GET") {
  return spacesWorker.fetch(new Request(`https://spaces.naelao.com${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-1",
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-1"),
    },
    ...(method === "POST" ? { body: JSON.stringify({ period: "2026-07", revenue_cents: 1000 }) } : {}),
  }), {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: vi.fn() },
  } as never, execCtx);
}

describe("retired external business revenue-accounting API", () => {
  it.each([
    ["GET", "/spaces/space-1/revenue-tracking"],
    ["POST", "/spaces/space-1/revenue-tracking"],
    ["POST", "/spaces/space-1/revenue-tracking/mark-billed"],
    ["POST", "/spaces/space-1/revenue-tracking/mark-pending"],
  ])("does not expose %s %s", async (method, path) => {
    const response = await request(path, method);
    expect(response.status).toBe(404);
  });
});
