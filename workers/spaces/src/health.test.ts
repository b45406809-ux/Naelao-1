import { describe, expect, it } from "vitest";
import worker from "./index";

describe("spaces health endpoint", () => {
  it("reports service readiness without querying tenant data", async () => {
    const response = await worker.fetch(
      new Request("http://spaces/health"),
      {
        ENVIRONMENT: "test",
        PLATFORM_SECRET: "test",
      } as never,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "spaces",
      env: "test",
    });
  });
});
