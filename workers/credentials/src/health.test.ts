import { describe, expect, it } from "vitest";
import worker from "./index";

describe("Credentials health endpoint", () => {
  it("reports only its service and deployed environment", async () => {
    const response = await worker.fetch!(new Request("https://credentials/health"), {
      PLATFORM_SECRET: "test-secret", CREDENTIAL_ENCRYPTION_KEY: `v1:${"a".repeat(64)}`, ENVIRONMENT: "staging",
    } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "credentials", env: "staging" });
  });
});
