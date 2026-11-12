import { describe, expect, it } from "vitest";
import worker from "./index";

describe("Marketplace health endpoint", () => {
  it("reports only its service and deployed environment", async () => {
    const response = await worker.fetch(new Request("https://marketplace/health"), {
      PLATFORM_SECRET: "test-secret", ENVIRONMENT: "staging",
    } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "marketplace", env: "staging" });
  });
});
