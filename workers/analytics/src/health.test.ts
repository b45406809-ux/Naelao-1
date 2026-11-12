import { describe, expect, it } from "vitest";
import worker from "./index";

describe("Analytics health endpoint", () => {
  it("reports only its service and deployed environment", async () => {
    const response = await worker.fetch!(new Request("https://analytics/health"), {
      PLATFORM_SECRET: "test-secret", CF_ACCOUNT_ID: "test-account", CF_ANALYTICS_API_TOKEN: "test-token", ENVIRONMENT: "staging",
    } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "analytics", env: "staging" });
  });
});
