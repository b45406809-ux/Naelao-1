import { describe, expect, it } from "vitest";
import worker from "./index";

describe("auth health endpoint", () => {
  it("reports service readiness without querying user data", async () => {
    const response = await worker.fetch(
      new Request("http://auth/health"),
      {
        ENVIRONMENT: "test",
        JWT_SECRET: "test",
        PLATFORM_SECRET: "test",
        PLATFORM_DB: {} as D1Database,
      },
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "auth",
      env: "test",
    });
  });
});
