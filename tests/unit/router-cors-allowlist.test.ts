import { describe, it, expect } from "vitest";
import routerWorker from "../../workers/router/src/index.js";

// F11: cors(["*"]) echoed the caller's own Origin back for ANY origin, which combined with
// Bearer-JWT auth let any cross-origin page drive authenticated requests. The allowlist is now
// env-driven (CORS_ALLOWLIST) and read per-request, since a static cors(...) factory bakes its
// list in before c.env exists. Exercised against /health (unauthenticated) so this test is
// purely about the CORS layer, not JWT auth.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(allowlist: string) {
  return {
    ENVIRONMENT: "test",
    JWT_SECRET: "test-jwt-secret",
    PLATFORM_SECRET: "test-platform-secret",
    CORS_ALLOWLIST: allowlist,
  };
}

describe("router — CORS allowlist", () => {
  it("echoes Access-Control-Allow-Origin for an allowlisted origin", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/health", {
        headers: { origin: "https://dashboard.naelao.com" },
      }),
      makeEnv("https://dashboard.naelao.com,https://portal.naelao.com") as never,
      execCtx
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://dashboard.naelao.com");
  });

  it("does not set Access-Control-Allow-Origin for a non-allowlisted origin", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/health", {
        headers: { origin: "https://evil.example.com" },
      }),
      makeEnv("https://dashboard.naelao.com,https://portal.naelao.com") as never,
      execCtx
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("never echoes a literal '*' for a wildcard-configured allowlist entry mismatch", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/health", {
        headers: { origin: "https://evil.example.com" },
      }),
      makeEnv("https://dashboard.naelao.com") as never,
      execCtx
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("OPTIONS preflight for a non-allowlisted origin returns an empty Allow-Origin", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com" },
      }),
      makeEnv("https://dashboard.naelao.com") as never,
      execCtx
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("");
  });

  it("OPTIONS preflight for an allowlisted origin returns that origin", async () => {
    const res = await routerWorker.fetch(
      new Request("https://router.naelao.com/v1/spaces", {
        method: "OPTIONS",
        headers: { origin: "https://dashboard.naelao.com" },
      }),
      makeEnv("https://dashboard.naelao.com") as never,
      execCtx
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://dashboard.naelao.com");
  });
});
